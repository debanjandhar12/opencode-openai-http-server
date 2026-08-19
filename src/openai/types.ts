export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: unknown } | boolean;

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageURLContentPart {
  type: 'image_url';
  imageUrl: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type NormalizedContent = TextContentPart | ImageURLContentPart;

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type NormalizedMessage =
  | { role: 'system' | 'developer' | 'user'; content: NormalizedContent[] }
  | {
      role: 'assistant';
      content: NormalizedContent[] | null;
      toolCalls?: NormalizedToolCall[];
    }
  | { role: 'tool'; toolCallID: string; content: NormalizedContent[] };

export interface NormalizedFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonSchema;
  };
}

export interface ParsedChatCompletionRequest {
  model: string;
  messages: NormalizedMessage[];
  tools: NormalizedFunctionTool[];
  stream: boolean;
}

export interface CapturedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
  openCodeCallID?: string;
  messageID?: string;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface NormalizedCompletion {
  id: string;
  created: number;
  model: string;
  text: string;
  reasoning: string;
  toolCalls: CapturedToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls';
  usage?: NormalizedUsage;
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}
