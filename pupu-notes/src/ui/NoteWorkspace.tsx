import { useCallback, useEffect, useRef, useState } from 'react';
import type { Version } from '../contracts.js';
import { Markdown } from './Markdown.js';
import {
  basename, displayTime, errorMessage, object, parentPath, readDocument,
  type DocumentSnapshot, type NoteEntry, type NotesApi, type SearchMatch,
} from './view-model.js';

export function NoteWorkspace({ roleId, roleCardPath, api }: {
  roleId: string; roleCardPath: string; api: NotesApi;
}) {
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [searchNext, setSearchNext] = useState<number | null>(null);
  const [doc, setDoc] = useState<DocumentSnapshot | null>(null);
  const [path, setPath] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [aux, setAux] = useState<'history' | 'sources' | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  const [sources, setSources] = useState<unknown>(null);
  const [createPath, setCreatePath] = useState('');
  const [createKind, setCreateKind] = useState<'file' | 'directory'>('file');
  const [showCreate, setShowCreate] = useState(false);
  const [movePath, setMovePath] = useState('');
  const [showMove, setShowMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const listDirectory = useCallback(async (target: string, offset = 0) => {
    const result = object(await api({ action: 'notes', roleId, input: {
      action: 'view', path: target, offset, limit: 100,
    } }));
    if (result.kind !== 'directory' || !Array.isArray(result.entries)) throw new Error('目录读取失败。');
    setEntries(previous => offset ? [...previous, ...result.entries as NoteEntry[]] : result.entries as NoteEntry[]);
    setDirectory(target);
    setNextOffset(typeof result.nextOffset === 'number' ? result.nextOffset : null);
  }, [api, roleId]);
  const open = useCallback(async (target: string) => {
    const request = ++generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = object(await api({ action: 'notes', roleId, input: { action: 'view', path: target, lineCount: 200 } }));
      if (request !== generation.current) return;
      if (result.kind === 'directory') {
        await listDirectory(target);
        return;
      }
      const snapshot = await readDocument(api, roleId, target);
      if (request !== generation.current) return;
      setPath(target); setDoc(snapshot); setDraft(snapshot.content);
      setEditing(false); setAux(null); setSelectedVersion(null); setShowMove(false);
    } catch (cause) {
      if (request === generation.current) setError(errorMessage(cause));
    } finally { if (request === generation.current) setBusy(false); }
  }, [api, roleId, listDirectory]);
  useEffect(() => {
    generation.current++;
    setDirectory(''); setEntries([]); setDoc(null); setPath(''); setMatches(null);
    setQuery(''); setAux(null); setError(''); setMessage(''); setEditing(false);
    void listDirectory('').catch(cause => setError(errorMessage(cause)));
    return () => { generation.current++; };
  }, [listDirectory]);
  const search = async (offset = 0) => {
    const result = object(await api({ action: 'notes', roleId, input: {
      action: 'search', query, path: directory, offset, limit: 50,
    } }));
    setMatches(previous => offset && previous ? [...previous, ...result.matches as SearchMatch[]] : result.matches as SearchMatch[]);
    setSearchNext(typeof result.nextOffset === 'number' ? result.nextOffset : null);
  };
  const history = async () => {
    const result = await api({ action: 'versions', roleId, input: { path } });
    setVersions((Array.isArray(result) ? result : object(result).versions) as Version[]);
    setSelectedVersion(null); setAux('history');
  };
  const loadSources = async (offset = 0) => {
    const result = object(await api({ action: 'notes', roleId, input: { action: 'sources', path, offset, limit: 30 } }));
    setSources((previous: unknown) => {
      const earlier = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
      return offset ? { ...result, sources: [
        ...(Array.isArray(earlier.sources) ? earlier.sources : []),
        ...(Array.isArray(result.sources) ? result.sources : []),
      ] } : result;
    });
    setAux('sources');
  };

  return <div className="pn-notebooks">
    <aside className="pn-explorer" aria-label="笔记目录">
      <div className="pn-explorer-head">
        <h2>笔记</h2>
        <button disabled={busy} onClick={() => { setShowCreate(!showCreate); setCreatePath(directory ? `${directory}/` : ''); }}>新建</button>
      </div>
      <button className="pn-pinned" onClick={() => void open(roleCardPath)}>角色卡 · {roleCardPath}</button>
      <form className="pn-search" onSubmit={event => { event.preventDefault(); void run(() => search()); }}>
        <label className="pn-visually-hidden" htmlFor="pn-search">搜索笔记内容或名称</label>
        <input id="pn-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或原文" />
        <button disabled={busy || !query.trim()} type="submit">搜索</button>
      </form>
      {matches && <button className="pn-text-link" onClick={() => setMatches(null)}>返回目录</button>}
      <nav className="pn-breadcrumb" aria-label="目录位置">
        <button onClick={() => void run(() => listDirectory(''))}>全部</button>
        {directory.split('/').filter(Boolean).map((part, index, parts) => <span key={index}>
          / <button onClick={() => void run(() => listDirectory(parts.slice(0, index + 1).join('/')))}>{part}</button>
        </span>)}
      </nav>
      {showCreate && <form className="pn-inline-form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          await api({ action: 'notes', roleId, input: {
            action: 'create', path: createPath, kind: createKind,
            ...(createKind === 'file' ? { content: '' } : {}),
          } });
          setShowCreate(false); await listDirectory(parentPath(createPath));
          if (createKind === 'file') await open(createPath);
        });
      }}>
        <label>相对路径<input required value={createPath} onChange={event => setCreatePath(event.target.value)} placeholder="人物/新的笔记.md" /></label>
        <label>类型<select value={createKind} onChange={event => setCreateKind(event.target.value as 'file' | 'directory')}>
          <option value="file">笔记文件</option><option value="directory">目录</option>
        </select></label>
        <button disabled={busy} type="submit">创建</button>
      </form>}
      <nav className="pn-tree" aria-label={matches ? '搜索结果' : '目录内容'}>
        {matches ? <>
          {matches.map((match, index) => <button key={`${match.path}:${index}`} onClick={() => void open(match.path)}>
            <strong>{match.path}</strong><small>第 {match.line} 行 · {match.snippet}</small>
          </button>)}
          {!matches.length && <p className="pn-muted">没有找到。可以换一个词，或从目录浏览。</p>}
          {searchNext !== null && <button onClick={() => void run(() => search(searchNext))}>更多结果</button>}
        </> : <>
          {directory && <button onClick={() => void run(() => listDirectory(parentPath(directory)))}>↑ 上一级</button>}
          {entries.map(entry => <button key={entry.path}
            aria-current={entry.path === path ? 'page' : undefined}
            onClick={() => entry.kind === 'directory' ? void run(() => listDirectory(entry.path)) : void open(entry.path)}>
            <span aria-hidden="true">{entry.kind === 'directory' ? '▸' : '·'}</span> {basename(entry.path)}
          </button>)}
          {!entries.length && <p className="pn-muted">这个目录还没有笔记。</p>}
          {nextOffset !== null && <button onClick={() => void run(() => listDirectory(directory, nextOffset))}>载入更多</button>}
        </>}
      </nav>
    </aside>
    <section className="pn-note-panel" aria-label="笔记内容">
      {error && <div className="pn-alert" role="alert">{error}</div>}
      {message && <div className="pn-notice" role="status">{message}</div>}
      {busy && <p className="pn-muted" role="status">正在处理…</p>}
      {!path ? <div className="pn-empty"><h2>从一页笔记开始</h2><p>打开角色卡修改人设，或从左侧目录查阅记忆。</p><p className="pn-muted">聊天时，角色会按需调用笔记工具寻找细节。</p></div> : <>
        <div className="pn-note-toolbar"><h2>{path}</h2><div className="pn-actions">
          <button disabled={busy || !doc} onClick={() => { setEditing(!editing); setAux(null); }}> {editing ? '预览' : '编辑'}</button>
          <button disabled={busy} onClick={() => void run(history)}>版本</button>
          <button disabled={busy} onClick={() => void run(() => loadSources())}>来源</button>
          <button disabled={busy || !doc} onClick={() => { setMovePath(path); setShowMove(!showMove); }}>移动</button>
          <button className="pn-danger" disabled={busy || !doc} onClick={() => void run(async () => {
            await api({ action: 'notes', roleId, input: { action: 'delete', path, revision: doc!.revision } });
            setDoc(null); setMessage('笔记已删除。可以从版本记录恢复。'); await listDirectory(directory);
          })}>删除</button>
        </div></div>
        {showMove && <form className="pn-inline-form" onSubmit={event => {
          event.preventDefault(); void run(async () => {
            await api({ action: 'notes', roleId, input: { action: 'move', path, to: movePath, revision: doc!.revision } });
            await listDirectory(parentPath(movePath)); await open(movePath);
          });
        }}><label>移动到<input required value={movePath} onChange={event => setMovePath(event.target.value)} /></label>
          <button type="submit" disabled={busy}>确认移动</button>
        </form>}
        {aux === 'sources' ? <section className="pn-aux"><h3>这页笔记的来源</h3>
          <p className="pn-muted">这里记录整理时读过的资料；不代表每一句改写都有逐句证据。</p>
          <pre>{JSON.stringify(sources, null, 2)}</pre>
          {Boolean(sources) && typeof sources === 'object' && typeof (sources as Record<string, unknown>).nextOffset === 'number' &&
            <button disabled={busy} onClick={() => void run(() => loadSources((sources as { nextOffset: number }).nextOffset))}>载入更多来源</button>}
          <button onClick={() => setAux(null)}>返回笔记</button>
        </section> : aux === 'history' ? <section className="pn-aux"><h3>版本记录</h3>
          <div className="pn-version-layout"><div className="pn-version-list">
            {versions.map(version => <button key={version.id} onClick={() => setSelectedVersion(version)}>
              {displayTime(version.at)}<small>{version.operation}{version.content === null ? ' · 删除' : ''}</small>
            </button>)}
            {!versions.length && <p className="pn-muted">还没有历史版本。</p>}
          </div>{selectedVersion && <div className="pn-version-diff">
            <div><h4>所选版本</h4><pre>{selectedVersion.content ?? '（此版本中不存在）'}</pre></div>
            <div><h4>当前内容</h4><pre>{doc?.content ?? '（已删除）'}</pre></div>
            <button disabled={busy} onClick={() => void run(async () => {
              await api({ action: 'undo', roleId, input: { versionId: selectedVersion.id } });
              await listDirectory(directory); await open(path);
            })}>恢复这个版本</button>
          </div>}</div><button onClick={() => setAux(null)}>返回笔记</button>
        </section> : doc && (editing ? <>
          <label className="pn-visually-hidden" htmlFor="pn-note-editor">编辑 {path}</label>
          <textarea id="pn-note-editor" className="pn-note-editor" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} />
          <div className="pn-save-row"><span className="pn-muted">整页内容已载入。保存会检查打开后是否有其他修改。</span>
            <button className="pn-primary" disabled={busy || draft === doc.content} onClick={() => void run(async () => {
              await api({ action: 'notes', roleId, input: {
                action: 'edit', path, oldText: doc.content, newText: draft, revision: doc.revision,
              } });
              await open(path); setMessage('笔记已保存。角色卡的改动会在下一轮对话生效。');
            })}>保存笔记</button></div>
        </> : <Markdown text={doc.content} path={path} open={target => void open(target)} />)}
      </>}
    </section>
  </div>;
}
