import { readFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CpaError } from '../client/cpa-errors.js';
import { fromAttachmentJson, findSessionImage, imageBlock, type AttachmentService } from '../image/attachment.js';
import { readAuthorizedImage, resolveOutputDir, type LocalImage } from '../image/storage.js';
import { extensionFor, inspectImage } from '../image/validate.js';
import { normalizeSize } from '../config.js';
import {
  IMAGE_VALUE_SCHEMA,
  authorizedRoots,
  describeFailure,
  persistPayloads,
  requireText,
  type ToolRuntime,
} from './shared.js';

const MAX_PROMPT = 8_000;

/** One resolved reference image plus the file name to send upstream. */
interface EditSource {
  readonly bytes: Uint8Array;
  readonly mediaType: LocalImage['mediaType'];
  readonly facts: LocalImage['facts'];
  readonly fileName: string;
}

async function resolveAttachmentSource(
  runtime: ToolRuntime,
  attachments: AttachmentService | undefined,
  agent: unknown,
  attachmentId: string,
): Promise<EditSource> {
  const ref = findSessionImage(agent, attachmentId);
  if (!ref) {
    throw new CpaError(`当前会话里找不到附件 ${attachmentId}`, 'NOT_CONFIGURED', {
      hint: 'attachment_id 只能引用本会话中已出现过的图片；也可以改用 image_path 指向本地文件',
    });
  }
  if (!attachments) {
    throw new CpaError('当前 DSH 组合没有挂载附件服务，无法按 attachment_id 读取图片', 'NOT_CONFIGURED', {
      hint: '改用 image_path 指向本地文件',
    });
  }
  const hostPath = attachments.imageHostPath(ref);
  if (!hostPath) {
    throw new CpaError('附件服务没有暴露该图片的宿主路径', 'NOT_CONFIGURED', { hint: '改用 image_path 指向本地文件' });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(hostPath);
  } catch (error) {
    throw new CpaError(`读取附件失败：${(error as Error).message}`, 'NOT_CONFIGURED');
  }
  const facts = inspectImage(bytes, runtime.limits, ref.mediaType);
  return { bytes, mediaType: facts.mediaType, facts, fileName: ref.name ?? `reference.${extensionFor(facts.mediaType)}` };
}

/**
 * Image-to-image tool. It reads an authorized local file or a session
 * attachment, posts multipart to `/images/edits`, and reports an explicit
 * unsupported result when the upstream route is absent.
 */
export function createEditTool(runtime: ToolRuntime) {
  return defineTool({
    name: 'cpa_image_edit',
    description: [
      '用 CPA 图片模型按参考图生成新图（改背景、换风格、局部重绘等）。',
      '当用户要求基于已有图片修改、重绘或编辑时调用；prompt 写明要改什么。',
      'image_path 与 attachment_id 至少提供一个：attachment_id 只能引用本会话出现过的图片。',
      '上游不支持编辑时会明确报错，不会返回假图片。',
    ].join(''),
    parameters: {
      prompt: { type: 'string', required: true, description: '编辑要求，例如把背景改成黄昏的海边' },
      image_path: { type: 'string', description: '可选：参考图的本地路径，必须位于工作目录或输出目录内' },
      attachment_id: { type: 'string', description: '可选：当前会话中已出现过的 DSH 图片附件 ID' },
      mask_path: { type: 'string', description: '可选：局部编辑蒙版路径，透明区域为待修改区域' },
      model: { type: 'string', description: '可选：覆盖插件配置的图片模型 ID' },
      size: { type: 'string', description: '可选：目标尺寸，如 1024x1024' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          images: { type: 'array', required: true, items: IMAGE_VALUE_SCHEMA },
          revisedPrompt: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => {
        const lines = [
          `已用 ${value.model} 编辑出 ${value.images.length} 张图片。`,
          ...value.images.map(image => `已保存原图: ${image.filePath}`),
        ];
        if (value.note) lines.push(`说明: ${value.note}`);
        lines.push(`编辑要求: ${args.prompt}`);
        const blocks = [{ type: 'text' as const, text: lines.join('\n') }];
        for (const image of value.images) {
          if (image.attachment) blocks.push(imageBlock(fromAttachmentJson(image.attachment)) as never);
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!runtime.config.enabled) throw new CpaError('图片插件已在配置中关闭', 'DISABLED');
      if (runtime.config.imageEditing === 'off') {
        throw new CpaError('图片编辑已在插件配置中关闭（imageEditing=off）', 'UNSUPPORTED_EDIT');
      }
      const prompt = requireText(args.prompt, 'prompt', MAX_PROMPT);
      const baseDir = runtime.baseDir(exec);
      const outputDir = resolveOutputDir(runtime.config.outputDir, baseDir);
      const roots = authorizedRoots(baseDir, outputDir);
      const model = args.model?.trim() || runtime.config.model;
      const size = args.size === undefined ? runtime.config.defaultSize : normalizeSize(args.size);

      const imagePath = args.image_path?.trim();
      const attachmentId = args.attachment_id?.trim();
      if (!imagePath && !attachmentId) {
        throw new Error('image_path 与 attachment_id 至少提供一个');
      }

      let source: EditSource;
      if (attachmentId) {
        source = await resolveAttachmentSource(runtime, runtime.attachments, exec.agent, attachmentId);
      } else {
        const local = await readAuthorizedImage({ filePath: imagePath!, allowedRoots: roots, limits: runtime.limits, baseDir });
        source = {
          bytes: local.bytes,
          mediaType: local.mediaType,
          facts: local.facts,
          fileName: `reference.${extensionFor(local.mediaType)}`,
        };
      }

      let mask: { bytes: Uint8Array; mediaType: LocalImage['mediaType']; fileName: string } | undefined;
      if (args.mask_path?.trim()) {
        const local = await readAuthorizedImage({
          filePath: args.mask_path.trim(),
          allowedRoots: roots,
          limits: runtime.limits,
          baseDir,
        });
        if (local.facts.width !== source.facts.width || local.facts.height !== source.facts.height) {
          throw new Error(`蒙版尺寸 ${local.facts.width}x${local.facts.height} 与参考图 ${source.facts.width}x${source.facts.height} 不一致`);
        }
        mask = { bytes: local.bytes, mediaType: local.mediaType, fileName: `mask.${extensionFor(local.mediaType)}` };
      }

      let result;
      try {
        const client = await runtime.getClient();
        result = await client.edit({
          model,
          prompt,
          image: { bytes: source.bytes, mediaType: source.mediaType, fileName: source.fileName },
          ...(mask === undefined ? {} : { mask }),
          size,
          n: 1,
        }, exec.signal);
      } catch (error) {
        if (error instanceof CpaError && (error.code === 'MODEL_NOT_FOUND' || error.status === 404)) {
          throw new CpaError(`当前 CPA 没有可用的图片编辑接口：${error.message}`, 'UNSUPPORTED_EDIT', {
            status: error.status,
            hint: '把配置 imageEditing 设为 off，或换用支持 /images/edits 的上游',
          });
        }
        if (error instanceof CpaError && (error.status === 400 || error.status === 415 || error.status === 422)) {
          throw new CpaError(`上游拒绝了图片编辑请求：${error.message}`, 'UNSUPPORTED_EDIT', { status: error.status });
        }
        throw new Error(describeFailure(error));
      }

      const { images, problems } = await persistPayloads(runtime, result.images, outputDir);
      if (images.length === 0) {
        throw new CpaError(`上游返回的编辑结果全部未通过校验：${problems[0] ?? '未知原因'}`, 'UNSUPPORTED_RESPONSE');
      }
      const note = problems.length === 0 ? '' : `有 ${problems.length} 张被拒绝：${problems.join('；')}`;
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
