import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { extensionFor, inspectImage, type ImageFacts, type ImageLimits, type ImageMediaType } from './validate.js';

/** Stable failure codes for anything touching the filesystem. */
export type StorageErrorCode =
  | 'PATH_DENIED'
  | 'PATH_INVALID'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'FILE_TOO_LARGE'
  | 'WRITE_FAILED'
  | 'READ_FAILED';

/** Raised when a path or file operation must be refused. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(message: string, code: StorageErrorCode) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** One image written to disk, plus its verified facts. */
export interface StoredImage {
  readonly filePath: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** A local reference image read from an authorized path. */
export interface LocalImage {
  readonly filePath: string;
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
  readonly facts: ImageFacts;
}

const MAX_NAME_LENGTH = 80;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Resolve the configured output directory to an absolute path. A relative
 * `outputDir` is anchored at `baseDir` (the session workspace), never at the
 * DSH process' own cwd, so images land beside the user's project.
 */
export function resolveOutputDir(outputDir: string, baseDir: string): string {
  if (path.isAbsolute(outputDir)) return path.normalize(outputDir);
  const base = path.resolve(baseDir);
  const target = path.resolve(base, outputDir);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorageError(`outputDir 必须位于工作目录内: ${outputDir}`, 'PATH_DENIED');
  }
  return target;
}

/**
 * Reduce a model-supplied name to a safe leaf file name. Separators, control
 * characters, Windows device names, and traversal sequences cannot survive.
 */
export function sanitizeFileName(name: string, mediaType: ImageMediaType): string {
  const raw = name.trim();
  if (raw === '') throw new StorageError('output_name 不能为空', 'PATH_INVALID');
  const leaf = path.basename(raw.replace(/\\/g, '/')).normalize('NFKC');
  const dotExtension = path.extname(leaf);
  const stemCandidate = dotExtension ? leaf.slice(0, -dotExtension.length) : leaf;
  const stem = stemCandidate
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, MAX_NAME_LENGTH);
  if (stem === '' || stem === '.' || stem === '..' || WINDOWS_RESERVED.test(stem)) {
    throw new StorageError(`output_name 无法安全使用: ${name}`, 'PATH_INVALID');
  }
  const requested = dotExtension.slice(1).toLowerCase();
  const actual = extensionFor(mediaType);
  if (requested !== '' && requested !== actual && !(actual === 'jpg' && requested === 'jpeg')) {
    throw new StorageError(`output_name 扩展名 .${requested} 与实际格式 ${actual} 不一致`, 'PATH_INVALID');
  }
  return `${stem}.${actual}`;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/**
 * Pick a file name that cannot collide with an existing file. The requested
 * name is preserved when free; otherwise a counter is appended, so an existing
 * image is never overwritten.
 */
export async function uniqueFileName(dir: string, wanted: string): Promise<string> {
  const extension = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = attempt === 0 ? wanted : `${stem}-${attempt}${extension}`;
    try {
      await stat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  return `${stem}-${randomSuffix()}${extension}`;
}

/** Write bytes atomically: a temp sibling first, then a single rename. */
async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${randomSuffix()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw new StorageError(`写入临时文件失败: ${(error as Error).message}`, 'WRITE_FAILED');
  }
  await handle.close();
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new StorageError(`保存图片失败: ${(error as Error).message}`, 'WRITE_FAILED');
  }
}

/**
 * Persist one generated image under `outputDir`. The bytes are validated first,
 * so a non-image response can never create a file.
 */
export async function saveGeneratedImage(options: {
  readonly outputDir: string;
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly limits: ImageLimits;
  readonly requestedName?: string;
}): Promise<StoredImage> {
  const facts = inspectImage(options.bytes, options.limits, options.mediaType);
  const root = path.resolve(options.outputDir);
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw new StorageError(`无法创建输出目录 ${root}: ${(error as Error).message}`, 'WRITE_FAILED');
  }
  const requested = options.requestedName === undefined
    ? undefined
    : sanitizeFileName(options.requestedName, facts.mediaType);
  const wanted = requested ?? `${timestamp()}-${randomSuffix()}.${extensionFor(facts.mediaType)}`;
  const fileName = await uniqueFileName(root, wanted);
  const filePath = path.join(root, fileName);
  const resolvedRoot = await realpath(root);
  if (!isInside(resolvedRoot, filePath)) {
    throw new StorageError(`拒绝写入输出目录之外的路径: ${filePath}`, 'PATH_DENIED');
  }
  await writeAtomic(filePath, options.bytes);
  return {
    filePath,
    fileName,
    relativePath: path.relative(path.dirname(resolvedRoot), filePath),
    mediaType: facts.mediaType,
    width: facts.width,
    height: facts.height,
    bytes: facts.bytes,
    sha256: facts.sha256,
  };
}

/** Whether `target` is the same path as, or below, `root`. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Read one local reference image after proving the path stays inside an
 * authorized root. Symlinks are resolved first, so a link that escapes the root
 * is refused even though its own path looks safe.
 */
export async function readAuthorizedImage(options: {
  readonly filePath: string;
  readonly allowedRoots: readonly string[];
  readonly limits: ImageLimits;
  readonly baseDir: string;
}): Promise<LocalImage> {
  const expanded = path.isAbsolute(options.filePath)
    ? options.filePath
    : path.resolve(path.resolve(options.baseDir), options.filePath);
  let resolved: string;
  try {
    resolved = await realpath(expanded);
  } catch {
    throw new StorageError(`读取不到参考图: ${expanded}`, 'FILE_NOT_FOUND');
  }
  const roots = await Promise.all(options.allowedRoots.map(async root => {
    try {
      return await realpath(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  }));
  if (!roots.some(root => isInside(root, resolved))) {
    throw new StorageError(`参考图不在授权目录内: ${resolved}`, 'PATH_DENIED');
  }
  const info = await stat(resolved).catch(() => undefined);
  if (!info) throw new StorageError(`读取不到参考图: ${resolved}`, 'FILE_NOT_FOUND');
  if (!info.isFile()) throw new StorageError(`参考图不是普通文件: ${resolved}`, 'NOT_A_FILE');
  if (info.size > options.limits.maxBytes) {
    throw new StorageError(`参考图 ${info.size} 字节，超过上限 ${options.limits.maxBytes} 字节`, 'FILE_TOO_LARGE');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolved);
  } catch (error) {
    throw new StorageError(`读取参考图失败: ${(error as Error).message}`, 'READ_FAILED');
  }
  const facts = inspectImage(bytes, options.limits);
  return { filePath: resolved, mediaType: facts.mediaType, bytes, facts };
}
