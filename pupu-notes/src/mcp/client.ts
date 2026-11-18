import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import type { AdminMethod, EngineClient, JsonObject, NotesCommand, OperationContext, Role } from '../contracts.js';

export async function connectEngine(root: string, roleName: string,
  entry = fileURLToPath(new URL('./mcp.mjs', import.meta.url)),
  onClosed?: () => void): Promise<EngineClient> {
  const client = new Client({ name: 'pupu-notes-host', version: '0.1.0' });
  let closed = false;
  client.onclose = () => { closed = true; onClosed?.(); };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--root', root, '--name', roleName, '--private-host'],
    stderr: 'pipe',
  });
  // The child can emit diagnostics; protocol data uses stdout exclusively.
  transport.stderr?.on('data', () => {});
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw error; }
  const invoke = async (method: string, args: object) => {
    if (closed) throw new Error('记忆引擎连接已关闭；下一次操作将重新连接。');
    const result = await client.callTool({ name: '_host', arguments: { method, args } }, { timeout: 180_000 });
    const content = result.content.find(x => x.type === 'text');
    if (!content || content.type !== 'text') throw new Error('Engine returned no JSON response');
    const value = JSON.parse(content.text);
    if (result.isError) {
      const error = new Error(value.error ?? 'Engine operation failed');
      if (typeof value.code === 'string') Object.assign(error, { code: value.code });
      throw error;
    }
    return value;
  };
  return {
    notes: (command: NotesCommand, context?: OperationContext) => invoke('notes', { command, context }),
    admin: <T>(method: AdminMethod, args: JsonObject = {}) => invoke(method, args) as Promise<T>,
    close: () => client.close(),
  };
}

export class EnginePool {
  private clients = new Map<string, {
    role: Role;
    proxy: EngineClient;
    connection?: Promise<EngineClient>;
    generation: number;
  }>();
  private closed = false;
  constructor(private rootFor: (roleId: string) => string, private entry?: string) {}
  get(role: Role): Promise<EngineClient> {
    if (this.closed) return Promise.reject(new Error('记忆引擎池已关闭。'));
    const previous = this.clients.get(role.id);
    if (previous) { previous.role = role; return Promise.resolve(previous.proxy); }
    const entry = {
      role,
      generation: 0,
      connection: undefined as Promise<EngineClient> | undefined,
      proxy: undefined as unknown as EngineClient,
    };
    const connection = (): Promise<EngineClient> => {
      if (this.closed) return Promise.reject(new Error('记忆引擎池已关闭。'));
      if (!entry.connection) {
        const generation = ++entry.generation;
        entry.connection = connectEngine(this.rootFor(role.id), entry.role.name, this.entry, () => {
          if (entry.generation === generation) entry.connection = undefined;
        });
        void entry.connection.catch(() => {
          if (entry.generation === generation) entry.connection = undefined;
        });
      }
      return entry.connection;
    };
    entry.proxy = {
      notes: async (command, context) => (await connection()).notes(command, context),
      admin: async <T>(method: AdminMethod, args: JsonObject = {}) => (await connection()).admin<T>(method, args),
      close: () => this.release(role.id),
    };
    this.clients.set(role.id, entry);
    return Promise.resolve(entry.proxy);
  }
  async release(roleId: string) {
    const entry = this.clients.get(roleId);
    if (entry) {
      const current = entry.connection;
      ++entry.generation;
      entry.connection = undefined;
      if (current) {
        try { await (await current).close(); }
        catch { /* A process that already exited needs no second teardown. */ }
      }
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.clients.keys()].map(id => this.release(id)));
    this.clients.clear();
  }
}
