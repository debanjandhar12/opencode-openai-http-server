import {
  MAX_GENERATED_TOOL_CALLS,
  MAX_INVALID_TOOL_ATTEMPTS,
  TOOL_COLLECTION_DEADLINE_MS,
  TOOL_COLLECTION_QUIET_MS,
} from '../constants.ts';
import type { CapturedToolCall } from '../openai/types.ts';

export type ToolCallCollectorState = 'open' | 'collecting' | 'invalid_exhausted' | 'closed';

export type ToolCallCollectionResult =
  | { type: 'tool_calls'; calls: CapturedToolCall[] }
  | { type: 'invalid_exhausted'; calls: [] }
  | { type: 'closed'; calls: CapturedToolCall[] };

export interface ToolCallCollectorOptions {
  quietMs?: number;
  deadlineMs?: number;
  maxCalls?: number;
  maxInvalidAttempts?: number;
}

export class ToolCallCollector {
  private readonly calls: CapturedToolCall[] = [];
  private readonly seenIDs = new Set<string>();
  private readonly quietMs: number;
  private readonly deadlineMs: number;
  private readonly maxCalls: number;
  private readonly maxInvalidAttempts: number;
  private quietTimer?: ReturnType<typeof globalThis.setTimeout>;
  private deadlineTimer?: ReturnType<typeof globalThis.setTimeout>;
  private invalidAttempts = 0;
  private readonly deferred: ReturnType<typeof Promise.withResolvers<ToolCallCollectionResult>>;
  private currentState: ToolCallCollectorState = 'open';

  constructor(options: ToolCallCollectorOptions = {}) {
    this.quietMs = options.quietMs ?? TOOL_COLLECTION_QUIET_MS;
    this.deadlineMs = options.deadlineMs ?? TOOL_COLLECTION_DEADLINE_MS;
    this.maxCalls = options.maxCalls ?? MAX_GENERATED_TOOL_CALLS;
    this.maxInvalidAttempts = options.maxInvalidAttempts ?? MAX_INVALID_TOOL_ATTEMPTS;
    this.deferred = Promise.withResolvers<ToolCallCollectionResult>();
  }

  get state(): ToolCallCollectorState {
    return this.currentState;
  }

  capture(call: Omit<CapturedToolCall, 'index'>): boolean {
    if (this.currentState !== 'open' && this.currentState !== 'collecting') return false;
    if (this.seenIDs.has(call.id)) return false;

    const snapshot: CapturedToolCall = Object.freeze({ ...call, index: this.calls.length });
    this.calls.push(snapshot);
    this.seenIDs.add(call.id);
    if (this.currentState === 'open') {
      this.currentState = 'collecting';
      this.deadlineTimer = globalThis.setTimeout(() => this.finishToolCalls(), this.deadlineMs);
    }
    this.resetQuietTimer();
    if (this.calls.length >= this.maxCalls) this.finishToolCalls();
    return true;
  }

  recordInvalidAttempt(): boolean {
    if (this.currentState === 'closed' || this.currentState === 'invalid_exhausted') return true;
    this.invalidAttempts += 1;
    if (this.invalidAttempts < this.maxInvalidAttempts || this.calls.length > 0) return false;
    this.clearTimers();
    this.currentState = 'invalid_exhausted';
    this.deferred.resolve({ type: 'invalid_exhausted', calls: [] });
    return true;
  }

  wait(): Promise<ToolCallCollectionResult> {
    return this.deferred.promise;
  }

  close(): void {
    if (this.currentState === 'closed' || this.currentState === 'invalid_exhausted') return;
    this.clearTimers();
    this.currentState = 'closed';
    this.deferred.resolve({ type: 'closed', calls: this.snapshots() });
  }

  snapshots(): CapturedToolCall[] {
    return this.calls.map((call) => ({ ...call }));
  }

  private resetQuietTimer(): void {
    if (this.quietTimer) globalThis.clearTimeout(this.quietTimer);
    this.quietTimer = globalThis.setTimeout(() => this.finishToolCalls(), this.quietMs);
  }

  private finishToolCalls(): void {
    if (this.currentState !== 'collecting') return;
    this.clearTimers();
    this.currentState = 'closed';
    this.deferred.resolve({ type: 'tool_calls', calls: this.snapshots() });
  }

  private clearTimers(): void {
    if (this.quietTimer) globalThis.clearTimeout(this.quietTimer);
    if (this.deadlineTimer) globalThis.clearTimeout(this.deadlineTimer);
    this.quietTimer = undefined;
    this.deadlineTimer = undefined;
  }
}
