import z from '@deepseek-ai/schemastery';

/** Editing support policy when the upstream route does not advertise it. */
export type ImageEditingMode = 'auto' | 'on' | 'off';

/**
 * Plugin configuration as it appears in DSH settings. Every field is optional at
 * the boundary because a patch may set only what it cares about; use
 * {@link resolveConfig} to obtain the runtime view.
 */
export interface Config {
  enabled?: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  defaultSize?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  outputDir?: string;
  imageEditing?: ImageEditingMode;
  maxImagesPerRequest?: number;
  maxImageBytes?: number;
  quality?: string;
}

/** Runtime configuration: every field materialized and validated. */
export interface ResolvedConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly defaultSize: string;
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly outputDir: string;
  readonly imageEditing: ImageEditingMode;
  readonly maxImagesPerRequest: number;
  readonly maxImageBytes: number;
  readonly quality: string | undefined;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1';
export const DEFAULT_MODEL = 'gpt-image-2';
export const DEFAULT_SIZE = '1024x1024';
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_OUTPUT_DIR = 'generated-images';
export const DEFAULT_API_KEY_ENV = 'CPA_API_KEY';
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 4;
export const DEFAULT_MAX_IMAGE_BYTES = 24 * 1024 * 1024;

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用 CPA 图片工具'),
  baseUrl: z.string().default(DEFAULT_BASE_URL).description('CLIProxyAPI 的 OpenAI 兼容地址，通常以 /v1 结尾'),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).role('credential-ref')
    .description('存放 CPA 密钥的 DSH 凭据名称（不在此处填写明文密钥）'),
  model: z.string().default(DEFAULT_MODEL).description('默认图片模型 ID'),
  defaultSize: z.string().default(DEFAULT_SIZE).description('默认输出尺寸，例如 1024x1024'),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS).description('单次请求超时（毫秒），超时后不自动重试'),
  maxConcurrent: z.natural().default(DEFAULT_MAX_CONCURRENT).description('同时进行的 CPA 请求上限'),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR).description('图片保存目录，相对路径以会话工作目录为基准'),
  imageEditing: z.union(['auto', 'on', 'off'] as const).default('auto')
    .description('图片编辑：auto 按上游 /models 能力自动判断，on 强制启用，off 关闭'),
  maxImagesPerRequest: z.natural().default(DEFAULT_MAX_IMAGES_PER_REQUEST).description('单次调用最多生成的图片数量'),
  maxImageBytes: z.natural().default(DEFAULT_MAX_IMAGE_BYTES).description('单张图片的字节上限'),
  quality: z.string().default('').description('可选 quality 值；留空表示不向上游传递该字段'),
});

const ALLOWED_SIZES = new Set(['256x256', '512x512', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '2048x2048']);

/** Raised for configuration that cannot be used safely; carries a stable code. */
export class ConfigError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INVALID_CONFIG') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

/**
 * Validate one configured base URL. Only http(s) is accepted and credentials in
 * the URL are rejected, so a misconfigured value cannot silently leak a key.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const value = trimmed(raw) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`baseUrl 不是合法 URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`baseUrl 只支持 http/https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ConfigError('baseUrl 不能包含用户名或密码，请改用凭据配置');
  }
  if (url.search || url.hash) {
    throw new ConfigError('baseUrl 不能包含查询串或锚点');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

/** Reject sizes the plugin will not send; upstream is the authority, this is the local guard. */
export function normalizeSize(raw: string | undefined): string {
  const value = trimmed(raw) ?? DEFAULT_SIZE;
  if (!/^\d{2,5}x\d{2,5}$/.test(value)) {
    throw new ConfigError(`size 必须形如 1024x1024，收到: ${value}`);
  }
  const [width, height] = value.split('x').map(part => Number.parseInt(part, 10)) as [number, number];
  if (width < 64 || height < 64 || width > 8192 || height > 8192) {
    throw new ConfigError(`size 超出允许范围 64..8192: ${value}`);
  }
  if (ALLOWED_SIZES.size > 0 && !ALLOWED_SIZES.has(value)) {
    // Kept as a warning rather than an error: upstream models differ in accepted sizes.
    return value;
  }
  return value;
}

export function supportedSizes(): readonly string[] {
  return [...ALLOWED_SIZES];
}

/** Materialize and validate the runtime view of a patch-supplied config. */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  const source: Config = config ?? {};
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new ConfigError(`timeoutMs 必须是不小于 1000 的有限数值，收到: ${String(source.timeoutMs)}`);
  }
  const maxConcurrent = source.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new ConfigError(`maxConcurrent 必须是 1..8 的整数，收到: ${String(source.maxConcurrent)}`);
  }
  const maxImagesPerRequest = source.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST;
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest < 1 || maxImagesPerRequest > 10) {
    throw new ConfigError(`maxImagesPerRequest 必须是 1..10 的整数，收到: ${String(source.maxImagesPerRequest)}`);
  }
  const maxImageBytes = source.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 64 * 1024) {
    throw new ConfigError(`maxImageBytes 必须是不小于 65536 的整数，收到: ${String(source.maxImageBytes)}`);
  }
  const apiKeyEnv = trimmed(source.apiKeyEnv) ?? DEFAULT_API_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new ConfigError(`apiKeyEnv 必须是环境变量形式的名称，收到: ${apiKeyEnv}`);
  }
  const outputDir = trimmed(source.outputDir) ?? DEFAULT_OUTPUT_DIR;
  return {
    enabled: source.enabled !== false,
    baseUrl: normalizeBaseUrl(source.baseUrl),
    apiKeyEnv,
    model: trimmed(source.model) ?? DEFAULT_MODEL,
    defaultSize: normalizeSize(source.defaultSize),
    timeoutMs,
    maxConcurrent,
    outputDir,
    imageEditing: source.imageEditing ?? 'auto',
    maxImagesPerRequest,
    maxImageBytes,
    quality: trimmed(source.quality),
  };
}
