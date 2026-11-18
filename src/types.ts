export type Segment = { type: string; data: Record<string, unknown> }
export interface Incoming { account: string; peer: string; id: string; nickname: string; segments: Segment[] }
export interface Account { id: string; name: string; selfId: string; port: number; enabled: boolean; workspaceId?: string; roleId?: string; ownerQQ?: string }
export interface BridgeConfig { port: number; accounts: Account[]; mergeWindowSeconds?: number }
export interface Route { account: string; peer: string; sessionId: string; workspaceId: string; roleId: string; speakerKey: string; speakerName?: string; status: 'creating' | 'active' | 'paused'; watermark: number; error?: string }
export interface Contact { account: string; peer: string; nickname: string; status: 'pending' | 'approved' | 'rejected' }
export interface Inbox extends Incoming { key: string; status: string; error?: string; receivedAt?: number; batchKey?: string; batchSize?: number }
export interface InputBatch { key: string; account: string; peer: string; sessionId: string; items: Inbox[] }
export interface Outbox { key: string; account: string; peer: string; segments: Segment[]; status: string; receipt?: string; error?: string }
export const defaultConfig: BridgeConfig = { port: 18080, accounts: [
  { id: 'pupu', name: '仆仆', selfId: '', port: 18081, enabled: false },
  { id: 'lulu', name: '璐璐', selfId: '', port: 18082, enabled: false },
] }
