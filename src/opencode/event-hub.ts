import type { AssistantMessage, Event, Part } from '@opencode-ai/sdk';

import type { NormalizedUsage } from '../openai/types.ts';

export interface CompletionDelta {
  type: 'text' | 'reasoning';
  value: string;
}

export interface AccumulatedCompletion {
  text: string;
  reasoning: string;
  usage?: NormalizedUsage;
  finish?: string;
}

export interface SessionEventConsumer {
  onDelta(delta: CompletionDelta): void;
  onError(error: unknown): void;
}

interface PartState {
  type: 'text' | 'reasoning';
  value: string;
  emittedLength: number;
}

interface ConsumerState {
  consumer: SessionEventConsumer;
  assistantMessageID?: string;
  info?: AssistantMessage;
  parts: Map<string, PartState>;
  pendingParts: Part[];
  suppressOutput: boolean;
}

export class EventHub {
  private readonly consumers = new Map<string, ConsumerState>();

  register(sessionID: string, consumer: SessionEventConsumer): void {
    this.consumers.set(sessionID, {
      consumer,
      parts: new Map(),
      pendingParts: [],
      suppressOutput: false,
    });
  }

  unregister(sessionID: string): void {
    this.consumers.delete(sessionID);
  }

  suppressOutput(sessionID: string): void {
    const state = this.consumers.get(sessionID);
    if (state) state.suppressOutput = true;
  }

  snapshot(sessionID: string): AccumulatedCompletion {
    const state = this.consumers.get(sessionID);
    if (!state) return { text: '', reasoning: '' };
    let text = '';
    let reasoning = '';
    for (const part of state.parts.values()) {
      if (part.type === 'text') text += part.value;
      else reasoning += part.value;
    }
    return {
      text,
      reasoning,
      ...(state.info ? { usage: usageFrom(state.info), finish: state.info.finish } : {}),
    };
  }

  handle(event: Event): void {
    if (event.type === 'message.updated') {
      const { info } = event.properties;
      if (info.role !== 'assistant') return;
      const state = this.consumers.get(info.sessionID);
      if (!state) return;
      state.assistantMessageID = info.id;
      state.info = info;
      const pending = state.pendingParts;
      state.pendingParts = [];
      for (const part of pending) {
        if (part.type === 'text' || part.type === 'reasoning') this.updatePart(state, part);
      }
      return;
    }
    if (event.type === 'message.part.updated') {
      const { part } = event.properties;
      const state = this.consumers.get(part.sessionID);
      if (!state) return;
      if (part.type === 'tool' && part.tool !== 'openai_compatable_tool_dispatcher') {
        state.consumer.onError(new Error('Unexpected native OpenCode tool call.'));
        return;
      }
      if (part.type !== 'text' && part.type !== 'reasoning') return;
      if (!state.assistantMessageID) {
        state.pendingParts.push(part);
        return;
      }
      this.updatePart(state, part);
      return;
    }
    if (event.type === 'message.part.removed') {
      this.consumers.get(event.properties.sessionID)?.parts.delete(event.properties.partID);
      return;
    }
    if (event.type !== 'session.error') return;
    const state = this.consumers.get(event.properties.sessionID ?? '');
    if (state) state.consumer.onError(event.properties.error);
  }

  private updatePart(
    state: ConsumerState,
    part: Extract<Part, { type: 'text' | 'reasoning' }>
  ): void {
    if (part.messageID !== state.assistantMessageID) return;
    const previous = state.parts.get(part.id);
    const previousValue = previous?.value ?? '';
    const nextValue = part.text.startsWith(previousValue) ? part.text : previousValue;
    const partState: PartState = previous ?? {
      type: part.type,
      value: '',
      emittedLength: 0,
    };
    partState.value = nextValue;
    state.parts.set(part.id, partState);
    if (state.suppressOutput) return;
    const suffix = nextValue.slice(partState.emittedLength);
    if (!suffix) return;
    partState.emittedLength = nextValue.length;
    state.consumer.onDelta({ type: part.type, value: suffix });
  }
}

function usageFrom(info: AssistantMessage): NormalizedUsage {
  return {
    inputTokens: info.tokens.input,
    outputTokens: info.tokens.output,
    ...(info.tokens.reasoning > 0 ? { reasoningTokens: info.tokens.reasoning } : {}),
  };
}
