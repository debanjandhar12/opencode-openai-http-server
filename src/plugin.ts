import type { Hooks, Plugin, PluginModule } from '@opencode-ai/plugin';
import packageJSON from '../package.json' with { type: 'json' };

import { parseServerOptions, type OpenAIHttpServerOptions } from './config.ts';
import { createRouter } from './http/router.ts';
import { startHttpServer } from './http/server.ts';
import { checkOpenCodeHealth } from './opencode/capabilities.ts';
import { OpenCodeClientAdapter } from './opencode/client.ts';
import { CAPTURE_HEADER, CaptureManager } from './proxy/capture.ts';
import { ProxyRunner } from './proxy/runner.ts';

export const PLUGIN_VERSION = packageJSON.version;

export const OpenCodeOpenAIHttpServerPlugin: Plugin = async (input, options) => {
  const serverOptions = parseServerOptions(options);
  const health = await checkOpenCodeHealth(input.serverUrl);
  const client = new OpenCodeClientAdapter(input.client, input.directory);
  const capture = new CaptureManager();
  const runner = new ProxyRunner(client, capture);
  let draining = false;
  let disposed = false;
  const router = createRouter({
    options: serverOptions,
    client,
    runner,
    openCodeVersion: health.version,
    pluginVersion: packageJSON.version,
    isDraining: () => draining,
  });
  let httpServer: ReturnType<typeof startHttpServer>;
  try {
    httpServer = startHttpServer(serverOptions.host, serverOptions.port, router);
  } catch (error) {
    capture.dispose();
    throw error;
  }

  const hooks: Hooks = {
    async 'chat.headers'(hookInput, output): Promise<void> {
      const marker = runner.markerFor(hookInput.sessionID);
      if (marker) output.headers[CAPTURE_HEADER] = marker;
    },
    async 'experimental.chat.system.transform'(hookInput, output): Promise<void> {
      if (runner.isCaptureSession(hookInput.sessionID)) output.system = [];
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      draining = true;
      await runner.shutdown();
      await httpServer.stop(true);
      capture.dispose();
    },
  };
  return hooks;
};

export const server = OpenCodeOpenAIHttpServerPlugin;

export const OpenCodeOpenAIHttpServerModule: PluginModule = {
  id: 'opencode-openai-http-server',
  server: OpenCodeOpenAIHttpServerPlugin,
};

export type { OpenAIHttpServerOptions };
