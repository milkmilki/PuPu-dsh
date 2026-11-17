/** Host/UI wire types. Internal role/task/operation keys never enter note prose. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface ModelRoute { provider: string; model: string }
export interface Role {
  id: string;
  name: string;
  speakerName: string;
  roleCardPath: string;
  memoryModel?: ModelRoute;
  lastModel?: ModelRoute;
  createdAt: string;
}
export interface Binding { sessionId: string; roleId: string; speakerName: string; createdAt: string }
export interface DialogueInput {
  sessionId: string;
  messageId: string;
  party: 'human' | 'assistant';
  speaker: string;
  text: string;
  attachments?: Json[];
  at: string;
}
export interface Dialogue extends DialogueInput { seq: number }
export type NotesCommand = {
  action: 'view' | 'search' | 'create' | 'edit' | 'move' | 'delete' | 'sources';
  path?: string;
  query?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  to?: string;
  kind?: 'file' | 'directory';
  startLine?: number;
  lineCount?: number;
  offset?: number;
  limit?: number;
  revision?: string;
};
export interface OperationContext {
  /** Stable on replay; duplicate operations return original result. */
  operationId?: string;
  taskId?: string;
  actor?: string;
}
export type TaskReason = 'compaction' | 'manual' | 'daily' | 'import';
export type TaskStatus = 'queued' | 'running' | 'failed' | 'stopped' | 'completed';
export interface Trigger {
  triggerId: string;
  sessionId: string;
  reason: TaskReason;
  /** Omitted means capture the last committed source seq atomically. */
  upperBound?: number;
}
export interface Task {
  id: string;
  triggerId: string;
  sessionId: string;
  reason: TaskReason;
  status: TaskStatus;
  lowerBound: number;
  upperBound: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress: JsonObject;
}
export interface Version {
  id: number;
  path: string;
  content: string | null;
  operation: string;
  at: string;
}
export interface TranscriptEntry {
  kind: 'request' | 'response' | 'tool' | 'error';
  payload: Json;
  at: string;
}
export interface RoleEngine {
  execute(command: NotesCommand, context?: OperationContext): Promise<JsonObject>;
  roleCard(): { path: string; content: string | null };
  captureDialogue(input: DialogueInput): { seq: number; inserted: boolean };
  registerTrigger(trigger: Trigger): Task;
  registerDaily(day: string): Task;
  listTasks(): Task[];
  nextTask(): Task | null;
  getTask(taskId: string): Task;
  retryTask(taskId: string): Task;
  stopTask(taskId: string): Task;
  finishTask(taskId: string): Task;
  failTask(taskId: string, error: string): Task;
  transcript(taskId: string): TranscriptEntry[];
  appendTranscript(taskId: string, entry: TranscriptEntry): void;
  versions(path: string): Version[];
  undo(versionId: number, context?: OperationContext): Promise<JsonObject>;
  stats(): JsonObject;
  close(): void;
}
/** Private MCP admin methods. Never register these as conversational DSH tools. */
export type AdminMethod =
  | 'roleCard' | 'captureDialogue' | 'registerTrigger' | 'registerDaily'
  | 'listTasks' | 'nextTask' | 'getTask' | 'retryTask' | 'stopTask' | 'finishTask'
  | 'failTask' | 'transcript' | 'appendTranscript' | 'versions' | 'undo' | 'stats';
export interface EngineClient {
  notes(command: NotesCommand, context?: OperationContext): Promise<JsonObject>;
  admin<T = unknown>(method: AdminMethod, args?: JsonObject): Promise<T>;
  close(): Promise<void>;
}
export interface ImportPreview {
  token: string;
  name: string;
  people: { key: string; name: string }[];
  counts: Record<string, number>;
  fingerprints: Record<string, string>;
  warnings: string[];
  proposedPaths: string[];
}
export interface ImportSelection {
  token: string;
  name: string;
  speakerName: string;
  personMapping: Record<string, string>;
  confirmed: boolean;
}
export interface UiState {
  roles: Role[];
  bindings: Binding[];
  selectedRoleId?: string;
  tasks: Task[];
  stats: JsonObject;
  error?: string;
}
export interface UiRequest {
  action: 'state' | 'createRole' | 'updateRole' | 'createSession' | 'notes'
    | 'versions' | 'undo' | 'manual' | 'retry' | 'stop'
    | 'previewImport' | 'confirmImport' | 'export';
  roleId?: string;
  input?: JsonObject;
}
