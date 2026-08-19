import { MAX_REQUEST_BODY_BYTES, MAX_TOOL_COUNT, MAX_TOOL_SCHEMA_BYTES } from '../constants.ts';
import { ProtocolError, invalidRequest } from '../errors.ts';
import { validateImageURL } from './images.ts';
import type {
  ImageURLContentPart,
  JsonSchema,
  NormalizedContent,
  NormalizedFunctionTool,
  NormalizedMessage,
  NormalizedToolCall,
  ParsedChatCompletionRequest,
} from './types.ts';

type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export function parseChatCompletionJSON(body: string): ParsedChatCompletionRequest {
  if (new globalThis.TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new ProtocolError(413, 'request_too_large', 'Request body exceeds the size limit.');
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw invalidRequest('Request body must be valid JSON.');
  }
  return parseChatCompletionRequest(value);
}

export function parseChatCompletionRequest(value: unknown): ParsedChatCompletionRequest {
  const input = requireRecord(value, 'body');
  const model = requireNonEmptyString(input.model, 'model');
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw invalidRequest('messages must be a non-empty array.', 'messages');
  }

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw invalidRequest('stream must be a boolean.', 'stream');
  }

  const tools = parseTools(input.tools);
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const messages = parseMessages(input.messages, toolNames);
  return { model, messages, tools, stream: input.stream === true };
}

function parseTools(value: unknown): NormalizedFunctionTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidRequest('tools must be an array.', 'tools');
  if (value.length > MAX_TOOL_COUNT) throw invalidRequest('Too many tools were supplied.', 'tools');

  const names = new Set<string>();
  return value.map((entry, index) => {
    const tool = requireRecord(entry, `tools[${index}]`);
    if (tool.type !== 'function') {
      throw invalidRequest('Only function tools are supported.', `tools[${index}].type`);
    }
    const fn = requireRecord(tool.function, `tools[${index}].function`);
    const name = requireNonEmptyString(fn.name, `tools[${index}].function.name`);
    if (names.has(name)) throw invalidRequest(`Duplicate tool name: ${name}.`, 'tools');
    names.add(name);

    if (fn.description !== undefined && typeof fn.description !== 'string') {
      throw invalidRequest(
        'Tool description must be a string.',
        `tools[${index}].function.description`
      );
    }
    const parameters =
      fn.parameters === undefined ? { type: 'object' } : parseSchema(fn.parameters);
    if (
      new globalThis.TextEncoder().encode(JSON.stringify(parameters)).byteLength >
      MAX_TOOL_SCHEMA_BYTES
    ) {
      throw new ProtocolError(
        400,
        'invalid_schema',
        `Schema for tool ${name} exceeds the size limit.`,
        `tools[${index}].function.parameters`
      );
    }
    return {
      type: 'function',
      function: {
        name,
        ...(fn.description === undefined ? {} : { description: fn.description }),
        parameters,
      },
    };
  });
}

function parseMessages(value: unknown[], toolNames: Set<string>): NormalizedMessage[] {
  const knownCalls = new Map<string, string>();
  const unresolvedCalls = new Set<string>();

  const messages = value.map((entry, index) => {
    const message = requireRecord(entry, `messages[${index}]`);
    const role = message.role;
    if (!isMessageRole(role)) {
      throw invalidRequest('Message role is not supported.', `messages[${index}].role`);
    }

    if (role !== 'tool' && unresolvedCalls.size > 0) {
      throw invalidRequest(
        'All tool calls must have results before the next conversation message.',
        `messages[${index}]`
      );
    }

    if (role === 'assistant') {
      const content =
        message.content === undefined || message.content === null
          ? null
          : parseContent(message.content, index);
      const toolCalls = parseHistoricalToolCalls(message.tool_calls, index, knownCalls, toolNames);
      for (const call of toolCalls) unresolvedCalls.add(call.id);
      if (content === null && toolCalls.length === 0) {
        throw invalidRequest(
          'Assistant message must have content or tool calls.',
          `messages[${index}]`
        );
      }
      return {
        role,
        content,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      };
    }

    if (role === 'tool') {
      const toolCallID = requireNonEmptyString(
        message.tool_call_id,
        `messages[${index}].tool_call_id`
      );
      if (!knownCalls.has(toolCallID) || !unresolvedCalls.has(toolCallID)) {
        throw invalidRequest(
          'Tool message must reference an unresolved prior tool call.',
          'messages'
        );
      }
      if (message.name !== undefined && message.name !== knownCalls.get(toolCallID)) {
        throw invalidRequest(
          'Tool result name does not match its tool call.',
          `messages[${index}].name`
        );
      }
      unresolvedCalls.delete(toolCallID);
      return { role, toolCallID, content: parseContent(message.content, index) };
    }

    return { role, content: parseContent(message.content, index) };
  });

  if (unresolvedCalls.size > 0) {
    throw invalidRequest('All tool calls must have results before request end.', 'messages');
  }

  return messages;
}

function parseHistoricalToolCalls(
  value: unknown,
  messageIndex: number,
  knownCalls: Map<string, string>,
  toolNames: Set<string>
): NormalizedToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest(
      'tool_calls must be a non-empty array.',
      `messages[${messageIndex}].tool_calls`
    );
  }

  return value.map((entry, index) => {
    const path = `messages[${messageIndex}].tool_calls[${index}]`;
    const call = requireRecord(entry, path);
    if (call.type !== 'function')
      throw invalidRequest('Tool call type must be function.', `${path}.type`);
    const id = requireNonEmptyString(call.id, `${path}.id`);
    if (knownCalls.has(id)) throw invalidRequest(`Duplicate tool call ID: ${id}.`, `${path}.id`);
    const fn = requireRecord(call.function, `${path}.function`);
    const name = requireNonEmptyString(fn.name, `${path}.function.name`);
    if (toolNames.size > 0 && !toolNames.has(name)) {
      throw invalidRequest(
        `Historical tool call references unknown tool: ${name}.`,
        `${path}.function.name`
      );
    }
    if (typeof fn.arguments !== 'string') {
      throw invalidRequest(
        'Historical tool arguments must be a string.',
        `${path}.function.arguments`
      );
    }
    knownCalls.set(id, name);
    return { id, name, arguments: fn.arguments };
  });
}

function parseContent(value: unknown, messageIndex: number): NormalizedContent[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) {
    throw invalidRequest(
      'Message content must be a string or content-part array.',
      `messages[${messageIndex}].content`
    );
  }

  return value.map((entry, index) => {
    const path = `messages[${messageIndex}].content[${index}]`;
    const part = requireRecord(entry, path);
    if (part.type === 'text') {
      if (typeof part.text !== 'string')
        throw invalidRequest('Text part requires text.', `${path}.text`);
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url') return parseImagePart(part, path);
    throw invalidRequest('Content part type is not supported.', `${path}.type`);
  });
}

function parseImagePart(part: Record<string, unknown>, path: string): ImageURLContentPart {
  const imageURL = requireRecord(part.image_url, `${path}.image_url`);
  const url = requireNonEmptyString(imageURL.url, `${path}.image_url.url`);
  const detail = imageURL.detail;
  if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
    throw invalidRequest('Image detail must be auto, low, or high.', `${path}.image_url.detail`);
  }
  validateImageURL(url);
  return {
    type: 'image_url',
    imageUrl: { url, ...(detail === undefined ? {} : { detail }) },
  };
}

function parseSchema(value: unknown): JsonSchema {
  if (typeof value === 'boolean') return value;
  return requireRecord(value, 'parameters');
}

function requireRecord(value: unknown, param: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest(`${param} must be an object.`, param);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, param: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest(`${param} must be a non-empty string.`, param);
  }
  return value;
}

function isMessageRole(value: unknown): value is MessageRole {
  return (
    value === 'system' ||
    value === 'developer' ||
    value === 'user' ||
    value === 'assistant' ||
    value === 'tool'
  );
}
