import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isInside,
  readAuthorizedImage,
  resolveOutputDir,
  sanitizeFileName,
  saveGeneratedImage,
  StorageError,
  uniqueFileName,
} from '../src/image/storage';
import { png1x1 } from './helpers';

const LIMITS = { maxBytes: 1024 * 1024 };
const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cpa-image-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Scratch dirs live under the OS temp root and are left for the OS to reap.
  dirs.length = 0;
});

describe('output directory resolution', () => {
  it('anchors a relative directory at the session workspace', () => {
    expect(resolveOutputDir('generated-images', 'D:\\projects\\demo')).toBe(path.resolve('D:\\projects\\demo', 'generated-images'));
  });

  it('refuses a relative path that escapes the workspace', () => {
    expect(() => resolveOutputDir('..\\secrets', 'D:\\projects\\demo')).toThrowError(StorageError);
  });

  it('accepts an absolute directory', async () => {
    const dir = await scratch();
    expect(resolveOutputDir(dir, 'D:\\projects\\demo')).toBe(path.normalize(dir));
  });

  it('detects containment', () => {
    expect(isInside('C:\\root', 'C:\\root\\a\\b.png')).toBe(true);
    expect(isInside('C:\\root', 'C:\\other\\b.png')).toBe(false);
  });
});

describe('file naming', () => {
  it('neutralizes traversal and separators', () => {
    expect(sanitizeFileName('../../etc/passwd.png', 'image/png')).toBe('passwd.png');
    expect(sanitizeFileName('a\\b/c.png', 'image/png')).toBe('c.png');
  });

  it('rejects a mismatched extension', () => {
    expect(() => sanitizeFileName('photo.jpg', 'image/png')).toThrowError(StorageError);
  });

  it('rejects empty and reserved names', () => {
    expect(() => sanitizeFileName('   ', 'image/png')).toThrowError(StorageError);
    expect(() => sanitizeFileName('con.png', 'image/png')).toThrowError(StorageError);
  });

  it('never reuses an existing name', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'x.png'), 'a');
    expect(await uniqueFileName(dir, 'x.png')).toBe('x-1.png');
  });
});

describe('atomic save', () => {
  it('writes the file and reports the real verified facts', async () => {
    const dir = await scratch();
    const stored = await saveGeneratedImage({
      outputDir: dir,
      bytes: png1x1(),
      mediaType: 'image/png',
      limits: LIMITS,
      requestedName: 'hero',
    });
    expect(stored.fileName).toBe('hero.png');
    expect(stored.width).toBe(1);
    expect((await readFile(stored.filePath)).byteLength).toBe(png1x1().byteLength);
  });

  it('keeps the first image when a second one asks for the same name', async () => {
    const dir = await scratch();
    const first = await saveGeneratedImage({ outputDir: dir, bytes: png1x1(), mediaType: 'image/png', limits: LIMITS, requestedName: 'hero' });
    const second = await saveGeneratedImage({ outputDir: dir, bytes: png1x1(), mediaType: 'image/png', limits: LIMITS, requestedName: 'hero' });
    expect(second.fileName).toBe('hero-1.png');
    expect(second.sha256).toBe(first.sha256);
  });

  it('refuses to write non-image bytes', async () => {
    const dir = await scratch();
    await expect(
      saveGeneratedImage({ outputDir: dir, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', limits: LIMITS }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' });
  });
});

describe('authorized reads', () => {
  it('reads a file inside an authorized root', async () => {
    const root = await scratch();
    const file = path.join(root, 'ref.png');
    await writeFile(file, png1x1());
    const local = await readAuthorizedImage({ filePath: 'ref.png', allowedRoots: [root], limits: LIMITS, baseDir: root });
    expect(local.facts.mediaType).toBe('image/png');
  });

  it('refuses a path outside every authorized root', async () => {
    const root = await scratch();
    const outside = await scratch();
    const file = path.join(outside, 'secret.png');
    await writeFile(file, png1x1());
    await expect(
      readAuthorizedImage({ filePath: file, allowedRoots: [root], limits: LIMITS, baseDir: root }),
    ).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('refuses a traversal that resolves outside the root', async () => {
    const root = await scratch();
    const sibling = path.join(root, '..', 'dsh-cpa-image-escape.png');
    await writeFile(sibling, png1x1()).catch(() => undefined);
    await expect(
      readAuthorizedImage({ filePath: '../dsh-cpa-image-escape.png', allowedRoots: [root], limits: LIMITS, baseDir: root }),
    ).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('refuses a directory and a missing file', async () => {
    const root = await scratch();
    await mkdir(path.join(root, 'nested'));
    await expect(
      readAuthorizedImage({ filePath: 'nested', allowedRoots: [root], limits: LIMITS, baseDir: root }),
    ).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await expect(
      readAuthorizedImage({ filePath: 'nope.png', allowedRoots: [root], limits: LIMITS, baseDir: root }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});
