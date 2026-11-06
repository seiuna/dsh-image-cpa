import { defineTool } from '@deepseek-ai/dsh-tools';
import { CpaError } from '../client/cpa-errors.js';
import { resolveOutputDir } from '../image/storage.js';
import { describeFailure, type ToolRuntime } from './shared.js';

/**
 * Diagnostics tool. It only observes: a `/models` read and two empty-body route
 * probes. No prompt is ever sent, so a status call cannot consume image quota.
 */
export function createStatusTool(runtime: ToolRuntime) {
  return defineTool({
    name: 'cpa_image_status',
    description: [
      '检查 CPA 图片能力：服务是否可连接、认证是否可用、当前配置的图片模型、生成与编辑接口是否挂载。',
      '只做只读探测，不会发起收费的生图请求。',
      '用户报告图片生成失败或连不上时调用。',
    ].join(''),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true, description: '插件是否启用' },
          baseUrl: { type: 'string', required: true, description: '当前请求的 CPA 地址' },
          reachable: { type: 'boolean', required: true, description: '/models 是否成功返回' },
          authorized: { type: 'boolean', required: true, description: '认证是否通过' },
          model: { type: 'string', required: true, description: '当前配置的图片模型' },
          modelInCatalog: { type: 'boolean', required: true, description: '/models 是否列出该模型' },
          models: { type: 'array', required: true, items: { type: 'string' }, description: '上游返回的模型 ID（截断）' },
          generations: { type: 'string', required: true, description: '生成接口状态' },
          edits: { type: 'string', required: true, description: '编辑接口状态' },
          imageEditing: { type: 'string', required: true, description: '插件编辑策略 auto/on/off' },
          outputDir: { type: 'string', required: true, description: '图片将保存到的绝对目录' },
          timeoutMs: { type: 'integer', required: true, description: '单次请求超时（毫秒）' },
          maxConcurrent: { type: 'integer', required: true, description: '并发上限' },
          notes: { type: 'array', required: true, items: { type: 'string' }, description: '诊断说明与限制' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `插件启用: ${value.enabled ? '是' : '否'}`,
          `CPA 地址: ${value.baseUrl}`,
          `连接: ${value.reachable ? '可达' : '不可达'}｜认证: ${value.authorized ? '通过' : '未通过'}`,
          `模型: ${value.model}${value.modelInCatalog ? '（在 /models 中）' : '（不在 /models 列表中）'}`,
          `生成接口: ${value.generations}｜编辑接口: ${value.edits}（编辑策略 ${value.imageEditing}）`,
          `输出目录: ${value.outputDir}`,
          `超时: ${value.timeoutMs}ms｜并发上限: ${value.maxConcurrent}`,
          `模型数: ${value.models.length}`,
          ...value.notes.map(note => `说明: ${note}`),
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const baseDir = runtime.baseDir(exec);
      const outputDir = resolveOutputDir(runtime.config.outputDir, baseDir);
      const notes: string[] = [];
      const status = {
        enabled: runtime.config.enabled,
        baseUrl: runtime.config.baseUrl,
        reachable: false,
        authorized: false,
        model: runtime.config.model,
        modelInCatalog: false,
        models: [] as string[],
        generations: 'unknown',
        edits: 'unknown',
        imageEditing: runtime.config.imageEditing,
        outputDir,
        timeoutMs: runtime.config.timeoutMs,
        maxConcurrent: runtime.config.maxConcurrent,
        notes,
      };

      let models: readonly string[] = [];
      try {
        const client = await runtime.getClient();
        models = await client.listModels(exec.signal);
        status.reachable = true;
        status.authorized = true;
        status.models = models.slice(0, 80);
        status.modelInCatalog = models.includes(runtime.config.model);
      } catch (error) {
        if (error instanceof CpaError) {
          const noRequest = error.code === 'CONNECT_FAILED' || error.code === 'TIMEOUT' || error.code === 'NOT_CONFIGURED' || error.code === 'DISABLED';
          status.reachable = !noRequest;
          status.authorized = !noRequest && error.code !== 'AUTH';
        }
        notes.push(describeFailure(error));
        return status;
      }

      if (!status.modelInCatalog) {
        notes.push('/models 未列出当前模型；仅凭列表无法断言能否生图，实际能力以一次真实生成为准');
      }
      if (models.length === 0) notes.push('/models 返回空列表');

      try {
        const client = await runtime.getClient();
        const routes = await client.probeRoutes(exec.signal);
        status.generations = routes.generations;
        status.edits = routes.edits;
        if (routes.generations === 'missing') notes.push('生成接口未挂载：检查 CPA 的 multimedia.disable-image-generation 配置');
        if (routes.edits === 'missing') notes.push('编辑接口未挂载：cpa_image_edit 会明确报告不可用');
      } catch (error) {
        notes.push(`接口探测失败：${describeFailure(error)}`);
      }
      notes.push('状态检查不发送生成请求，因此不会消耗额度；真实可用性以一次生成结果为准');
      return status;
    },
  });
}
