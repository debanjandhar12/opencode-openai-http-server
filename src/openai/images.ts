import { MAX_IMAGE_DATA_BYTES } from '../constants.ts';
import { ProtocolError } from '../errors.ts';
import type { ImageURLContentPart } from './types.ts';

export interface ValidatedImage {
  url: string;
  mime: string;
  source: 'remote' | 'data';
  decodedBytes?: number;
}

export interface OpenCodeFilePart {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
}

const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i;
const BASE64_PATTERN = /^[a-z0-9+/]+={0,2}$/i;

export function validateImageURL(url: string): ValidatedImage {
  if (url.startsWith('data:')) return validateDataImage(url);

  let parsed: InstanceType<typeof globalThis.URL>;
  try {
    parsed = new globalThis.URL(url);
  } catch {
    throw new ProtocolError(400, 'invalid_image', 'Image URL is not valid.', 'messages');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProtocolError(400, 'invalid_image', 'Image URL must use HTTP or HTTPS.', 'messages');
  }

  return { url, mime: 'image/*', source: 'remote' };
}

function validateDataImage(url: string): ValidatedImage {
  const match = DATA_IMAGE_PATTERN.exec(url);
  if (!match) {
    throw new ProtocolError(
      400,
      'invalid_image',
      'Image data URL must contain an image MIME type and valid base64 data.',
      'messages'
    );
  }

  const encoded = match[2];
  const unpadded = encoded.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  const expectedPadding = remainder === 2 ? 2 : remainder === 3 ? 1 : 0;
  const actualPadding = encoded.length - unpadded.length;
  if (
    !BASE64_PATTERN.test(encoded) ||
    remainder === 1 ||
    (actualPadding !== 0 && actualPadding !== expectedPadding)
  ) {
    throw new ProtocolError(400, 'invalid_image', 'Image data URL has invalid base64.', 'messages');
  }

  const decodedBytes = Math.floor((unpadded.length * 3) / 4);
  if (decodedBytes > MAX_IMAGE_DATA_BYTES) {
    throw new ProtocolError(400, 'invalid_image', 'Image data exceeds the size limit.', 'messages');
  }

  const padded = unpadded + '='.repeat(expectedPadding);
  let decoded: string;
  try {
    decoded = globalThis.atob(padded);
  } catch {
    throw new ProtocolError(400, 'invalid_image', 'Image data URL has invalid base64.', 'messages');
  }
  if (decoded.length !== decodedBytes || globalThis.btoa(decoded).replace(/=+$/, '') !== unpadded) {
    throw new ProtocolError(400, 'invalid_image', 'Image data URL has invalid base64.', 'messages');
  }

  return { url, mime: match[1].toLowerCase(), source: 'data', decodedBytes };
}

export function imagePartToOpenCode(part: ImageURLContentPart, index: number): OpenCodeFilePart {
  const image = validateImageURL(part.imageUrl.url);
  return {
    type: 'file',
    mime: image.mime,
    url: image.url,
    filename: `image-${index + 1}`,
  };
}
