import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportPreview, JsonObject, Role, Task, TranscriptEntry, UiState } from '../contracts.js';
import { NoteWorkspace } from './NoteWorkspace.js';
import { displayTime, errorMessage, object, reasonLabel, statusLabel, type NotesApi } from './view-model.js';

interface Props { api: NotesApi; openSession: (id: string) => void; close: () => void }
type Page = 'notes' | 'roles' | 'tasks' | 'transfer';
const tabs: { id: Page; label: string }[] = [
  { id: 'notes', label: '笔记' }, { id: 'roles', label: '角色与对话' },
  { id: 'tasks', label: '整理任务' }, { id: 'transfer', label: '迁移与分享' },
];

export function Dashboard({ api, openSession, close }: Props) {
  const [snapshot, setSnapshot] = useState<UiState | null>(null);
  const [roleId, setRoleId] = useState('');
  const [page, setPage] = useState<Page>('notes');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRole = useRef(roleId);
  activeRole.current = roleId;
  const refresh = useCallback(async (selected = activeRole.current) => {
    const result = object(await api({ action: 'state', ...(selected ? { roleId: selected } : {}) })) as unknown as UiState;
    if (!Array.isArray(result.roles) || !Array.isArray(result.tasks)) throw new Error('笔记服务返回了不完整的状态。');
    if (activeRole.current && selected !== activeRole.current) return;
    setSnapshot(result);
    if (!activeRole.current && result.roles[0]) setRoleId(result.roles[0].id);
  }, [api]);
  useEffect(() => {
    let alive = true;
    void refresh(roleId).catch(cause => { if (alive) setError(errorMessage(cause)); });
    const timer = setInterval(() => { void refresh(roleId).catch(() => undefined); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [refresh, roleId]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); await refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const role = snapshot?.roles.find(item => item.id === roleId);

  return <main className="pn-root">
    <header className="pn-page-header">
      <div><h1>蒲蒲笔记</h1><p className="pn-muted">记忆是一页页笔记。角色按需查阅，自己整理。</p></div>
      <label className="pn-role-picker">当前角色<select value={roleId} onChange={event => {
        setRoleId(event.target.value); setError(''); setNotice('');
      }}><option value="" disabled>选择角色</option>
        {snapshot?.roles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </header>
    <nav className="pn-tabs" aria-label="笔记管理页面">
      {tabs.map(tab => <button key={tab.id} aria-current={page === tab.id ? 'page' : undefined}
        onClick={() => setPage(tab.id)}>{tab.label}</button>)}
    </nav>
    {error && <div role="alert" className="pn-alert">{error}<button onClick={() => void run(() => refresh())}>重试</button></div>}
    {snapshot?.error && <div role="alert" className="pn-alert">{snapshot.error}
      <button disabled={busy} onClick={() => void run(async () => {
        await api({ action: 'retry', input: { capture: true } });
        setNotice('已从 DSH 持久化记录重新同步对话。');
      })}>重新同步对话</button>
    </div>}
    {snapshot && typeof (snapshot as UiState & { waitingReason?: string }).waitingReason === 'string' &&
      <div role="status" className="pn-notice">{(snapshot as UiState & { waitingReason: string }).waitingReason}</div>}
    {role && snapshot?.stats.roleCardMissing === true && <div role="status" className="pn-notice">
      {role.name}的角色卡已删除，当前只使用姓名作为身份。
      <button disabled={busy} onClick={() => void run(async () => {
        await api({ action: 'notes', roleId: role.id, input: {
          action: 'create', path: role.roleCardPath, content: `# ${role.name}\n\n你是${role.name}。\n`,
        } });
        setNotice('角色卡已恢复。可以在笔记页继续补写设定，下一轮对话生效。');
      })}>恢复角色卡</button>
    </div>}
    {notice && <div role="status" className="pn-notice">{notice}</div>}
    {!snapshot && !error && <p role="status" className="pn-muted">正在连接笔记服务…</p>}
    {page === 'notes' && (role
      ? <NoteWorkspace key={role.id} roleId={role.id} roleCardPath={role.roleCardPath} api={api} />
      : snapshot && <div className="pn-empty"><h2>还没有角色</h2><p>先创建一个角色，或从旧记忆库复制导入。</p>
        <button onClick={() => setPage('roles')}>创建角色</button><button onClick={() => setPage('transfer')}>导入记忆</button></div>)}
    {page === 'roles' && <RolePage key={role?.id ?? 'new'} role={role} busy={busy} api={api}
      run={run} created={id => { setRoleId(id); setPage('notes'); }}
      enter={id => { openSession(id); close(); }} />}
    {page === 'tasks' && role && snapshot && <TaskPage key={role.id} roleId={role.id} tasks={snapshot.tasks} stats={snapshot.stats}
      api={api} busy={busy} run={run} notice={setNotice} />}
    {page === 'transfer' && <TransferPage key={roleId} role={role} api={api} run={run} busy={busy}
      imported={id => { setRoleId(id); setNotice('记忆已复制到新笔记库。旧插件和原始库保持不变。'); }} />}
    <footer className="pn-footer">只有角色卡和双方姓名固定进入对话。整理随 DSH 压缩信号触发；每日 03:00 后在宿主运行期间补做通读。</footer>
  </main>;
}

function RolePage({ role, busy, api, run, created, enter }: {
  role?: Role; busy: boolean; api: NotesApi;
  run: (operation: () => Promise<void>) => Promise<void>;
  created: (id: string) => void; enter: (id: string) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [speaker, setSpeaker] = useState(role?.speakerName ?? '');
  const [persona, setPersona] = useState('');
  const [newName, setNewName] = useState('');
  const [newSpeaker, setNewSpeaker] = useState('');
  const [provider, setProvider] = useState(role?.memoryModel?.provider ?? '');
  const [model, setModel] = useState(role?.memoryModel?.model ?? '');
  const [customModel, setCustomModel] = useState(Boolean(role?.memoryModel));
  return <div className="pn-page-body">
    {role && <section className="pn-section">
      <h2>{role.name}的对话</h2>
      <p>每次从这里新建对话，固定这一位角色和当次说话者。其他会话不受影响。</p>
      <form onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = object(await api({ action: 'createSession', roleId: role.id, input: { speakerName: speaker } }));
        if (typeof result.sessionId !== 'string') throw new Error('宿主没有返回新对话。');
        enter(result.sessionId);
      }); }} className="pn-row-form">
        <label>这次是谁在说话<input required value={speaker} onChange={event => setSpeaker(event.target.value)} placeholder="例如：小夫、知夏姐姐" /></label>
        <button type="submit" className="pn-primary" disabled={busy}>与{role.name}开始新对话</button>
      </form>
      <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        await api({ action: 'updateRole', roleId: role.id, input: { name, speakerName: speaker } });
      }); }}>
        <h3>角色信息</h3>
        <label>角色姓名<input required value={name} onChange={event => setName(event.target.value)} /></label>
        <p className="pn-muted">人设正文在“笔记”中的 {role.roleCardPath} 修改；下一轮生效。</p>
        <button type="submit" disabled={busy}>保存姓名和默认说话者</button>
      </form>
      <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        await api({ action: 'updateRole', roleId: role.id, input: {
          memoryModel: customModel ? { provider, model } : null,
        } });
      }); }}>
        <h3>整理模型</h3>
        <label className="pn-check"><input type="checkbox" checked={customModel} onChange={event => setCustomModel(event.target.checked)} />单独指定整理模型</label>
        {customModel ? <div className="pn-row-form">
          <label>Provider<input required value={provider} onChange={event => setProvider(event.target.value)} /></label>
          <label>模型名称<input required value={model} onChange={event => setModel(event.target.value)} /></label>
        </div> : <p className="pn-muted">沿用{role.name}最近一次 DSH 对话的模型{role.lastModel ? `：${role.lastModel.provider} / ${role.lastModel.model}` : '。第一次聊天后即可使用。'}</p>}
        <p className="pn-muted">只填写 DSH 已配置的 Provider 和模型名称。密钥由 DSH 保管。</p>
        <button type="submit" disabled={busy}>保存模型选择</button>
      </form>
    </section>}
    <section className="pn-section"><h2>创建新角色</h2>
      <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = object(await api({ action: 'createRole', input: { name: newName, speakerName: newSpeaker, persona } }));
        const createdRole = typeof result.id === 'string' ? result : object(result.role);
        created(createdRole.id as string);
      }); }}>
        <div className="pn-row-form"><label>角色姓名<input required value={newName} onChange={event => setNewName(event.target.value)} /></label>
          <label>默认说话者姓名<input required value={newSpeaker} onChange={event => setNewSpeaker(event.target.value)} placeholder="例如：小夫" /></label></div>
        <label>角色设定<textarea value={persona} onChange={event => setPersona(event.target.value)} rows={7} placeholder="用自然语言写性格、经历、关系和说话习惯；之后可以随时编辑角色卡。" /></label>
        <button type="submit" disabled={busy || !newName.trim() || !newSpeaker.trim()}>创建角色和笔记库</button>
      </form>
    </section>
  </div>;
}

function TaskPage({ roleId, tasks, stats, api, busy, run, notice }: {
  roleId: string; tasks: Task[]; stats: JsonObject; api: NotesApi; busy: boolean;
  run: (operation: () => Promise<void>) => Promise<void>; notice: (text: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [trajectory, setTrajectory] = useState<TranscriptEntry[]>([]);
  const pending = stats.unprocessedMessages ?? stats.unprocessedDialogues ?? stats.pendingMessages ?? stats.pendingDialogues;
  const inspect = async (task: Task) => {
    const result = object(await api({ action: 'state', roleId, input: { taskId: task.id } }));
    setSelected(task.id); setTrajectory((result.taskTranscript ?? []) as TranscriptEntry[]);
  };
  return <div className="pn-page-body">
    <section className="pn-section">
      <div className="pn-heading-row"><div><h2>对话与通读</h2>
        <p className="pn-muted">{typeof pending === 'number' ? `还有 ${pending} 条对话未整理。` : '原始对话持续保存，长期笔记等待整理。'}</p></div>
        <button disabled={busy} className="pn-primary" onClick={() => void run(async () => {
          const result = object(await api({ action: 'manual', roleId }));
          notice(typeof result.message === 'string' ? result.message
            : result.status === 'completed' ? '没有新的对话需要整理。' : '已登记整理任务。长期笔记尚未更新。');
        })}>整理未处理对话</button>
      </div>
      <p>压缩和笔记整理独立运行。任务排队或失败时，已记录的对话仍会保留。</p>
      {tasks.some(task => task.status === 'failed' || task.status === 'stopped') && <div className="pn-notice">
        前面的失败或停止任务会阻挡同角色后续任务。重试后会从已保存的进度继续。
      </div>}
      <div className="pn-task-list">
        {tasks.map(task => <article key={task.id} className="pn-task">
          <div className="pn-heading-row"><h3>{reasonLabel(task.reason)}</h3><span className={`pn-status pn-status-${task.status}`}>{statusLabel(task.status)}</span></div>
          <p className="pn-muted">{displayTime(task.createdAt)} · 对话范围 {Math.max(0, task.upperBound - task.lowerBound)} 条</p>
          <Progress progress={task.progress} />
          {task.error && <p className="pn-task-error">{task.error}</p>}
          <div className="pn-actions">
            <button disabled={busy} onClick={() => void run(() => inspect(task))}>查看读写轨迹</button>
            {(task.status === 'failed' || task.status === 'stopped') && <button disabled={busy}
              onClick={() => void run(async () => { await api({ action: 'retry', roleId, input: { taskId: task.id } }); })}>重试</button>}
            {(task.status === 'running' || task.status === 'queued') && <button disabled={busy}
              onClick={() => void run(async () => { await api({ action: 'stop', roleId, input: { taskId: task.id } }); })}>停止</button>}
          </div>
          {selected === task.id && <section className="pn-trajectory" aria-label="任务读写轨迹">
            <p className="pn-muted">显示请求、可见输出和工具结果，不展示思考过程。</p>
            {trajectory.map((entry, index) => <details key={index}><summary>{entry.kind === 'tool' ? '工具操作' : entry.kind === 'error' ? '错误' : entry.kind === 'request' ? '模型请求' : '可见回复'} · {displayTime(entry.at)}</summary>
              <pre>{JSON.stringify(entry.payload, null, 2)}</pre></details>)}
            {!trajectory.length && <p>这个任务还没有模型读写记录。</p>}
          </section>}
        </article>)}
        {!tasks.length && <p className="pn-muted">还没有整理任务。</p>}
      </div>
    </section>
  </div>;
}

function Progress({ progress }: { progress: JsonObject }) {
  const labels: Record<string, string> = {
    sourceRead: '已读对话', total: '总数', sourcesRead: '已读对话', sourceTotal: '对话总数',
    filesRead: '已读笔记', filesTotal: '笔记总数', turns: '模型轮次',
    coverage: '通读覆盖', readCount: '已读数量', phase: '阶段', message: '进度',
    sourceMessages: '对话总数', readMessages: '已读对话', readFiles: '已读笔记',
    files: '起始笔记数', unreadPaths: '尚未通读', manifestInitialized: '已建立通读清单',
  };
  return <dl className="pn-progress">{Object.entries(progress).map(([key, value]) => <div key={key}>
    <dt>{labels[key] ?? key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
  </div>)}</dl>;
}

function TransferPage({ role, api, run, busy, imported }: {
  role?: Role; api: NotesApi; busy: boolean; run: (operation: () => Promise<void>) => Promise<void>;
  imported: (id: string) => void;
}) {
  const [sourcePath, setSourcePath] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [name, setName] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [kind, setKind] = useState<'seed' | 'full'>('seed');
  const [destination, setDestination] = useState('');
  const [paths, setPaths] = useState('');
  const [includeSources, setIncludeSources] = useState(false);
  const [exported, setExported] = useState('');
  return <div className="pn-page-body">
    <section className="pn-section"><h2>复制导入</h2>
      <p>读取旧 SQLite 库、旧版 .pupumem 或蒲蒲笔记数据包。先预检，确认后才创建新角色库。</p>
      <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = object(await api({ action: 'previewImport', input: { path: sourcePath } })) as unknown as ImportPreview;
        setPreview(result); setName(result.name); setSpeaker('');
        setMapping(Object.fromEntries(result.people.map(person => [person.key, person.name]))); setConfirmed(false);
      }); }}>
        <label>本机文件路径<input required value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="D:\记忆备份\璐璐.pupumem" /></label>
        <button type="submit" disabled={busy}>预检记忆包</button>
      </form>
      {preview && <div className="pn-import-preview"><h3>导入预览</h3>
        <dl className="pn-progress">{Object.entries(preview.counts).map(([key, count]) => <div key={key}><dt>{key}</dt><dd>{count}</dd></div>)}</dl>
        {preview.warnings.map((warning, index) => <p className="pn-notice" key={index}>{warning}</p>)}
        <details><summary>将生成的笔记路径（{preview.proposedPaths.length}）</summary><ul>{preview.proposedPaths.map(path => <li key={path}>{path}</li>)}</ul></details>
        <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          const result = object(await api({ action: 'confirmImport', input: {
            token: preview.token, name, speakerName: speaker, personMapping: mapping, confirmed,
          } }));
          const newRole = typeof result.id === 'string' ? result : object(result.role);
          imported(newRole.id as string); setPreview(null);
        }); }}>
          <div className="pn-row-form"><label>新角色姓名<input required value={name} onChange={event => setName(event.target.value)} /></label>
            <label>当前说话者姓名<input required value={speaker} onChange={event => setSpeaker(event.target.value)} placeholder="例如：小夫" /></label></div>
          <fieldset><legend>明确映射原人物</legend><p className="pn-muted">同名人物分别列出。根据你认识的人确认对应关系，不会凭昵称自动合并。</p>
            {preview.people.map((person, index) => <label key={person.key}>{person.name}（原人物 {index + 1}）
              <input required value={mapping[person.key] ?? ''} onChange={event => setMapping(previous => ({ ...previous, [person.key]: event.target.value }))} />
              {speaker && <button type="button" onClick={() => setMapping(previous => ({ ...previous, [person.key]: speaker }))}>对应{speaker}</button>}
            </label>)}
          </fieldset>
          <label className="pn-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对角色和人物映射，确认复制导入</label>
          <button type="submit" disabled={busy || !confirmed || !name.trim() || !speaker.trim()} className="pn-primary">确认导入到新笔记库</button>
        </form>
      </div>}
    </section>
    {role && <section className="pn-section"><h2>导出{role.name}的笔记</h2>
      <form className="pn-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = object(await api({ action: 'export', roleId: role.id, input: {
          kind, destination, ...(paths.trim() ? { paths: paths.split('\n').map(path => path.trim()).filter(Boolean) } : {}),
          includeSources,
        } }));
        setExported(typeof result.path === 'string' ? result.path : destination);
      }); }}>
        <label>数据包类型<select value={kind} onChange={event => setKind(event.target.value as 'seed' | 'full')}>
          <option value="seed">精选种子包 · 默认只有当前笔记</option><option value="full">完整迁移包 · 含对话、证据和版本历史</option>
        </select></label>
        <label>导出到本机路径<input required value={destination} onChange={event => setDestination(event.target.value)} placeholder="D:\记忆备份\璐璐.pupunotes" /></label>
        {kind === 'seed' && <>
          <label>选择笔记路径（每行一个，留空导出当前全部笔记）<textarea rows={4} value={paths} onChange={event => setPaths(event.target.value)} placeholder={'角色.md\n人物/小夫.md'} /></label>
          <label className="pn-check"><input type="checkbox" checked={includeSources} onChange={event => setIncludeSources(event.target.checked)} />同时包含原始来源资料</label>
        </>}
        <p className="pn-muted">凭据、运行中的任务和缓存不会放入数据包。分享前请检查笔记内容。</p>
        <button type="submit" disabled={busy}>导出数据包</button>
        {exported && <p role="status">已导出到 {exported}</p>}
      </form>
    </section>}
  </div>;
}
