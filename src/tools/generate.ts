import { defineTool } from '@deepseek-ai/dsh-tools';
import { CpaError } from '../client/cpa-errors.js';
import { fromAttachmentJson, imageBlock } from '../image/attachment.js';
import { resolveOutputDir } from '../image/storage.js';
import { normalizeSize } from '../config.js';
import {
  IMAGE_VALUE_SCHEMA,
  describeFailure,
  persistPayloads,
  requireText,
  type ToolRuntime,
} from './shared.js';

const MAX_PROMPT = 8_000;

/**
 * Text-to-image tool. It returns saved files plus attachment references, and
 * renders image blocks so a client that can show them does.
 */
export function createGenerateTool(runtime: ToolRuntime) {
  return defineTool({
    name: 'cpa_image_generate',
    description: [
      '用 CPA 配置的图片模型生成真实图片文件并直接显示在对话中。',
      '当用户要求画图、生成插画/角色/背景/图标/视觉素材，或明确要一张实际图片而不是文字描述时调用。',
      '不要用于：只询问提示词怎么写、只想了解生图原理、只分析已有图片而不修改。',
      '默认使用配置好的模型，不要自行猜测模型名；用户已经说清要画什么时无需再次确认。',
    ].join(''),
    parameters: {
      prompt: { type: 'string', required: true, description: '图片生成提示词，尽量具体描述画面内容与风格' },
      model: { type: 'string', description: '可选：覆盖插件配置的图片模型 ID' },
      size: { type: 'string', description: '可选：输出尺寸，如 1024x1024、1536x1024；默认用插件配置值' },
      n: { type: 'integer', description: '可选：生成张数，默认 1，超过插件上限会被拒绝' },
      quality: { type: 'string', description: '可选：质量档位；仅在上游支持时传递' },
      output_name: { type: 'string', description: '可选：保存文件名（不含目录），不覆盖已有文件' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '是否至少成功保存了一张图片' },
          model: { type: 'string', required: true, description: '实际使用的模型 ID' },
          images: { type: 'array', required: true, items: IMAGE_VALUE_SCHEMA, description: '已保存的图片' },
          revisedPrompt: { type: 'string', description: '上游改写后的提示词（若提供）' },
          note: { type: 'string', description: '部分失败或降级时的说明' },
        },
      },
      render: (args, value) => {
        const lines = [
          `已用 ${value.model} 生成 ${value.images.length} 张图片（尺寸 ${value.images.map(image => `${image.width}x${image.height}`).join('、')}）。`,
          ...value.images.map(image => `已保存原图: ${image.filePath}`),
        ];
        if (value.revisedPrompt) lines.push(`上游改写提示词: ${value.revisedPrompt}`);
        if (value.note) lines.push(`说明: ${value.note}`);
        lines.push(`原始请求: ${args.prompt}`);
        const blocks = [{ type: 'text' as const, text: lines.join('\n') }];
        for (const image of value.images) {
          if (image.attachment) blocks.push(imageBlock(fromAttachmentJson(image.attachment)) as never);
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = requireText(args.prompt, 'prompt', MAX_PROMPT);
      const model = args.model?.trim() || runtime.config.model;
      const size = normalizeSize(args.size ?? runtime.config.defaultSize);
      const requested = args.n ?? 1;
      if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('n 必须是正整数');
      if (requested > runtime.config.maxImagesPerRequest) {
        throw new Error(`n=${requested} 超过插件上限 ${runtime.config.maxImagesPerRequest}；请减少张数或调高 maxImagesPerRequest`);
      }
      const quality = args.quality?.trim() || runtime.config.quality;
      const outputDir = resolveOutputDir(runtime.config.outputDir, runtime.baseDir(exec));

      let result;
      try {
        const client = await runtime.getClient();
        result = await client.generate({ model, prompt, size, n: requested, ...(quality ? { quality } : {}) }, exec.signal);
      } catch (error) {
        throw new Error(describeFailure(error));
      }

      const { images, problems } = await persistPayloads(runtime, result.images, outputDir, args.output_name?.trim());

      if (images.length === 0) {
        const first = problems[0];
        if (first !== undefined) {
          throw new CpaError(`上游返回了 ${result.images.length} 个图片负载，但全部未通过校验：${first}`, 'UNSUPPORTED_RESPONSE');
        }
        throw new CpaError('上游没有返回任何图片', 'UNSUPPORTED_RESPONSE');
      }
      const note = [
        problems.length === 0 ? undefined : `有 ${problems.length} 张图片被拒绝：${problems.join('；')}`,
        requested > images.length ? `请求 ${requested} 张，上游只返回 ${images.length} 张（该 CPA 版本可能忽略 n）` : undefined,
        images.some(image => image.attachment === undefined) ? '部分图片未注册为 DSH 附件，仅保存了文件' : undefined,
      ].filter((part): part is string => part !== undefined).join('；');

      const revisedPrompt = result.images.find(image => image.revisedPrompt !== undefined)?.revisedPrompt;
      return {
        ok: true,
        model: result.model,
        images,
        ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
        ...(note === '' ? {} : { note }),
      };
    },
  });
}
