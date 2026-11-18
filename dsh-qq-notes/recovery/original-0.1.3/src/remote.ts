import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
export const requestSchema = z.object({ action: z.string().min(1), args: z.record(z.string(), z.json()).default({}) })
const inputCodec = { mode: 'strict' as const, typeSymbol: 'QqRequest', create: () => requestSchema }
const result = { mode: 'strict' as const, typeSymbol: 'QqResult', create: () => z.json() }
export default createTypertRemoteInfo({ package: 'dsh-qq', methods: {
  'qqBridge/request': { service: 'qqBridge', invocation: { kind: 'direct' }, parameters: [{ name: 'input', source: 'json', codec: inputCodec, strictCodec: inputCodec }], result },
} }, z)
