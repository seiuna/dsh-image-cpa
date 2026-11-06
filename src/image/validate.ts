import { createHash } from 'node:crypto';

/** Raster formats this plugin accepts from upstream and from local references. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Stable failure codes for image validation. */
export type ImageErrorCode =
  | 'INVALID_BASE64'
  | 'EMPTY_IMAGE_DATA'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'INVALID_IMAGE_DATA'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSIONS_EXCEEDED';

/** Raised when bytes are not a usable image, or exceed the configured limits. */
export class ImageValidationError extends Error {
  readonly code: ImageErrorCode;
  constructor(message: string, code: ImageErrorCode) {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

/** Verified facts about one image's bytes. */
export interface ImageFacts {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** Deployment-side limits applied before anything is written to disk. */
export interface ImageLimits {
  readonly maxBytes: number;
  readonly maxPixels?: number;
  readonly maxDimension?: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_MAX_DIMENSION = 8192;

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function be32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
}

function le16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function le24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function le32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[offset + index]!);
  return out;
}

/**
 * Identify a raster format from its magic bytes. The declared media type is
 * never trusted; this is the authority for what the file actually is.
 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  // IHDR must be the first chunk: 4-byte length, "IHDR", then width/height.
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return undefined;
  const width = be32(bytes, 16);
  const height = be32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = be16(bytes, offset + 2);
    if (length < 2) return undefined;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      const height = be16(bytes, offset + 5);
      const width = be16(bytes, offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function gifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined;
  const width = le16(bytes, 6);
  const height = le16(bytes, 8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return undefined;
    const width = le16(bytes, 26) & 0x3fff;
    const height = le16(bytes, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits = le32(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return undefined;
    const width = le24(bytes, 24) + 1;
    const height = le24(bytes, 27) + 1;
    return { width, height };
  }
  return undefined;
}

/** Read intrinsic pixel dimensions from verified header bytes. */
export function readDimensions(bytes: Uint8Array, mediaType: ImageMediaType): { width: number; height: number } | undefined {
  switch (mediaType) {
    case 'image/png': return pngDimensions(bytes);
    case 'image/jpeg': return jpegDimensions(bytes);
    case 'image/gif': return gifDimensions(bytes);
    case 'image/webp': return webpDimensions(bytes);
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode canonical base64 image data. A `data:` URL prefix is tolerated because
 * some upstreams wrap the payload, but the decoded bytes must round-trip to the
 * same canonical text, so subtly corrupt payloads are rejected rather than
 * written to disk.
 */
export function decodeBase64Image(data: string): Uint8Array {
  const raw = data.trim();
  const withoutPrefix = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const normalized = withoutPrefix.replace(/\s+/g, '');
  if (normalized.length === 0) throw new ImageValidationError('上游返回了空图片数据', 'EMPTY_IMAGE_DATA');
  if (!BASE64_PATTERN.test(normalized)) throw new ImageValidationError('上游返回的图片数据不是合法 base64', 'INVALID_BASE64');
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.byteLength === 0) throw new ImageValidationError('上游返回了空图片数据', 'EMPTY_IMAGE_DATA');
  const canonical = buffer.toString('base64').replace(/=+$/, '');
  if (canonical !== normalized.replace(/=+$/, '')) {
    throw new ImageValidationError('上游返回的 base64 无法无损还原，已拒绝写入', 'INVALID_BASE64');
  }
  return new Uint8Array(buffer);
}

/**
 * Verify one image payload: format from magic bytes, real dimensions from the
 * container header, then the byte, pixel, and dimension limits.
 */
export function inspectImage(bytes: Uint8Array, limits: ImageLimits, expected?: ImageMediaType): ImageFacts {
  if (bytes.byteLength === 0) throw new ImageValidationError('图片数据为空，未保存任何文件', 'EMPTY_IMAGE_DATA');
  if (bytes.byteLength > limits.maxBytes) {
    throw new ImageValidationError(`图片 ${bytes.byteLength} 字节，超过上限 ${limits.maxBytes} 字节`, 'IMAGE_TOO_LARGE');
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw new ImageValidationError('返回内容不是可识别的 PNG/JPEG/WebP/GIF 图片', 'UNSUPPORTED_IMAGE_TYPE');
  if (expected && expected !== mediaType) {
    throw new ImageValidationError(`上游声明 ${expected}，实际字节为 ${mediaType}`, 'INVALID_IMAGE_DATA');
  }
  const dimensions = readDimensions(bytes, mediaType);
  if (!dimensions) throw new ImageValidationError('无法从图片头部读出宽高，文件可能已损坏', 'INVALID_IMAGE_DATA');
  const maxDimension = limits.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxPixels = limits.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    throw new ImageValidationError(`图片尺寸 ${dimensions.width}x${dimensions.height} 超过单边上限 ${maxDimension}`, 'IMAGE_DIMENSIONS_EXCEEDED');
  }
  if (dimensions.width * dimensions.height > maxPixels) {
    throw new ImageValidationError(`图片像素数超过上限 ${maxPixels}`, 'IMAGE_DIMENSIONS_EXCEEDED');
  }
  return {
    mediaType,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Map a media type to the file extension used for saved originals. */
export function extensionFor(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
  }
}
