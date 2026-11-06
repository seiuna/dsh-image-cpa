import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRuntime } from '../src/tools/shared';

/** 1x1 PNG, valid signature, IHDR, IDAT and IEND. */
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function png1x1(): Uint8Array {
  return new Uint8Array(Buffer.from(PNG_1X1_BASE64, 'base64'));
}

/** A 2x1 PNG header only, enough for dimension parsing tests. */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Minimal GIF87a header with the given logical screen size. */
export function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(Buffer.from('GIF87a', 'ascii'), 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

/** Options for one recorded fetch call. */
export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch double that answers with the queued responses and records calls. */
export function fakeFetch(responses: Array<() => Response | Promise<Response>>): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses[index++];
      if (!next) throw new Error('unexpected extra fetch call');
      return await next();
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Minimal runtime stub used by the tool tests. */
export function runtimeStub(overrides: Partial<ToolRuntime> & Pick<ToolRuntime, 'getClient'>): ToolRuntime {
  return {
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKeyEnv: 'CPA_API_KEY',
      model: 'gpt-image-2',
      defaultSize: '1024x1024',
      timeoutMs: 180000,
      maxConcurrent: 1,
      outputDir: 'generated-images',
      imageEditing: 'auto',
      maxImagesPerRequest: 4,
      maxImageBytes: 24 * 1024 * 1024,
      quality: undefined,
    },
    attachments: undefined,
    limits: { maxBytes: 24 * 1024 * 1024 },
    baseDir: () => process.cwd(),
    ...overrides,
  };
}

/** Execute a definition directly, with a minimal execution context. */
export async function runTool<A>(definition: ReturnType<typeof defineTool>, args: A, exec: Record<string, unknown> = {}): Promise<unknown> {
  const context = {
    callId: 'call-1',
    name: (definition as unknown as { name: string }).name,
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol('token'),
    rootCallId: 'call-1',
    ...exec,
  };
  return await (definition as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(args, context);
}
