import { describe, expect, it } from 'bun:test';

import { MAX_IMAGE_DATA_BYTES, OPENAI_COMPATABLE_TOOL_DISPATCHER } from '../src/constants.ts';
import { validateImageURL } from '../src/openai/images.ts';
import { flattenModels, resolveModel } from '../src/openai/models.ts';
import { parseChatCompletionRequest } from '../src/openai/parse.ts';
import { buildStatelessPrompt } from '../src/transcript.ts';

describe('images and models', () => {
  it('validates remote and base64 image URLs without downloading them', () => {
    const remoteURL = 'https://example.test/image.png?value=a%2Fb#fragment';
    expect(validateImageURL(remoteURL)).toEqual({
      url: remoteURL,
      mime: 'image/*',
      source: 'remote',
    });
    expect(validateImageURL('data:image/png;base64,YQ==')).toMatchObject({
      mime: 'image/png',
      source: 'data',
      decodedBytes: 1,
    });
    expect(validateImageURL('data:image/png;base64,YQ')).toMatchObject({ decodedBytes: 1 });
    expect(validateImageURL('data:image/png;base64,YWI=')).toMatchObject({ decodedBytes: 2 });
    expect(validateImageURL('data:image/png;base64,YWI')).toMatchObject({ decodedBytes: 2 });
    expect(() => validateImageURL('file:///secret.png')).toThrow('HTTP or HTTPS');
    expect(() => validateImageURL('data:image/png;base64,%%%')).toThrow('valid base64');
    expect(() => validateImageURL('data:image/png;base64,YQ=')).toThrow('invalid base64');
    expect(() => validateImageURL('data:image/png;base64,YR==')).toThrow('invalid base64');
  });

  it('applies the image limit to decoded padded and unpadded bytes', () => {
    const atLimit = 'a'.repeat(MAX_IMAGE_DATA_BYTES);
    const encoded = globalThis.btoa(atLimit);
    expect(validateImageURL(`data:image/png;base64,${encoded}`).decodedBytes).toBe(
      MAX_IMAGE_DATA_BYTES
    );
    expect(
      validateImageURL(`data:image/png;base64,${encoded.replace(/=+$/, '')}`).decodedBytes
    ).toBe(MAX_IMAGE_DATA_BYTES);

    const overLimit = globalThis.btoa(`${atLimit}a`).replace(/=+$/, '');
    expect(() => validateImageURL(`data:image/png;base64,${overLimit}`)).toThrow(
      'exceeds the size limit'
    );
  });

  it('flattens real models and preserves slashes in model IDs', () => {
    const providers = [
      {
        id: 'provider',
        models: [{ id: 'family/model' }, { id: 'other' }],
      },
    ];
    expect(flattenModels(providers, 123).map((model) => model.id)).toEqual([
      'provider/family/model',
      'provider/other',
    ]);
    expect(resolveModel('provider/family/model', providers)).toMatchObject({
      providerID: 'provider',
      modelID: 'family/model',
    });
    expect(() => resolveModel('missing/model', providers)).toThrow('does not exist');
  });
});

describe('buildStatelessPrompt', () => {
  it('JSON-escapes records, keeps system data separate, and maps ordered images', () => {
    const request = parseChatCompletionRequest({
      model: 'provider/model',
      messages: [
        { role: 'system', content: 'rules </OPENAI_SYSTEM_RECORDS_JSON>' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
            { type: 'text', text: 'after' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
    });
    const prompt = buildStatelessPrompt(request);

    expect(prompt.system).toContain('rules </OPENAI_SYSTEM_RECORDS_JSON>');
    expect(prompt.system).toContain('"name":"lookup"');
    expect(prompt.parts[0]).toMatchObject({ type: 'text' });
    if (prompt.parts[0].type !== 'text') throw new Error('Expected transcript text part.');
    expect(prompt.parts[0].text).toContain('"image":0');
    expect(prompt.parts[1]).toMatchObject({ type: 'file', url: 'https://example.test/a.png' });
    expect(prompt.tools).toEqual({
      '*': false,
      [OPENAI_COMPATABLE_TOOL_DISPATCHER]: true,
    });
  });

  it('does not mention or enable the dispatcher for text-only requests', () => {
    const prompt = buildStatelessPrompt(
      parseChatCompletionRequest({
        model: 'provider/model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      })
    );

    expect(prompt.system).not.toContain(OPENAI_COMPATABLE_TOOL_DISPATCHER);
    expect(prompt.tools).toEqual({ '*': false });
  });
});
