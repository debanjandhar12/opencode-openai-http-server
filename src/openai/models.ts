import { ProtocolError } from '../errors.ts';
import type { OpenAIModel } from './types.ts';

export interface ProviderModel {
  id: string;
  name?: string;
  capabilities?: {
    image?: boolean;
    tools?: boolean;
  };
}

export interface ProviderCatalogEntry {
  id: string;
  models: readonly ProviderModel[] | Readonly<Record<string, Omit<ProviderModel, 'id'>>>;
}

export interface ResolvedModel {
  id: string;
  providerID: string;
  modelID: string;
  model: ProviderModel;
}

export function flattenModels(
  providers: readonly ProviderCatalogEntry[],
  created: number = Math.floor(Date.now() / 1000)
): OpenAIModel[] {
  return providers.flatMap((provider) =>
    modelEntries(provider).map((model) => ({
      id: `${provider.id}/${model.id}`,
      object: 'model' as const,
      created,
      owned_by: provider.id,
    }))
  );
}

export function resolveModel(
  requestedID: string,
  providers: readonly ProviderCatalogEntry[]
): ResolvedModel {
  const slash = requestedID.indexOf('/');
  if (slash <= 0 || slash === requestedID.length - 1) throw modelNotFound(requestedID);
  const providerID = requestedID.slice(0, slash);
  const modelID = requestedID.slice(slash + 1);
  const provider = providers.find((entry) => entry.id === providerID);
  const model = provider && modelEntries(provider).find((entry) => entry.id === modelID);
  if (!model) throw modelNotFound(requestedID);
  return { id: requestedID, providerID, modelID, model };
}

export function assertModelCapabilities(
  resolved: ResolvedModel,
  requirements: { images: boolean; tools: boolean }
): void {
  if (requirements.images && resolved.model.capabilities?.image === false) {
    throw new ProtocolError(
      400,
      'invalid_image',
      `Model ${resolved.id} does not support images.`,
      'model'
    );
  }
  if (requirements.tools && resolved.model.capabilities?.tools === false) {
    throw new ProtocolError(
      400,
      'invalid_request_error',
      `Model ${resolved.id} does not support tools.`,
      'model'
    );
  }
}

function modelEntries(provider: ProviderCatalogEntry): ProviderModel[] {
  if (Array.isArray(provider.models)) return [...provider.models];
  return Object.entries(provider.models).map(([id, model]) => ({ id, ...model }));
}

function modelNotFound(id: string): ProtocolError {
  return new ProtocolError(400, 'model_not_found', `The model '${id}' does not exist.`, 'model');
}
