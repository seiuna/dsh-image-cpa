import { describe, expect, it } from 'vitest';
import {
  decodeBase64Image,
  extensionFor,
  ImageValidationError,
  inspectImage,
  readDimensions,
  sniffImageType,
} from '../src/image/validate';
import { gifHeader, png1x1, pngHeader, PNG_1X1_BASE64 } from './helpers';

const LIMITS = { maxBytes: 1024 * 1024 };

describe('image sniffing', () => {
  it('recognizes PNG from magic bytes', () => {
    expect(sniffImageType(png1x1())).toBe('image/png');
  });

  it('recognizes GIF from its signature', () => {
    expect(sniffImageType(gifHeader(3, 4))).toBe('image/gif');
  });

  it('rejects non-image bytes', () => {
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });
});

describe('dimension parsing', () => {
  it('reads real PNG dimensions rather than trusting the request size', () => {
    expect(readDimensions(pngHeader(1312, 1199), 'image/png')).toEqual({ width: 1312, height: 1199 });
  });

  it('reads GIF logical screen dimensions', () => {
    expect(readDimensions(gifHeader(640, 480), 'image/gif')).toEqual({ width: 640, height: 480 });
  });

  it('reports a corrupt PNG header as unreadable', () => {
    const broken = pngHeader(10, 10);
    broken[12] = 0;
    expect(readDimensions(broken, 'image/png')).toBeUndefined();
  });
});

describe('base64 decoding', () => {
  it('decodes canonical base64', () => {
    expect(decodeBase64Image(PNG_1X1_BASE64).byteLength).toBeGreaterThan(50);
  });

  it('accepts a data URL prefix', () => {
    expect(sniffImageType(decodeBase64Image(`data:image/png;base64,${PNG_1X1_BASE64}`))).toBe('image/png');
  });

  it('rejects empty payloads with a stable code', () => {
    expect(() => decodeBase64Image('')).toThrowError(ImageValidationError);
    try {
      decodeBase64Image('');
    } catch (error) {
      expect((error as ImageValidationError).code).toBe('EMPTY_IMAGE_DATA');
    }
  });

  it('rejects non-base64 text', () => {
    try {
      decodeBase64Image('not-an-image!!');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ImageValidationError).code).toBe('INVALID_BASE64');
    }
  });
});

describe('inspectImage limits', () => {
  it('returns verified facts including a digest', () => {
    const facts = inspectImage(png1x1(), LIMITS);
    expect(facts.mediaType).toBe('image/png');
    expect(facts.width).toBe(1);
    expect(facts.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a declared type that contradicts the bytes', () => {
    try {
      inspectImage(png1x1(), LIMITS, 'image/jpeg');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ImageValidationError).code).toBe('INVALID_IMAGE_DATA');
    }
  });

  it('rejects oversized payloads', () => {
    try {
      inspectImage(png1x1(), { maxBytes: 10 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ImageValidationError).code).toBe('IMAGE_TOO_LARGE');
    }
  });

  it('rejects dimensions above the configured ceiling', () => {
    try {
      inspectImage(pngHeader(9000, 10), LIMITS);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ImageValidationError).code).toBe('IMAGE_DIMENSIONS_EXCEEDED');
    }
  });

  it('maps formats to file extensions', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/webp')).toBe('webp');
    expect(extensionFor('image/gif')).toBe('gif');
  });
});
