import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

/** One explicit Host entry point, shared by the native UI and Host registry. */
export const UiRequestSchema = z.strictObject({
  action: z.enum([
    'state', 'createRole', 'updateRole', 'createSession', 'notes',
    'versions', 'undo', 'manual', 'retry', 'stop',
    'previewImport', 'confirmImport', 'export',
  ]),
  roleId: z.string().min(1).optional(),
  input: z.record(z.string(), z.json()).optional(),
});

const requestCodec = {
  mode: 'strict' as const,
  typeSymbol: 'dsh-pupu-notes#UiRequest',
  create: () => UiRequestSchema,
};

export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: 'dsh-pupu-notes',
  methods: {
    'pupuNotes/invoke': {
      service: 'pupuNotes',
      description: '蒲蒲笔记管理界面的显式操作。',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: requestCodec,
        strictCodec: requestCodec,
      }],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-pupu-notes#Json',
        create: () => z.json(),
      },
    },
  },
}, z);
