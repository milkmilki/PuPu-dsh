import type { JsonObject, NotesCommand, UiRequest } from '../contracts.js';

export type NotesApi = (request: UiRequest) => Promise<unknown>;
export interface NoteEntry { path: string; kind: 'file' | 'directory' }
export interface SearchMatch { path: string; line: number; snippet: string }
export interface DocumentSnapshot { path: string; content: string; revision: string }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('宿主返回了无法识别的数据。');
  return value as Record<string, unknown>;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? '全部笔记';
}
export function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}
export function jsonInput(command: NotesCommand): JsonObject {
  return Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined)) as JsonObject;
}

/** Assemble every explicit page before offering a whole-note editor. */
export async function readDocument(
  api: NotesApi, roleId: string, path: string,
): Promise<DocumentSnapshot> {
  const pages: string[] = [];
  let startLine = 1;
  let revision: string | undefined;
  for (;;) {
    const page = object(await api({ action: 'notes', roleId, input: {
      action: 'view', path, startLine, lineCount: 200,
    } }));
    if (page.kind !== 'file' || typeof page.content !== 'string' || typeof page.revision !== 'string')
      throw new Error('这不是可编辑的笔记文件。');
    if (revision !== undefined && revision !== page.revision)
      throw new Error('读取期间笔记发生了变化，请重新打开。');
    revision = page.revision;
    pages.push(page.content);
    const next = page.nextStartLine;
    if (next === null || next === undefined) return { path, content: pages.join('\n'), revision };
    if (typeof next !== 'number' || !Number.isInteger(next) || next <= startLine)
      throw new Error('笔记分页没有前进，已停止读取。');
    startLine = next;
  }
}

/** Only local Markdown paths and web links are navigable in the reader. */
export function markdownLink(
  href: string, currentPath: string,
): { kind: 'web' | 'note'; target: string } | null {
  if (/^https?:\/\//i.test(href)) return { kind: 'web', target: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\')) return null;
  const withoutFragment = href.split('#')[0]!.split('?')[0]!;
  let decoded: string;
  try { decoded = decodeURIComponent(withoutFragment); } catch { return null; }
  const parts = parentPath(currentPath).split('/').filter(Boolean);
  for (const component of decoded.split('/')) {
    if (component === '..') { if (!parts.length) return null; parts.pop(); }
    else if (component && component !== '.') parts.push(component);
  }
  if (!decoded.endsWith('/') && !parts.join('/').toLowerCase().endsWith('.md')) return null;
  return { kind: 'note', target: parts.join('/') };
}

const statusLabels: Record<string, string> = {
  queued: '排队中', running: '整理中', failed: '失败', stopped: '已停止', completed: '已完成',
};
const reasonLabels: Record<string, string> = {
  manual: '手动整理', compaction: 'DSH 压缩信号', daily: '每日通读', import: '导入后整理',
};
export const statusLabel = (value: string): string => statusLabels[value] ?? value;
export const reasonLabel = (value: string): string => reasonLabels[value] ?? value;

export function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
