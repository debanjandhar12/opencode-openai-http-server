import type { ToolContext } from '@opencode-ai/plugin';

import type { CapturedToolCall, JsonValue, NormalizedFunctionTool } from '../openai/types.ts';
import { ToolCallCollector } from './collector.ts';
import {
  compileSchema,
  type CompiledSchema,
  type SchemaValidationError,
} from './schema-validator.ts';

export interface RegisteredTool {
  definition: NormalizedFunctionTool;
  schema: CompiledSchema;
}

interface PendingCall {
  callID: string;
  normalizedArgs: string;
  claimed: boolean;
}

interface BurnerContext {
  collector: ToolCallCollector;
  tools: Map<string, RegisteredTool>;
  pending: PendingCall[];
  onCapture?: () => void;
}

export type DispatchResult =
  | { type: 'captured'; call: CapturedToolCall }
  | { type: 'invalid'; errors: SchemaValidationError[]; exhausted: boolean };

export class DispatcherRegistry {
  private readonly burners = new Map<string, BurnerContext>();

  prepare(tools: NormalizedFunctionTool[]): Map<string, RegisteredTool> {
    return new Map(
      tools.map((definition) => [
        definition.function.name,
        { definition, schema: compileSchema(definition.function.parameters) },
      ])
    );
  }

  register(
    sessionID: string,
    tools: Map<string, RegisteredTool>,
    collector: ToolCallCollector,
    onCapture?: () => void
  ): void {
    if (this.burners.has(sessionID)) throw new Error(`Session ${sessionID} is already registered.`);
    this.burners.set(sessionID, {
      collector,
      tools,
      pending: [],
      ...(onCapture ? { onCapture } : {}),
    });
  }

  unregister(sessionID: string): void {
    const burner = this.burners.get(sessionID);
    burner?.collector.close();
    this.burners.delete(sessionID);
  }

  before(sessionID: string, callID: string, args: unknown): void {
    const burner = this.burners.get(sessionID);
    if (!burner) throw new Error('Dispatcher is only available to OpenAI API burner sessions.');
    burner.pending.push({ callID, normalizedArgs: canonicalJSON(args), claimed: false });
  }

  after(sessionID: string, callID: string): void {
    const burner = this.burners.get(sessionID);
    if (!burner) return;
    burner.pending = burner.pending.filter((entry) => entry.callID !== callID);
  }

  dispatch(
    sessionID: string,
    messageID: string,
    name: string,
    argumentsValue: unknown
  ): DispatchResult {
    const burner = this.burners.get(sessionID);
    if (!burner) throw new Error('Dispatcher is only available to OpenAI API burner sessions.');
    const dispatcherArgs = { name, arguments: argumentsValue };
    const normalizedArgs = canonicalJSON(dispatcherArgs);
    const matches = burner.pending.filter(
      (entry) => !entry.claimed && entry.normalizedArgs === normalizedArgs
    );
    if (matches.length !== 1) {
      const exhausted = burner.collector.recordInvalidAttempt();
      return {
        type: 'invalid',
        exhausted,
        errors: [
          {
            path: '/',
            keyword: 'correlation',
            message: matches.length === 0 ? 'could not be correlated' : 'is ambiguous',
          },
        ],
      };
    }
    const pending = matches[0];
    pending.claimed = true;

    const registered = burner.tools.get(name);
    if (!registered) {
      const exhausted = burner.collector.recordInvalidAttempt();
      return {
        type: 'invalid',
        exhausted,
        errors: [{ path: '/name', keyword: 'enum', message: 'is not a registered external tool' }],
      };
    }

    const normalized = normalizeArguments(argumentsValue);
    if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
      return {
        type: 'invalid',
        exhausted: burner.collector.recordInvalidAttempt(),
        errors: [{ path: '/arguments', keyword: 'type', message: 'must be an object' }],
      };
    }
    if (!registered.schema.validate(normalized)) {
      return {
        type: 'invalid',
        exhausted: burner.collector.recordInvalidAttempt(),
        errors: registered.schema.errors(),
      };
    }

    const call: Omit<CapturedToolCall, 'index'> = {
      id: openAICallID(pending.callID),
      name,
      arguments: JSON.stringify(normalized),
      openCodeCallID: pending.callID,
      messageID,
    };
    const accepted = burner.collector.capture(call);
    if (accepted) burner.onCapture?.();
    const captured = burner.collector
      .snapshots()
      .find((entry) => entry.openCodeCallID === pending.callID);
    if (!captured) throw new Error('Dispatcher call was not captured.');
    return { type: 'captured', call: captured };
  }

  isRegistered(sessionID: string): boolean {
    return this.burners.has(sessionID);
  }
}

export interface DispatcherArguments {
  name: string;
  arguments: unknown;
}

export function dispatcherExecute(
  registry: DispatcherRegistry,
  args: DispatcherArguments,
  context: ToolContext
): string {
  const result = registry.dispatch(context.sessionID, context.messageID, args.name, args.arguments);
  if (result.type === 'captured') {
    return JSON.stringify({ captured: true, call_id: result.call.id, execute: false });
  }
  return JSON.stringify({
    captured: false,
    validation_errors: result.errors,
    retry: !result.exhausted,
  });
}

function normalizeArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as JsonValue;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return value;
    return parsed;
  } catch {
    return value;
  }
}

function openAICallID(callID: string): string {
  return `call_${callID.length}_${callID}`;
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}
