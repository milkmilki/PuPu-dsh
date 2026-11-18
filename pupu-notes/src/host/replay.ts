/** A live subscription may overlap a cold snapshot, but cannot overtake it. */
export class ReplayBarrier<T> {
  private waiting = new Map<string, T[]>();
  constructor(sessionIds: Iterable<string>) {
    for (const id of sessionIds) this.waiting.set(id, []);
  }
  /** True means the caller must defer processing until the cold prefix finishes. */
  buffer(sessionId: string, event: T): boolean {
    const events = this.waiting.get(sessionId);
    if (!events) return false;
    events.push(event);
    return true;
  }
  release(sessionId: string): T[] {
    const events = this.waiting.get(sessionId) ?? [];
    this.waiting.delete(sessionId);
    return events;
  }
}
