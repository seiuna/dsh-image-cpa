import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ResolvedConfig } from '../config.js';
import type { CpaClient, ImagePayload } from '../client/cpa-client.js';
import { toAttachmentJson, persistGeneratedImage, type AttachmentRefJson, type AttachmentService } from '../image/attachment.js';
import { saveGeneratedImage } from '../image/storage.js';
import { inspectImage, type ImageLimits } from '../image/validate.js';

/** Everything a tool needs that is fixed for the lifetime of one plugin load. */
export interface ToolRuntime {
  readonly config: ResolvedConfig;
  /** Resolve the CPA client, materializing the credential on first use. */
  readonly getClient: () => Promise<CpaClient>;
  readonly attachments: AttachmentService | undefined;
  /** Image byte/pixel limits derived from configuration. */
  readonly limits: ImageLimits;
  /** The session's working directory, which anchors a relative output directory. */
  readonly baseDir: (exec: ToolRunContext | undefined) => string;
}

/** One saved image as it appears in a tool's canonical value. */
export interface ImageValue {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly attachment?: AttachmentRefJson;
}

/** JSON Schema fragment mirroring {@link ImageValue}. */
export const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    filePath: { type: 'string', required: true, description: '本机绝对路径' },
    fileName: { type: 'string', required: true, description: '文件名' },
    mimeType: { type: 'string', required: true, description: '实际图片格式' },
    width: { type: 'integer', required: true, description: '真实像素宽度' },
    height: { type: 'integer', required: true, description: '真实像素高度' },
    bytes: { type: 'integer', required: true, description: '文件字节数' },
    attachment: {
      type: 'object',
      additionalProperties: false,
      description: 'DSH 持久附件引用，用于对话内展示与重启后复用',
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: {
          type: 'string',
          required: true,
          enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
  },
} as const;

/**
 * The session workspace, read from the session header when available. This is
 * only the fallback path; the plugin passes a resolver that prefers the live
 * working-directory projection.
 */
export function sessionCwd(exec: ToolRunContext | undefined): string {
  try {
    const session = (exec?.agent as { session?: unknown } | undefined)?.session;
    for (const candidate of [
      (session as { header?: { cwd?: unknown } } | undefined)?.header?.cwd,
      (session as { meta?: { cwd?: unknown } } | undefined)?.meta?.cwd,
    ]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    }
  } catch {
    // Fall through to the process cwd.
  }
  return process.cwd();
}

/** Directories a local reference image may be read from. */
export function authorizedRoots(baseDir: string, outputDir: string): string[] {
  return [...new Set([baseDir, outputDir])];
}

/** Render one failure into a single actionable line for the model. */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const hint = (error as { hint?: unknown }).hint;
    const status = (error as { status?: unknown }).status;
    const parts = [error.message];
    if (typeof code === 'string') parts.push(`code=${code}`);
    if (typeof status === 'number') parts.push(`HTTP ${status}`);
    if (typeof hint === 'string') parts.push(hint);
    return parts.join('｜');
  }
  return String(error);
}

/**
 * Validate, save, and register every returned image payload. A partially
 * successful batch keeps the images that verified and reports the rest, so one
 * bad member never discards good output.
 */
export async function persistPayloads(
  runtime: ToolRuntime,
  payloads: readonly ImagePayload[],
  outputDir: string,
  requestedName?: string,
): Promise<{ images: ImageValue[]; problems: string[] }> {
  const images: ImageValue[] = [];
  const problems: string[] = [];
  for (const payload of payloads) {
    try {
      const facts = inspectImage(payload.bytes, runtime.limits, payload.declaredMediaType);
      const stored = await saveGeneratedImage({
        outputDir,
        bytes: payload.bytes,
        mediaType: facts.mediaType,
        limits: runtime.limits,
        ...(requestedName === undefined || requestedName === '' ? {} : { requestedName }),
      });
      const ref = await persistGeneratedImage(runtime.attachments, {
        bytes: payload.bytes,
        mediaType: stored.mediaType,
        name: stored.fileName,
      });
      images.push({
        filePath: stored.filePath,
        fileName: stored.fileName,
        mimeType: stored.mediaType,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        ...(ref === undefined ? {} : { attachment: toAttachmentJson(ref) }),
      });
    } catch (error) {
      problems.push(describeFailure(error));
    }
  }
  return { images, problems };
}

/** True when a value is a non-empty trimmed string. */
export function requireText(value: string | undefined, label: string, maxLength: number): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} 不能为空`);
  if (text.length > maxLength) throw new Error(`${label} 超过 ${maxLength} 字符上限`);
  return text;
}
