import { tool, type Hooks } from '@opencode-ai/plugin';

import { OPENAI_COMPATABLE_TOOL_DISPATCHER } from '../constants.ts';
import { dispatcherExecute, type DispatcherRegistry } from './registry.ts';

export function createDispatcherTool(
  registry: DispatcherRegistry
): NonNullable<Hooks['tool']>[string] {
  return tool({
    description:
      'Captures a request for an external OpenAI-compatible function. Never executes the function.',
    args: {
      name: tool.schema.string(),
      arguments: tool.schema.unknown(),
    },
    async execute(args, context): Promise<string> {
      return dispatcherExecute(registry, args, context);
    },
  });
}

export function dispatcherHooks(
  registry: DispatcherRegistry
): Pick<Hooks, 'tool.execute.before' | 'tool.execute.after'> {
  return {
    async 'tool.execute.before'(input, output): Promise<void> {
      if (input.tool !== OPENAI_COMPATABLE_TOOL_DISPATCHER) return;
      registry.before(input.sessionID, input.callID, output.args);
    },
    async 'tool.execute.after'(input): Promise<void> {
      if (input.tool !== OPENAI_COMPATABLE_TOOL_DISPATCHER) return;
      registry.after(input.sessionID, input.callID);
    },
  };
}
