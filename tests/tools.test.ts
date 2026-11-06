import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CpaClient } from '../src/client/cpa-client';
import { createEditTool } from '../src/tools/edit';
import { createGenerateTool } from '../src/tools/generate';
import { createStatusTool } from '../src/tools/status';
import { png1x1, runTool, runtimeStub } from './helpers';

async function workDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'dsh-cpa-tools-'));
}

function clientStub(overrides: Partial<Record<keyof CpaClient, unknown>>): CpaClient {
  return overrides as unknown as CpaClient;
}

describe('cpa_image_generate', () => {
  it('saves the image and renders an image block', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        generate: async () => ({ model: 'gpt-image-2', images: [{ bytes: png1x1(), declaredMediaType: undefined, revisedPrompt: undefined }] }),
      }),
    }));
    const value = await runTool(tool, { prompt: 'a cat' }) as { ok: boolean; images: { filePath: string; width: number }[] };
    expect(value.ok).toBe(true);
    expect(value.images).toHaveLength(1);
    expect(value.images[0]!.width).toBe(1);
    expect(path.dirname(value.images[0]!.filePath)).toBe(path.resolve(dir, 'generated-images'));

    const render = (tool as unknown as { output: { render: (a: unknown, v: unknown) => { type: string }[] } }).output.render;
    const blocks = render({ prompt: 'a cat' }, value);
    expect(blocks.some(block => block.type === 'text')).toBe(true);
    expect(blocks.some(block => block.type === 'image')).toBe(false);
  });

  it('renders an image block when the attachment service accepted the image', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({
      baseDir: () => dir,
      attachments: {
        saveImages: async () => [{
          attachmentId: 'sha256:abc' as never,
          mediaType: 'image/png',
          bytes: 100,
          width: 1,
          height: 1,
          name: 'x.png',
        }],
        imageHostPath: () => undefined,
      },
      getClient: async () => clientStub({
        generate: async () => ({ model: 'gpt-image-2', images: [{ bytes: png1x1(), declaredMediaType: undefined, revisedPrompt: undefined }] }),
      }),
    }));
    const value = await runTool(tool, { prompt: 'a cat' }) as { images: { attachment?: { attachmentId: string } }[] };
    expect(value.images[0]!.attachment?.attachmentId).toBe('sha256:abc');
    const render = (tool as unknown as { output: { render: (a: unknown, v: unknown) => { type: string }[] } }).output.render;
    const blocks = render({ prompt: 'a cat' }, value);
    expect(blocks.filter(block => block.type === 'image')).toHaveLength(1);
  });

  it('rejects a request above the configured image count', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({ baseDir: () => dir, getClient: async () => clientStub({}) }));
    await expect(runTool(tool, { prompt: 'a cat', n: 9 })).rejects.toThrow(/上限/);
  });

  it('rejects an empty prompt', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({ baseDir: () => dir, getClient: async () => clientStub({}) }));
    await expect(runTool(tool, { prompt: '   ' })).rejects.toThrow(/prompt 不能为空/);
  });

  it('reports an upstream failure with its code instead of a fake image', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        generate: async () => {
          const { CpaError } = await import('../src/client/cpa-errors');
          throw new CpaError('无法连接 CPA', 'CONNECT_FAILED', { hint: '确认 CLIProxyAPI 正在运行' });
        },
      }),
    }));
    await expect(runTool(tool, { prompt: 'a cat' })).rejects.toThrow(/CONNECT_FAILED/);
  });

  it('refuses to write when every returned payload is not an image', async () => {
    const dir = await workDir();
    const tool = createGenerateTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        generate: async () => ({ model: 'gpt-image-2', images: [{ bytes: new Uint8Array([0, 1, 2]), declaredMediaType: undefined, revisedPrompt: undefined }] }),
      }),
    }));
    await expect(runTool(tool, { prompt: 'a cat' })).rejects.toThrow(/未通过校验/);
  });
});

describe('cpa_image_edit', () => {
  it('refuses when editing is switched off', async () => {
    const dir = await workDir();
    const tool = createEditTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({}),
      config: { ...runtimeStub({ getClient: async () => clientStub({}) }).config, imageEditing: 'off' },
    }));
    await expect(runTool(tool, { prompt: 'blue', image_path: 'x.png' })).rejects.toThrow(/imageEditing=off/);
  });

  it('requires one image source', async () => {
    const dir = await workDir();
    const tool = createEditTool(runtimeStub({ baseDir: () => dir, getClient: async () => clientStub({}) }));
    await expect(runTool(tool, { prompt: 'blue' })).rejects.toThrow(/至少提供一个/);
  });

  it('uploads the reference image as multipart and returns the new file', async () => {
    const dir = await workDir();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'generated-images'), { recursive: true });
    await writeFile(path.join(dir, 'ref.png'), png1x1());
    let seen: unknown;
    const tool = createEditTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        edit: async (request: unknown) => {
          seen = request;
          return { model: 'gpt-image-2', images: [{ bytes: png1x1(), declaredMediaType: undefined, revisedPrompt: undefined }] };
        },
      }),
    }));
    const value = await runTool(tool, { prompt: 'make it blue', image_path: 'ref.png' }) as { ok: boolean; images: unknown[] };
    expect(value.ok).toBe(true);
    expect(value.images).toHaveLength(1);
    const request = seen as { image: { fileName: string; mediaType: string }; prompt: string };
    expect(request.prompt).toBe('make it blue');
    expect(request.image.mediaType).toBe('image/png');
    expect(request.image.fileName).toBe('reference.png');
  });

  it('reports an unsupported edit route explicitly', async () => {
    const dir = await workDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'ref.png'), png1x1());
    const tool = createEditTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        edit: async () => {
          const { CpaError } = await import('../src/client/cpa-errors');
          throw new CpaError('not found', 'MODEL_NOT_FOUND', { status: 404 });
        },
      }),
    }));
    await expect(runTool(tool, { prompt: 'blue', image_path: 'ref.png' })).rejects.toThrow(/没有可用的图片编辑接口/);
  });
});

describe('cpa_image_status', () => {
  it('reports connectivity, catalog membership, and route support without generating', async () => {
    const dir = await workDir();
    let generated = 0;
    const tool = createStatusTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => clientStub({
        listModels: async () => ['gpt-image-2', 'gpt-6.1-sol'],
        probeRoutes: async () => ({ generations: 'supported', edits: 'supported' }),
        generate: async () => {
          generated += 1;
          throw new Error('status must never generate');
        },
      }),
    }));
    const value = await runTool(tool, {}) as { reachable: boolean; modelInCatalog: boolean; generations: string };
    expect(value.reachable).toBe(true);
    expect(value.modelInCatalog).toBe(true);
    expect(value.generations).toBe('supported');
    expect(generated).toBe(0);
  });

  it('reports an unreachable CPA without throwing', async () => {
    const dir = await workDir();
    const tool = createStatusTool(runtimeStub({
      baseDir: () => dir,
      getClient: async () => {
        const { CpaError } = await import('../src/client/cpa-errors');
        throw new CpaError('无法连接 CPA', 'CONNECT_FAILED');
      },
    }));
    const value = await runTool(tool, {}) as { reachable: boolean; authorized: boolean; notes: string[] };
    expect(value.reachable).toBe(false);
    expect(value.authorized).toBe(false);
    expect(value.notes.join(' ')).toContain('CONNECT_FAILED');
  });
});
