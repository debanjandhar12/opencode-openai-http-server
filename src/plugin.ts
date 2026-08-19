import type { Config, Hooks, Plugin, PluginModule } from '@opencode-ai/plugin';

import { parseServerOptions, type OpenAIHttpServerOptions } from './config.ts';
import { OPENAI_COMPATABLE_TOOL_DISPATCHER } from './constants.ts';
import { createRouter } from './http/router.ts';
import { startHttpServer } from './http/server.ts';
import { checkOpenCodeHealth } from './opencode/capabilities.ts';
import { OpenCodeClientAdapter } from './opencode/client.ts';
import { EventHub } from './opencode/event-hub.ts';
import { SessionRunner } from './opencode/session-runner.ts';
import { createDispatcherTool, dispatcherHooks } from './tools/dispatcher.ts';
import { DispatcherRegistry } from './tools/registry.ts';
import { PLUGIN_VERSION } from './version.ts';

export const OpenCodeOpenAIHttpServerPlugin: Plugin = async (input, options) => {
  const serverOptions = parseServerOptions(options);
  const health = await checkOpenCodeHealth(input.serverUrl);
  const client = new OpenCodeClientAdapter(input.client, input.directory);
  const events = new EventHub();
  const dispatcher = new DispatcherRegistry();
  const runner = new SessionRunner(client, events, dispatcher);
  const executionHooks = dispatcherHooks(dispatcher);
  const dispatcherTool = createDispatcherTool(dispatcher);
  let draining = false;
  let disposed = false;
  const router = createRouter({
    options: serverOptions,
    client,
    runner,
    openCodeVersion: health.version,
    pluginVersion: PLUGIN_VERSION,
    isDraining: () => draining,
  });
  const httpServer = startHttpServer(serverOptions.host, serverOptions.port, router);

  const hooks: Hooks = {
    async config(config): Promise<void> {
      disableDispatcher(config);
    },
    async event({ event }): Promise<void> {
      events.handle(event);
    },
    tool: {
      [OPENAI_COMPATABLE_TOOL_DISPATCHER]: dispatcherTool,
    },
    ...executionHooks,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      draining = true;
      await runner.shutdown();
      await httpServer.stop(true);
    },
  };
  return hooks;
};

export const server = OpenCodeOpenAIHttpServerPlugin;

export const OpenCodeOpenAIHttpServerModule: PluginModule = {
  id: 'opencode-openai-http-server',
  server: OpenCodeOpenAIHttpServerPlugin,
};

function disableDispatcher(config: Config): void {
  config.tools = {
    ...(config.tools ?? {}),
    [OPENAI_COMPATABLE_TOOL_DISPATCHER]: false,
  };
}

export type { OpenAIHttpServerOptions };
