#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NotesEngine } from '../engine/index.js';
import { createNotesServer } from './server.js';

const { values } = parseArgs({
  options: { root: { type: 'string' }, name: { type: 'string' }, 'private-host': { type: 'boolean' } },
});
if (!values.root) {
  console.error('Usage: pupu-notes-mcp --root <independent-role-directory> [--name <name>]');
  process.exitCode = 2;
} else {
  const engine = new NotesEngine(resolve(values.root), { roleName: values.name });
  const server = createNotesServer(engine, values['private-host'] ?? false);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    engine.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new StdioServerTransport());
}
