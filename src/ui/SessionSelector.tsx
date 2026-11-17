import { useCallback, useEffect, useRef, useState } from 'react';
import type { Binding, Role, UiRequest } from '../contracts.js';
import { errorMessage, object, type NotesApi } from './view-model.js';

export interface SelectorSnapshot {
  sessionId: string;
  roles: Pick<Role, 'id' | 'name' | 'speakerName'>[];
  binding: Pick<Binding, 'roleId' | 'speakerName'> | null;
  locked: boolean;
  busy: boolean;
  needsRepair: boolean;
  error?: string;
  speakers: string[];
}
interface Choice { roleId: string; speakerName: string; newSpeaker: boolean }
interface Props { sessionId: string; api: NotesApi; openSession: (id: string) => void }

/** A poll begun before a save must never replace its acknowledged result. */
export class SelectorReadGuard {
  private version = 0;
  private sequence = 0;
  private accepted = 0;
  begin() { return { version: this.version, sequence: ++this.sequence }; }
  invalidate() { this.version++; this.accepted = 0; }
  accept(ticket: ReturnType<SelectorReadGuard['begin']>): boolean {
    if (ticket.version !== this.version || ticket.sequence < this.accepted) return false;
    this.accepted = ticket.sequence;
    return true;
  }
}

export function selectorSnapshot(value: unknown, sessionId: string): SelectorSnapshot {
  const state = object(value);
  if (state.sessionId !== sessionId || !Array.isArray(state.roles) || !Array.isArray(state.speakers)
    || typeof state.locked !== 'boolean' || typeof state.busy !== 'boolean'
    || (state.needsRepair !== undefined && typeof state.needsRepair !== 'boolean')
    || (state.error !== undefined && typeof state.error !== 'string'))
    throw new Error('宿主没有返回这个对话的角色设置，请更新插件并重试。');
  const roles = state.roles.map(value => {
    const role = object(value);
    if (typeof role.id !== 'string' || typeof role.name !== 'string' || typeof role.speakerName !== 'string')
      throw new Error('角色列表不完整，请重新连接。');
    return { id: role.id, name: role.name, speakerName: role.speakerName };
  });
  if (!state.speakers.every(name => typeof name === 'string'))
    throw new Error('说话者列表不完整，请重新连接。');
  let binding: SelectorSnapshot['binding'] = null;
  if (state.binding !== null) {
    const current = object(state.binding);
    if (typeof current.roleId !== 'string' || typeof current.speakerName !== 'string'
      || !roles.some(role => role.id === current.roleId))
      throw new Error('当前对话绑定的角色不可用，请检查角色设置。');
    binding = { roleId: current.roleId, speakerName: current.speakerName };
  }
  return {
    sessionId, roles, binding, locked: state.locked, busy: state.busy,
    needsRepair: state.needsRepair === true,
    ...(typeof state.error === 'string' ? { error: state.error } : {}),
    speakers: state.speakers as string[],
  };
}

/** Repair only the durable identity; a draft is for a different conversation. */
export function selectorRepairRequest(snapshot: SelectorSnapshot): UiRequest {
  return { action: 'bindSession', input: {
    sessionId: snapshot.sessionId,
    roleId: snapshot.binding?.roleId ?? null,
    speakerName: snapshot.binding?.speakerName ?? '',
  } };
}

export function selectorCanRepair(snapshot: SelectorSnapshot): boolean {
  return snapshot.needsRepair && !snapshot.busy;
}

export function selectorSpeakers(snapshot: SelectorSnapshot): string[] {
  return [...new Set([
    snapshot.binding?.speakerName ?? '', ...snapshot.speakers,
    ...snapshot.roles.map(role => role.speakerName),
  ].filter(name => name.trim()))];
}

export function SessionSelector(props: Props) {
  return <ConversationSelector key={props.sessionId} {...props} />;
}

function ConversationSelector({ api, sessionId, openSession }: Props) {
  const [snapshot, setSnapshot] = useState<SelectorSnapshot | null>(null);
  const [draft, setDraft] = useState<Choice>({ roleId: '', speakerName: '', newSpeaker: false });
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(false), pending = useRef(false), edited = useRef(false);
  const guard = useRef(new SelectorReadGuard());
  const accept = useCallback((next: SelectorSnapshot, reset: boolean) => {
    setSnapshot(next);
    if (reset || !edited.current) setDraft({
      roleId: next.binding?.roleId ?? '', speakerName: next.binding?.speakerName ?? '', newSpeaker: false,
    });
  }, []);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const ticket = guard.current.begin();
    try {
      const next = selectorSnapshot(await api({ action: 'sessionState', input: { sessionId } }), sessionId);
      if (alive.current && guard.current.accept(ticket)) { accept(next, false); setLoadError(''); }
    } catch (cause) {
      if (alive.current && guard.current.accept(ticket)) setLoadError(errorMessage(cause));
    }
  }, [api, sessionId, accept]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { alive.current = false; guard.current.invalidate(); clearInterval(timer); };
  }, [refresh]);

  const change = (next: Choice) => { edited.current = true; setDraft(next); setNotice(''); setError(''); };
  const commit = async (mode: 'apply' | 'new' | 'repair') => {
    const newSession = mode === 'new', repair = mode === 'repair';
    if (pending.current || !snapshot || loadError
      || (mode === 'apply' && (snapshot.busy || snapshot.locked || snapshot.needsRepair))
      || (repair && !selectorCanRepair(snapshot))) return;
    if (newSession && !draft.roleId) return;
    pending.current = true; guard.current.invalidate(); setSaving(true); setError(''); setNotice('');
    try {
      if (newSession) {
        const result = object(await api({ action: 'createSession', roleId: draft.roleId, input: {
          speakerName: draft.speakerName.trim(), sourceSessionId: sessionId,
        } }));
        if (typeof result.sessionId !== 'string') throw new Error('宿主没有返回新对话。');
        if (alive.current) openSession(result.sessionId);
      } else {
        const next = selectorSnapshot(await api(repair ? selectorRepairRequest(snapshot) : { action: 'bindSession', input: {
          sessionId, roleId: draft.roleId || null, speakerName: draft.speakerName.trim(),
        } }), sessionId);
        if (alive.current) {
          if (!repair) edited.current = false;
          accept(next, !repair);
          setNotice(next.needsRepair ? '身份仍待修复，请查看角色设置状态。'
            : repair ? '当前身份已修复。' : next.binding ? '双方身份已应用。' : '当前对话使用普通助手。');
        }
      }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally {
      guard.current.invalidate(); pending.current = false;
      if (alive.current) { setSaving(false); void refresh(); }
    }
  };
  const role = snapshot?.roles.find(role => role.id === snapshot.binding?.roleId);
  const validRole = !draft.roleId || snapshot?.roles.some(role => role.id === draft.roleId);
  const validName = !draft.roleId || !!draft.speakerName.trim();
  const changed = draft.roleId !== (snapshot?.binding?.roleId ?? '')
    || (!!draft.roleId && draft.speakerName.trim() !== snapshot?.binding?.speakerName);
  const disabled = saving || !!loadError || (!!snapshot?.busy && !snapshot.locked);
  const visibleError = error || loadError || snapshot?.error;

  return <div className="pn-session-selector" aria-label="对话角色与说话者" aria-busy={saving}>
    {!snapshot && !error && !loadError && <span role="status">正在连接角色设置…</span>}
    {snapshot?.locked ? <>
      <span className="pn-session-current" title="开聊后固定双方身份；其他对话可以选择不同人物。">
        {role ? `${role.name} · ${snapshot.binding!.speakerName}` : '普通助手'}
      </span>
      <details className="pn-session-new"><summary>另开对话</summary>
        <div className="pn-session-popup">
          <p>当前对话的双方身份已固定。</p>
          <ChoiceFields snapshot={snapshot} draft={draft} change={change} disabled={disabled} />
          {draft.roleId ? <button type="button" disabled={disabled || !validRole || !validName}
            onClick={() => void commit('new')}>以所选身份新建对话</button>
            : <p>普通助手请使用 DSH 的“新建会话”。</p>}
        </div>
      </details>
    </> : snapshot && <>
      <ChoiceFields snapshot={snapshot} draft={draft} change={change} disabled={disabled} />
      <button type="button" disabled={disabled || snapshot.needsRepair || !validRole || !validName || !changed}
        onClick={() => void commit('apply')}>{saving ? '正在应用…' : '应用到当前对话'}</button>
    </>}
    {snapshot?.needsRepair && <>
      <span role="status">当前身份需要修复。</span>
      <button type="button" disabled={saving || !selectorCanRepair(snapshot) || !!loadError}
        onClick={() => void commit('repair')}>修复当前身份</button>
    </>}
    {snapshot && !snapshot.roles.length && <span>还没有角色，请到“设置 → 蒲蒲笔记”创建或导入。</span>}
    {notice && <span role="status" className="pn-session-notice">{notice}</span>}
    {visibleError && <details className="pn-session-error"><summary>角色设置失败</summary>
      <div className="pn-session-popup" role="alert"><p>{visibleError}</p>
        <button type="button" disabled={saving} onClick={() => { setError(''); void refresh(); }}>重新连接</button></div>
    </details>}
  </div>;
}

function ChoiceFields({ snapshot, draft, change, disabled }: {
  snapshot: SelectorSnapshot; draft: Choice; change: (next: Choice) => void; disabled: boolean;
}) {
  const speakers = selectorSpeakers(snapshot);
  const selectedSpeaker = speakers.indexOf(draft.speakerName);
  return <>
    <label>角色<select aria-label="当前对话角色" disabled={disabled} value={draft.roleId}
      onChange={event => {
        const nextRole = snapshot.roles.find(role => role.id === event.target.value);
        change({ roleId: event.target.value, speakerName: draft.speakerName || nextRole?.speakerName || '', newSpeaker: draft.newSpeaker });
      }}>
      <option value="">普通助手</option>
      {snapshot.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
    </select></label>
    {draft.roleId && <label>说话者<select aria-label="当前说话者" disabled={disabled}
      value={draft.newSpeaker || selectedSpeaker < 0 ? 'new' : String(selectedSpeaker)}
      onChange={event => change(event.target.value === 'new'
        ? { ...draft, newSpeaker: true, speakerName: '' }
        : { ...draft, newSpeaker: false, speakerName: speakers[Number(event.target.value)]! })}>
      {speakers.map((name, index) => <option key={name} value={index}>{name}</option>)}
      <option value="new">新增说话者…</option>
    </select></label>}
    {draft.roleId && (draft.newSpeaker || selectedSpeaker < 0) && <label>姓名<input
      aria-label="新说话者姓名" placeholder="例如：小夫、知夏姐姐" maxLength={100} required
      disabled={disabled} value={draft.speakerName} onChange={event => change({ ...draft, newSpeaker: true, speakerName: event.target.value })} /></label>}
  </>;
}
