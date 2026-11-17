import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, rmdirSync, writeFileSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class NotesError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NotesError'; }
}
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const timestamp = (): string => new Date().toISOString();
export interface FileSnapshot { path: string; content: string | null }
export interface FileChange { path: string; before: string | null; after: string | null }
export interface FilePlan {
  changes: FileChange[];
  createDirectories: string[];
  deleteDirectories: string[];
  roleCard?: string;
  aliases?: { from: string; to: string }[];
  directoryReads?: { path: string; revision: string }[];
}

/** Reject symlinks and Windows junctions at every traversed component. */
export class NotesFiles {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new NotesError('PATH_ESCAPE', '笔记目录不能是链接。');
    this.root = realpathSync(root);
  }
  normalize(value = ''): string {
    if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value) ||
      /^[A-Za-z]:/.test(value) || value.startsWith('\\') || value.includes(':'))
      throw new NotesError('INVALID_PATH', '请使用笔记目录内的相对路径。');
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
    const parts = normalized ? normalized.split('/') : [];
    if (parts.some(x => !x || x === '.' || x === '..' || /[<>:"|?*\x00-\x1f]/.test(x) ||
      /[ .]$/.test(x) || x.startsWith('.pupu-write-') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)))
      throw new NotesError('INVALID_PATH', '笔记路径含有不允许的名称。');
    return normalized;
  }
  absolute(value = ''): string {
    const path = this.normalize(value);
    const absolute = resolve(this.root, ...path.split('/').filter(Boolean));
    const rel = relative(this.root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new NotesError('PATH_ESCAPE', '路径超出当前角色的笔记目录。');
    let current = this.root;
    const components = path.split('/').filter(Boolean);
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new NotesError('PATH_ESCAPE', '笔记路径不能经过链接或目录联接。');
        if (index < components.length - 1 && !stat.isDirectory())
          throw new NotesError('INVALID_PATH', '笔记父路径必须是目录。');
        const actual = realpathSync(current);
        const actualRel = relative(this.root, actual);
        if (actualRel === '..' || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel))
          throw new NotesError('PATH_ESCAPE', '路径超出当前角色的笔记目录。');
      }
    }
    return absolute;
  }
  kind(path = ''): 'file' | 'directory' | null {
    const absolute = this.absolute(path);
    if (!existsSync(absolute)) return null;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    throw new NotesError('INVALID_FILE', '仅支持普通文本文件和目录。');
  }
  read(path: string): string {
    if (this.kind(path) !== 'file') throw new NotesError('NOT_FOUND', '找不到这个笔记文件。');
    return readFileSync(this.absolute(path), 'utf8');
  }
  maybeRead(path: string): string | null { return this.kind(path) === 'file' ? this.read(path) : null; }
  list(path = ''): { path: string; kind: 'file' | 'directory' }[] {
    if (this.kind(path) !== 'directory') throw new NotesError('NOT_FOUND', '找不到这个笔记目录。');
    return readdirSync(this.absolute(path), { withFileTypes: true }).filter(entry => !/^\.pupu-write-[0-9a-f-]+\.tmp$/.test(entry.name))
      .map(entry => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const kind = this.kind(child);
        if (!kind) throw new NotesError('NOT_FOUND', '目录项已变化，请重试。');
        return { path: child, kind };
      }).sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  }
  walk(path = ''): FileSnapshot[] {
    const kind = this.kind(path);
    if (kind === 'file') return [{ path, content: this.read(path) }];
    if (kind === null) return [];
    return this.list(path).flatMap(entry => this.walk(entry.path));
  }
  /** Plans are journaled before this function. Applying twice has the same result. */
  apply(plan: FilePlan): void {
    for (const change of plan.changes) {
      const current = this.maybeRead(change.path);
      if (current !== change.before && current !== change.after)
        throw new NotesError('RECOVERY_CONFLICT', `文件已在操作之外发生变化：${change.path}`);
    }
    for (const directory of plan.createDirectories) mkdirSync(this.absolute(directory), { recursive: true });
    for (const change of plan.changes.filter(item => item.after !== null)) {
      const absolute = this.absolute(change.path);
      mkdirSync(dirname(absolute), { recursive: true });
      const temporary = join(this.root, `.pupu-write-${randomUUID()}.tmp`);
      const fd = openSync(temporary, 'wx');
      try { writeFileSync(fd, change.after!, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temporary, absolute); } catch (error) { rmSync(temporary, { force: true }); throw error; }
    }
    for (const change of plan.changes.filter(item => item.after === null)) rmSync(this.absolute(change.path), { force: true });
    for (const directory of [...plan.deleteDirectories].sort((a, b) => b.length - a.length)) {
      const absolute = this.absolute(directory);
      if (existsSync(absolute)) {
        // Remove only verified, now-empty directories. Never recurse through links.
        if (this.kind(directory) !== 'directory' || readdirSync(absolute).length)
          throw new NotesError('DIRECTORY_CHANGED', `目录仍有内容，请重新检查：${directory}`);
        rmdirSync(absolute);
      }
    }
  }
  directories(path: string): string[] {
    if (this.kind(path) !== 'directory') return [];
    return [path, ...this.list(path).filter(x => x.kind === 'directory').flatMap(x => this.directories(x.path))];
  }
}

/** Update ordinary inline and reference-style Markdown links; leave external URLs and code untouched. */
export function rewriteLinks(content: string, originalPath: string, finalPath: string,
  moved: Map<string, string>): string {
  const rewrite = (target: string): string => {
    const bracketed = target.startsWith('<') && target.endsWith('>');
    const raw = bracketed ? target.slice(1, -1) : target;
    if (/^[a-z][a-z0-9+.-]*:|^[/#\\]/i.test(raw)) return target;
    const hashIndex = raw.indexOf('#');
    const pathPart = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
    const hash = hashIndex < 0 ? '' : raw.slice(hashIndex);
    let decoded: string;
    try { decoded = decodeURIComponent(pathPart); } catch { return target; }
    const absolute = posix.normalize(posix.join(posix.dirname(originalPath), decoded));
    const destination = moved.get(absolute) ?? absolute;
    let next = posix.relative(posix.dirname(finalPath), destination);
    if (!next) next = posix.basename(destination);
    if (destination === absolute && originalPath === finalPath) return target;
    next = next.replaceAll(' ', '%20') + (decoded.endsWith('/') && !next.endsWith('/') ? '/' : '') + hash;
    return bracketed ? `<${next}>` : next;
  };
  let inFence = false;
  return content.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    // Keep code spans literal; links outside them remain recognized.
    return line.split(/(`+[^`]*`+)/g).map((part, index) => {
      if (index % 2) return part;
      return part.replace(/(\]\()(<[^>]+>|[^\s)]+)([^)]*\))/g,
        (_all, prefix: string, target: string, suffix: string) => `${prefix}${rewrite(target)}${suffix}`)
        .replace(/^(\s*\[[^\]]+\]:\s*)(<[^>]+>|\S+)(.*)$/,
          (_all, prefix: string, target: string, suffix: string) => `${prefix}${rewrite(target)}${suffix}`);
    }).join('');
  }).join('\n');
}
