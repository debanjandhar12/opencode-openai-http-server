import type { Config, PluginInput } from '@opencode-ai/plugin';
import type { Provider } from '@opencode-ai/sdk';

import type { ProviderCatalogEntry } from '../openai/models.ts';

export interface OpenCodeProxyClient {
  providers(): Promise<ProviderCatalogEntry[]>;
  createSession(): Promise<string>;
  promptCapture(sessionID: string, providerID: string, modelID: string): Promise<void>;
  abortSession(sessionID: string): Promise<void>;
  deleteSession(sessionID: string): Promise<void>;
}

export class OpenCodeClientAdapter implements OpenCodeProxyClient {
  constructor(
    private readonly client: PluginInput['client'],
    private readonly directory: string
  ) {}

  async providers(): Promise<ProviderCatalogEntry[]> {
    const [providerResponse, configResponse] = await Promise.all([
      this.client.config.providers({
        query: { directory: this.directory },
        throwOnError: true,
      }),
      this.client.config.get({
        query: { directory: this.directory },
        throwOnError: true,
      }),
    ]);
    return filterProviders(providerResponse.data.providers, configResponse.data);
  }

  async createSession(): Promise<string> {
    const response = await this.client.session.create({
      query: { directory: this.directory },
      body: { title: 'OpenAI provider capture' },
      throwOnError: true,
    });
    return response.data.id;
  }

  async promptCapture(sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.client.session.prompt({
      path: { id: sessionID },
      query: { directory: this.directory },
      body: {
        model: { providerID, modelID },
        tools: { '*': false },
        parts: [{ type: 'text', text: 'capture' }],
      },
      throwOnError: true,
    });
  }

  async abortSession(sessionID: string): Promise<void> {
    await this.client.session.abort({
      path: { id: sessionID },
      query: { directory: this.directory },
      throwOnError: true,
    });
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.client.session.delete({
      path: { id: sessionID },
      query: { directory: this.directory },
      throwOnError: true,
    });
  }
}

function filterProviders(providers: Provider[], config: Config): ProviderCatalogEntry[] {
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined;
  const disabled = new Set(config.disabled_providers ?? []);
  return providers.flatMap((provider) => {
    if (enabled && !enabled.has(provider.id)) return [];
    if (disabled.has(provider.id)) return [];
    const providerConfig = config.provider?.[provider.id];
    const whitelist = providerConfig?.whitelist ? new Set(providerConfig.whitelist) : undefined;
    const blacklist = new Set(providerConfig?.blacklist ?? []);
    const models = Object.entries(provider.models).flatMap(([id, model]) => {
      if (whitelist && !whitelist.has(id)) return [];
      if (blacklist.has(id) || model.status === 'deprecated') return [];
      if (!isOpenAIWire(model.api.npm)) return [];
      return [
        {
          id,
          name: model.name,
          capabilities: {
            image: model.capabilities.input.image,
            tools: model.capabilities.toolcall,
          },
        },
      ];
    });
    return models.length === 0 ? [] : [{ id: provider.id, models }];
  });
}

function isOpenAIWire(npm: string): boolean {
  return (
    npm === '@ai-sdk/openai' ||
    npm === '@ai-sdk/openai-compatible' ||
    npm === '@ai-sdk/azure' ||
    npm === '@openrouter/ai-sdk-provider' ||
    npm === '@ai-sdk/github-copilot' ||
    npm === '@ai-sdk/xai' ||
    npm === '@ai-sdk/mistral' ||
    npm === '@ai-sdk/groq' ||
    npm === '@ai-sdk/deepinfra' ||
    npm === '@ai-sdk/cerebras' ||
    npm === '@ai-sdk/togetherai' ||
    npm === '@ai-sdk/perplexity' ||
    npm === '@ai-sdk/alibaba' ||
    npm === 'venice-ai-sdk-provider'
  );
}
