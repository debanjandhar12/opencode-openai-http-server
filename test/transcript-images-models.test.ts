import { describe, expect, it } from 'bun:test';

import { MAX_IMAGE_DATA_BYTES } from '../src/constants.ts';
import { validateImageURL } from '../src/openai/images.ts';
import { flattenModels, resolveModel } from '../src/openai/models.ts';

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
