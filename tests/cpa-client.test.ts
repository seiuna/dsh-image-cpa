import { describe, expect, it } from 'vitest';
import { CpaClient, parseImagesBody, parseModelsBody } from '../src/client/cpa-client';
import { CpaError, redactUpstream } from '../src/client/cpa-errors';
import { fakeFetch, jsonResponse, PNG_1X1_BASE64 } from './helpers';

const BASE = 'http://127.0.0.1:8317/v1';

function clientWith(responses: Array<() => Response | Promise<Response>>, timeoutMs = 5_000): { client: CpaClient; calls: ReturnType<typeof fakeFetch>['calls'] } {
  const fake = fakeFetch(responses);
  const client = new CpaClient({
    baseUrl: BASE,
    apiKey: 'sk-test-key',
    timeoutMs,
    maxConcurrent: 1,
    fetchImpl: fake.fetch,
  });
  return { client, calls: fake.calls };
}

describe('request construction', () => {
  it('posts to /images/generations with a Bearer token and the documented fields', async () => {
    const { client, calls } = clientWith([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] })]);
    await client.generate({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024', n: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/images/generations`);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024' });
  });

  it('omits quality and n unless they are meaningful', async () => {
    const { client, calls } = clientWith([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] })]);
    await client.generate({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024', n: 2, quality: 'high' });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body['n']).toBe(2);
    expect(body['quality']).toBe('high');
    expect(body['response_format']).toBeUndefined();
  });

  it('sends multipart form data for edits', async () => {
    const { client, calls } = clientWith([() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] })]);
    await client.edit({
      model: 'gpt-image-2',
      prompt: 'make it blue',
      image: { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', fileName: 'ref.png' },
      size: '1024x1024',
    });
    expect(calls[0]!.url).toBe(`${BASE}/images/edits`);
    const body = calls[0]!.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect(form.get('prompt')).toBe('make it blue');
    expect(form.get('image')).toBeInstanceOf(Blob);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('lists models from the catalog endpoint', async () => {
    const { client, calls } = clientWith([() => jsonResponse({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-6.1-sol' }] })]);
    await expect(client.listModels()).resolves.toEqual(['gpt-image-2', 'gpt-6.1-sol']);
    expect(calls[0]!.url).toBe(`${BASE}/models`);
  });
});

describe('response parsing', () => {
  it('decodes inline base64 images', () => {
    const result = parseImagesBody(JSON.stringify({ data: [{ b64_json: PNG_1X1_BASE64, revised_prompt: 'better' }] }), 'gpt-image-2');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.bytes.byteLength).toBeGreaterThan(50);
    expect(result.images[0]!.revisedPrompt).toBe('better');
  });

  it('refuses an upstream URL instead of fetching it', () => {
    try {
      parseImagesBody(JSON.stringify({ data: [{ url: 'http://169.254.169.254/latest' }] }), 'gpt-image-2');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CpaError).code).toBe('UNSUPPORTED_RESPONSE');
    }
  });

  it('reports an empty data array rather than writing nothing', () => {
    try {
      parseImagesBody(JSON.stringify({ data: [] }), 'gpt-image-2');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CpaError).code).toBe('UNSUPPORTED_RESPONSE');
    }
  });

  it('reports non-JSON bodies', () => {
    try {
      parseImagesBody('<html>proxy error</html>', 'gpt-image-2');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CpaError).code).toBe('INVALID_JSON');
    }
  });

  it('surfaces an error object body', () => {
    try {
      parseImagesBody(JSON.stringify({ error: { message: 'boom' } }), 'gpt-image-2');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CpaError).code).toBe('UPSTREAM_ERROR');
    }
  });

  it('parses the model catalog', () => {
    expect(parseModelsBody(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { nope: 1 }] }))).toEqual(['a', 'b']);
  });
});

describe('HTTP failure mapping', () => {
  it('maps 401 to AUTH without echoing the key', async () => {
    const { client } = clientWith([() => jsonResponse({ error: 'Missing API key' }, 401)]);
    await expect(client.listModels()).rejects.toMatchObject({ code: 'AUTH', status: 401 });
  });

  it('maps 404 to MODEL_NOT_FOUND', async () => {
    const { client } = clientWith([() => jsonResponse({ error: { message: 'Model x is not supported' } }, 404)]);
    await expect(client.generate({ model: 'x', prompt: 'p', size: '1024x1024', n: 1 })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      status: 404,
    });
  });

  it('distinguishes quota from plain rate limiting', async () => {
    const quota = clientWith([() => jsonResponse({ error: { message: 'insufficient quota' } }, 429)]);
    await expect(quota.client.listModels()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const rate = clientWith([() => jsonResponse({ error: { message: 'too many requests' } }, 429)]);
    await expect(rate.client.listModels()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps 500 to UPSTREAM_ERROR', async () => {
    const { client } = clientWith([() => jsonResponse({ error: { message: 'internal' } }, 500)]);
    await expect(client.listModels()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', status: 500 });
  });

  it('maps a refused connection to CONNECT_FAILED with the base URL', async () => {
    const fake = fakeFetch([() => Promise.reject(new TypeError('fetch failed'))]);
    const client = new CpaClient({
      baseUrl: BASE,
      apiKey: 'sk-test-key',
      timeoutMs: 2_000,
      maxConcurrent: 1,
      fetchImpl: fake.fetch,
    });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    await expect(client.listModels()).rejects.toThrow(BASE);
  });
});

describe('cancellation', () => {
  it('aborts on the deadline and reports TIMEOUT without retrying', async () => {
    let attempts = 0;
    const fake = fakeFetch([
      () => new Promise<Response>((_, reject) => {
        attempts += 1;
        setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 200);
      }),
    ]);
    const client = new CpaClient({
      baseUrl: BASE,
      apiKey: 'sk-test-key',
      timeoutMs: 30,
      maxConcurrent: 1,
      fetchImpl: fake.fetch,
    });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(attempts).toBe(1);
  });

  it('reports ABORTED when the caller cancels', async () => {
    const controller = new AbortController();
    const fake = fakeFetch([
      () => new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 200);
      }),
    ]);
    const client = new CpaClient({
      baseUrl: BASE,
      apiKey: 'sk-test-key',
      timeoutMs: 5_000,
      maxConcurrent: 1,
      fetchImpl: fake.fetch,
    });
    const pending = client.listModels(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('route probing', () => {
  it('treats a 400 prompt-required answer as a mounted route', async () => {
    const { client } = clientWith([
      () => jsonResponse({ error: { message: 'Invalid request: prompt is required' } }, 400),
      () => jsonResponse({ error: { message: 'Invalid request: prompt is required' } }, 400),
    ]);
    await expect(client.probeRoutes()).resolves.toEqual({ generations: 'supported', edits: 'supported' });
  });

  it('treats a 404 as a missing route', async () => {
    const { client } = clientWith([
      () => new Response('', { status: 404 }),
      () => new Response('', { status: 404 }),
    ]);
    await expect(client.probeRoutes()).resolves.toEqual({ generations: 'missing', edits: 'missing' });
  });
});

describe('redaction', () => {
  it('strips bearer tokens and api keys from upstream text', () => {
    const text = redactUpstream('Authorization: Bearer sk-abcdef123456789 and "api_key": "sk-live-123"');
    expect(text).not.toContain('abcdef123456789');
    expect(text).not.toContain('sk-live-123');
  });
});
