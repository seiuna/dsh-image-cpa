import { decodeBase64Image, type ImageMediaType } from '../image/validate.js';
import { Semaphore, withTimeout } from '../utils/abort.js';
import { CpaError, classifyHttpFailure, classifyTransportFailure, redactUpstream } from './cpa-errors.js';

/** Minimal fetch surface, injectable for tests. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** One image decoded from an upstream response. */
export interface ImagePayload {
  readonly bytes: Uint8Array;
  readonly declaredMediaType: ImageMediaType | undefined;
  readonly revisedPrompt: string | undefined;
}

/** Result of one generation or edit call. */
export interface ImageCallResult {
  readonly model: string;
  readonly images: readonly ImagePayload[];
}

/** Whether one upstream route answered as mounted, absent, or unreadable. */
export type RouteState = 'supported' | 'missing' | 'unknown' | 'unauthorized';

/** Text-to-image request. */
export interface GenerateRequest {
  readonly model: string;
  readonly prompt: string;
  readonly size: string;
  readonly n: number;
  /** Sent only when the caller explicitly configured a value. */
  readonly quality?: string;
}

/** Reference image bytes for an edit call. */
export interface EditableImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly fileName: string;
}

/** Image-to-image request. */
export interface EditRequest {
  readonly model: string;
  readonly prompt: string;
  readonly image: EditableImage;
  readonly mask?: EditableImage;
  readonly size?: string;
  readonly n?: number;
}

/** Constructor options; every value already normalized by the config layer. */
export interface CpaClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUTS = { models: 15_000 } as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Parse an OpenAI-Images-shaped body. Only inline base64 is accepted: an
 * upstream-supplied URL is never fetched, which keeps the plugin from becoming
 * an SSRF primitive on a model-controlled string.
 */
export function parseImagesBody(bodyText: string, model: string): ImageCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new CpaError(`CPA 返回的不是 JSON：${redactUpstream(bodyText)}`, 'INVALID_JSON', {
      hint: '确认 baseUrl 指向 CPA 的 /v1，而不是一个网页或代理错误页',
    });
  }
  const record = asRecord(parsed);
  if (!record) throw new CpaError('CPA 返回的 JSON 结构无法识别', 'INVALID_JSON');
  const errorField = record['error'];
  if (errorField !== undefined && errorField !== null) {
    const message = asRecord(errorField)?.['message'];
    throw new CpaError(`CPA 返回错误：${typeof message === 'string' ? redactUpstream(message) : '未知错误'}`, 'UPSTREAM_ERROR');
  }
  const data = record['data'];
  if (!Array.isArray(data)) {
    throw new CpaError('CPA 响应缺少 data 数组', 'UNSUPPORTED_RESPONSE', { hint: '该上游可能不是 OpenAI Images 兼容实现' });
  }
  if (data.length === 0) {
    throw new CpaError('CPA 返回了空图片列表，未保存任何文件', 'UNSUPPORTED_RESPONSE');
  }
  const images: ImagePayload[] = [];
  for (const [index, item] of data.entries()) {
    const entry = asRecord(item);
    if (!entry) throw new CpaError(`CPA 响应 data[${index}] 不是对象`, 'UNSUPPORTED_RESPONSE');
    const base64 = entry['b64_json'];
    const url = entry['url'];
    if (typeof base64 === 'string' && base64.length > 0) {
      images.push({
        bytes: decodeBase64Image(base64),
        declaredMediaType: undefined,
        revisedPrompt: typeof entry['revised_prompt'] === 'string' ? entry['revised_prompt'] : undefined,
      });
      continue;
    }
    if (typeof url === 'string' && url.length > 0) {
      throw new CpaError('CPA 返回的是图片 URL，已按 SSRF 防护拒绝自动下载', 'UNSUPPORTED_RESPONSE', {
        hint: '在 CPA 侧使用 response_format=b64_json，或确认该上游支持内联图片',
      });
    }
    throw new CpaError(`CPA 响应 data[${index}] 既没有 b64_json 也没有 url`, 'UNSUPPORTED_RESPONSE');
  }
  return { model, images };
}

/** Parse a `/models` body into the advertised model ids. */
export function parseModelsBody(bodyText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new CpaError(`CPA /models 返回的不是 JSON：${redactUpstream(bodyText)}`, 'INVALID_JSON');
  }
  const record = asRecord(parsed);
  const data = record?.['data'];
  if (!Array.isArray(data)) throw new CpaError('CPA /models 响应缺少 data 数组', 'UNSUPPORTED_RESPONSE');
  const ids: string[] = [];
  for (const item of data) {
    const entry = asRecord(item);
    const id = entry?.['id'];
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}

/**
 * HTTP client for the CLIProxyAPI OpenAI-compatible surface.
 *
 * Every call is single-shot: a timeout or transport failure is reported, never
 * retried, because a silent retry would consume image quota twice. Calls share
 * one semaphore so `maxConcurrent` bounds real upstream load.
 */
export class CpaClient {
  private readonly semaphore: Semaphore;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CpaClientOptions) {
    this.semaphore = new Semaphore(options.maxConcurrent);
    const injected = options.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else {
      const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
      if (!globalFetch) throw new CpaError('当前运行时没有可用的 fetch', 'NOT_CONFIGURED');
      this.fetchImpl = globalFetch;
    }
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** Release queued acquisitions when the plugin unloads. */
  dispose(): void {
    this.semaphore.dispose();
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: 'application/json',
    };
  }

  private async send(pathname: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs = this.options.timeoutMs): Promise<string> {
    const release = await this.semaphore.acquire(signal);
    const deadline = withTimeout(signal, timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl}${pathname}`, { ...init, signal: deadline.signal });
      } catch (error) {
        if (signal?.aborted) throw new CpaError('请求已取消', 'ABORTED', { cause: error });
        throw classifyTransportFailure(error, this.options.baseUrl, deadline.timedOut());
      }
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (error) {
        if (deadline.timedOut()) throw classifyTransportFailure(error, this.options.baseUrl, true);
        throw classifyTransportFailure(error, this.options.baseUrl, false);
      }
      if (!response.ok) throw classifyHttpFailure(response.status, bodyText);
      return bodyText;
    } finally {
      deadline.dispose();
      release();
    }
  }

  /** `POST /images/generations`. */
  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<ImageCallResult> {
    // CLIProxyAPI 0.2.72 reads model/prompt/size/quality only: it has no
    // `response_format` or `n` field, always answers inline base64, and treats a
    // missing model as "use the default". `n` is still sent when above one so a
    // future build can honour it; the caller reports a shortfall honestly.
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      size: request.size,
    };
    if (request.n > 1) body['n'] = request.n;
    if (request.quality !== undefined && request.quality !== '') body['quality'] = request.quality;
    const bodyText = await this.send('/images/generations', {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, signal);
    return parseImagesBody(bodyText, request.model);
  }

  /** `POST /images/edits` as multipart/form-data. */
  async edit(request: EditRequest, signal?: AbortSignal): Promise<ImageCallResult> {
    const form = new FormData();
    form.set('model', request.model);
    form.set('prompt', request.prompt);
    if ((request.n ?? 1) > 1) form.set('n', String(request.n));
    if (request.size !== undefined) form.set('size', request.size);
    form.set('image', new Blob([request.image.bytes], { type: request.image.mediaType }), request.image.fileName);
    if (request.mask) {
      form.set('mask', new Blob([request.mask.bytes], { type: request.mask.mediaType }), request.mask.fileName);
    }
    const bodyText = await this.send('/images/edits', {
      method: 'POST',
      headers: this.headers(),
      body: form,
    }, signal);
    return parseImagesBody(bodyText, request.model);
  }

  /** `GET /models`, used for the model picker and status diagnostics. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const bodyText = await this.send('/models', { method: 'GET', headers: this.headers() }, signal, this.shortTimeoutMs());
    return parseModelsBody(bodyText);
  }

  /** The catalog probe never needs the full generation budget. */
  private shortTimeoutMs(): number {
    return Math.min(this.options.timeoutMs, DEFAULT_TIMEOUTS.models);
  }

  /** Cheap liveness plus catalog probe; never starts a paid generation. */
  async probe(signal?: AbortSignal): Promise<{ models: readonly string[]; latencyMs: number }> {
    const started = Date.now();
    const models = await this.listModels(signal);
    return { models, latencyMs: Date.now() - started };
  }

  /**
   * Ask whether each image route is mounted without spending quota.
   *
   * An empty JSON body only reaches the request validator, so a mounted route
   * answers 400 "prompt is required" and an unmounted one answers 404. No prompt
   * is ever sent, so no probe can turn into a generation.
   */
  async probeRoutes(signal?: AbortSignal): Promise<{ generations: RouteState; edits: RouteState }> {
    return {
      generations: await this.probeRoute('/images/generations', signal),
      edits: await this.probeRoute('/images/edits', signal),
    };
  }

  private async probeRoute(pathname: string, signal?: AbortSignal): Promise<RouteState> {
    try {
      await this.send(pathname, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: '{}',
      }, signal, this.shortTimeoutMs());
      return 'unknown';
    } catch (error) {
      if (!(error instanceof CpaError)) return 'unknown';
      if (error.status === 404) return 'missing';
      if (error.status === 400 || error.status === 415 || error.status === 422) return 'supported';
      if (error.code === 'AUTH') return 'unauthorized';
      return 'unknown';
    }
  }
}
