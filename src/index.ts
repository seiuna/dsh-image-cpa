import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { CpaClient } from './client/cpa-client.js';
import { CpaError } from './client/cpa-errors.js';
import { resolveConfig, type Config as ConfigShape } from './config.js';
import type { AttachmentService } from './image/attachment.js';
import { sessionCwd, type ToolRuntime } from './tools/shared.js';
import { createGenerateTool } from './tools/generate.js';
import { createEditTool } from './tools/edit.js';
import { createStatusTool } from './tools/status.js';

export { Config } from './config.js';

/** Plugin id used by the Cordis patch and the profile bundle list. */
export const name = 'dsh-cpa-image';

/** The plugin only needs the tool registry; credentials and attachments are optional seams. */
export const inject = ['tools'];

/** The slice of `ctx.credentials` this plugin reads. */
interface CredentialService {
  resolve(ref: string): Promise<{ value?: string } | undefined>;
}

/** The slice of `ctx.workingDirectory` this plugin reads. */
interface WorkingDirectoryService {
  get(session: unknown): string;
}

function optionalService<T>(ctx: Context, serviceName: string): T | undefined {
  try {
    return (ctx as unknown as { get(name: string): unknown }).get(serviceName) as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the CPA key through the DSH credential service, falling back to the
 * launch environment. The value is never logged, echoed, or returned in a tool
 * result; only its presence is observable.
 */
async function resolveApiKey(ctx: Context, ref: string): Promise<string> {
  const credentials = optionalService<CredentialService>(ctx, 'credentials');
  const hit = await credentials?.resolve(ref).catch(() => undefined);
  const stored = hit?.value;
  const value = typeof stored === 'string' && stored !== '' ? stored : process.env[ref];
  if (!value) {
    throw new CpaError(`找不到 CPA 密钥：凭据 ${ref} 未配置`, 'NOT_CONFIGURED', {
      hint: `在 DSH 设置的凭据中写入 ${ref}，或把它导出到启动环境；本插件不会记录或输出密钥`,
    });
  }
  return value;
}

/**
 * Register the image tools. Registration is transactional: a partial failure
 * rolls back the tools that did register, and the plugin's effect disposer
 * releases them plus any live client when DSH unloads or reloads the plugin.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;

  const attachments = optionalService<AttachmentService>(ctx, 'attachments');
  const workingDirectory = optionalService<WorkingDirectoryService>(ctx, 'workingDirectory');
  let cache: { key: string; client: CpaClient } | undefined;

  const getClient = async (): Promise<CpaClient> => {
    const key = await resolveApiKey(ctx, resolved.apiKeyEnv);
    if (cache?.key === key) return cache.client;
    cache?.client.dispose();
    const client = new CpaClient({
      baseUrl: resolved.baseUrl,
      apiKey: key,
      timeoutMs: resolved.timeoutMs,
      maxConcurrent: resolved.maxConcurrent,
    });
    cache = { key, client };
    return client;
  };

  const runtime: ToolRuntime = {
    config: resolved,
    getClient,
    attachments,
    limits: { maxBytes: resolved.maxImageBytes },
    baseDir: (exec: ToolRunContext | undefined) => {
      try {
        const session = (exec?.agent as { session?: unknown } | undefined)?.session;
        const directory = session === undefined ? undefined : workingDirectory?.get(session);
        if (typeof directory === 'string' && path.isAbsolute(directory)) return directory;
      } catch {
        // Fall back to the header cwd or the host process directory.
      }
      return sessionCwd(exec);
    },
  };

  const disposers: Array<() => void> = [];
  const releaseAll = (): void => {
    for (const release of disposers.splice(0).reverse()) {
      try {
        release();
      } catch {
        // Keep releasing the remaining tools.
      }
    }
  };

  try {
    for (const definition of [createGenerateTool(runtime), createEditTool(runtime), createStatusTool(runtime)]) {
      const release = ctx.tools.register(definition);
      if (typeof release === 'function') disposers.push(release);
    }
  } catch (error) {
    releaseAll();
    throw error;
  }

  ctx.effect(() => () => {
    releaseAll();
    cache?.client.dispose();
    cache = undefined;
  }, 'cpa-image: tools');
}
