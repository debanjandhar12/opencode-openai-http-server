import type { PluginInput } from '@opencode-ai/plugin';
import type { AssistantMessage, Part, Provider } from '@opencode-ai/sdk';

import type { ProviderCatalogEntry } from '../openai/models.ts';
import type { StatelessPrompt } from '../transcript.ts';

export interface PromptResult {
  info: AssistantMessage;
  parts: Part[];
}

export interface OpenCodeSessionClient {
  providers(): Promise<ProviderCatalogEntry[]>;
  createSession(): Promise<string>;
  prompt(
    sessionID: string,
    providerID: string,
    modelID: string,
    prompt: StatelessPrompt
  ): Promise<PromptResult>;
  abortSession(sessionID: string): Promise<void>;
  deleteSession(sessionID: string): Promise<void>;
}

export class OpenCodeClientAdapter implements OpenCodeSessionClient {
  constructor(
    private readonly client: PluginInput['client'],
    private readonly directory: string
  ) {}

  async providers(): Promise<ProviderCatalogEntry[]> {
    const response = await this.client.config.providers({
      query: { directory: this.directory },
      throwOnError: true,
    });
    return response.data.providers.map(providerEntry);
  }

  async createSession(): Promise<string> {
    const response = await this.client.session.create({
      query: { directory: this.directory },
      body: { title: 'OpenAI-compatible request' },
      throwOnError: true,
    });
    return response.data.id;
  }

  async prompt(
    sessionID: string,
    providerID: string,
    modelID: string,
    prompt: StatelessPrompt
  ): Promise<PromptResult> {
    const response = await this.client.session.prompt({
      path: { id: sessionID },
      query: { directory: this.directory },
      body: {
        model: { providerID, modelID },
        system: prompt.system,
        tools: prompt.tools,
        parts: prompt.parts,
      },
      throwOnError: true,
    });
    return response.data;
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

function providerEntry(provider: Provider): ProviderCatalogEntry {
  return {
    id: provider.id,
    models: Object.fromEntries(
      Object.entries(provider.models).map(([id, model]) => [
        id,
        {
          name: model.name,
          capabilities: {
            image: model.capabilities.input.image,
            tools: model.capabilities.toolcall,
          },
        },
      ])
    ),
  };
}
