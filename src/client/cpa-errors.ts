/** Failure vocabulary for every CPA call, plus redaction used before any message reaches a log or the model. */

/** Stable failure codes surfaced by the CPA client and the image tools. */
export type CpaErrorCode =
  | 'CONNECT_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'INVALID_JSON'
  | 'UNSUPPORTED_RESPONSE'
  | 'UNSUPPORTED_EDIT'
  | 'BUSY'
  | 'NOT_CONFIGURED'
  | 'DISABLED';

/** One CPA failure with a stable code, an HTTP status when there was one, and a safe hint. */
export class CpaError extends Error {
  readonly code: CpaErrorCode;
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, code: CpaErrorCode, options: { status?: number; hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CpaError';
    this.code = code;
    this.status = options.status;
    this.hint = options.hint;
  }

  /** One-line diagnostic used by the tools and the status tool. */
  describe(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`;
    return `${this.code}${status}: ${this.message}${this.hint === undefined ? '' : `｜${this.hint}`}`;
  }
}

const MAX_UPSTREAM_MESSAGE = 400;

/**
 * Strip anything that could be a credential and shorten the payload. Upstream
 * error bodies are untrusted text: they are echoed only after this pass.
 */
export function redactUpstream(text: string): string {
  const withoutBearer = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***')
    .replace(/\b(sk|ak|gho|ghp|cpa)[-_][A-Za-z0-9]{8,}\b/gi, '$1-***')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***');
  const collapsed = withoutBearer.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_UPSTREAM_MESSAGE ? `${collapsed.slice(0, MAX_UPSTREAM_MESSAGE)}…` : collapsed;
}

/** Pull a human-readable message out of an OpenAI-style error body. */
export function upstreamMessage(bodyText: string): string | undefined {
  if (bodyText.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string') return redactUpstream(error);
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        const code = (error as { code?: unknown }).code;
        const type = (error as { type?: unknown }).type;
        const parts = [message, code, type].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
        if (parts.length > 0) return redactUpstream(parts.join(' '));
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim() !== '') return redactUpstream(message);
    }
  } catch {
    // Non-JSON body: fall through to the raw snippet.
  }
  return redactUpstream(bodyText);
}

/** Whether an upstream body looks like a quota or balance rejection rather than plain rate limiting. */
export function looksLikeQuota(message: string): boolean {
  return /quota|insufficient|balance|billing|exceeded your current|credit|额度|余额|配额/i.test(message);
}

/** Classify one HTTP failure into a routable code with a user-facing hint. */
export function classifyHttpFailure(status: number, bodyText: string): CpaError {
  const message = upstreamMessage(bodyText) ?? `upstream returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new CpaError(`CPA 拒绝了认证：${message}`, 'AUTH', {
      status,
      hint: '检查 DSH 凭据中 CPA 密钥是否正确、是否已过期',
    });
  }
  if (status === 404) {
    return new CpaError(`CPA 找不到请求的接口或模型：${message}`, 'MODEL_NOT_FOUND', {
      status,
      hint: '确认 baseUrl 是否以 /v1 结尾，且模型 ID 存在于 /v1/models',
    });
  }
  if (status === 429) {
    const code: CpaErrorCode = looksLikeQuota(message) ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
    return new CpaError(code === 'QUOTA_EXCEEDED' ? `CPA 报告额度不足：${message}` : `CPA 报告速率限制：${message}`, code, {
      status,
      hint: code === 'QUOTA_EXCEEDED' ? '额度恢复后再试，本工具不会自动重试' : '降低请求频率或并发后再试，本工具不会自动重试',
    });
  }
  if (status === 400 || status === 422) {
    return new CpaError(`CPA 拒绝了请求参数：${message}`, 'UPSTREAM_ERROR', {
      status,
      hint: '该上游可能不支持 size/quality/n 等字段，尝试省略可选参数',
    });
  }
  return new CpaError(`CPA 上游错误 ${status}：${message}`, 'UPSTREAM_ERROR', { status });
}

/** Classify a transport-level throw (DNS, refused connection, TLS, abort). */
export function classifyTransportFailure(error: unknown, baseUrl: string, timedOut: boolean): CpaError {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut) {
    return new CpaError(`CPA 请求超时：${baseUrl}`, 'TIMEOUT', { hint: '确认 CPA 是否在处理；超时后不会自动重试，以免重复消耗额度' });
  }
  if (/abort/i.test(message)) {
    return new CpaError('请求已取消', 'ABORTED', { cause: error });
  }
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  const reason = typeof code === 'string' ? code : message;
  return new CpaError(`无法连接 CPA：${baseUrl}（${redactUpstream(reason)}）`, 'CONNECT_FAILED', {
    hint: '确认 CLIProxyAPI 正在运行，且 baseUrl 与端口正确',
    cause: error,
  });
}
