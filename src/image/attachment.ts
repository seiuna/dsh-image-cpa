import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm';
import type { ImageMediaType } from './validate.js';

/** The slice of `ctx.attachments` this plugin uses. */
export interface AttachmentService {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: ImageMediaType; name?: string }[]): Promise<readonly ImageAttachmentRef[]>;
  imageHostPath(ref: ImageAttachmentRef): string | undefined;
}

/** Plain-JSON mirror of {@link ImageAttachmentRef}, so it can live in a tool value. */
export interface AttachmentRefJson {
  attachmentId: string;
  mediaType: ImageMediaType;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

export function toAttachmentJson(ref: ImageAttachmentRef): AttachmentRefJson {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  };
}

export function fromAttachmentJson(json: AttachmentRefJson): ImageAttachmentRef {
  return {
    attachmentId: json.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: json.mediaType,
    bytes: json.bytes,
    width: json.width,
    height: json.height,
    ...(json.name === undefined ? {} : { name: json.name }),
  };
}

/**
 * Register a generated image with the durable attachment service so the
 * conversation keeps a preview that survives a restart. A missing service is not
 * fatal: the file on disk is still the deliverable.
 */
export async function persistGeneratedImage(
  attachments: AttachmentService | undefined,
  input: { bytes: Uint8Array; mediaType: ImageMediaType; name: string },
): Promise<ImageAttachmentRef | undefined> {
  if (!attachments) return undefined;
  try {
    const [ref] = await attachments.saveImages([{ data: input.bytes, mediaType: input.mediaType, name: input.name }]);
    return ref;
  } catch {
    // Attachment admission can refuse a deployment limit; the saved file remains valid.
    return undefined;
  }
}

/** Build the model- and UI-visible image block for one stored attachment. */
export function imageBlock(ref: ImageAttachmentRef): ContentBlock {
  const block: ImageBlock = { type: 'image', attachment: ref };
  return block;
}

interface UnknownBlock {
  readonly type?: unknown;
  readonly attachment?: { readonly attachmentId?: unknown };
}

interface UnknownMessage {
  readonly content?: unknown;
}

function blocksOf(value: unknown): readonly UnknownBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is UnknownBlock => typeof entry === 'object' && entry !== null);
}

function scanMessages(messages: Iterable<unknown>, attachmentId: string): ImageAttachmentRef | undefined {
  for (const message of messages) {
    const content = (message as UnknownMessage | null)?.content;
    for (const block of blocksOf(content)) {
      if (block.type !== 'image') continue;
      const attachment = block.attachment;
      if (attachment && String(attachment.attachmentId) === attachmentId) {
        return attachment as unknown as ImageAttachmentRef;
      }
    }
  }
  return undefined;
}

/**
 * Resolve one `attachment_id` against the images present in the live session.
 * Only references the conversation already holds are accepted, so a model cannot
 * name an arbitrary internal id it invented.
 */
export function findSessionImage(agent: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  const wanted = attachmentId.trim();
  if (wanted === '') return undefined;
  const candidates = new Set<string>([wanted]);
  if (!wanted.startsWith('sha256:')) candidates.add(`sha256:${wanted}`);
  try {
    const session = (agent as { session?: unknown } | undefined)?.session;
    if (!session) return undefined;
    const surface = (session as { surface?: unknown }).surface;
    const messages = (surface as { messages?: unknown } | undefined)?.messages;
    if (messages instanceof Map) {
      for (const key of candidates) {
        const hit = scanMessages(messages.values() as Iterable<unknown>, key);
        if (hit) return hit;
      }
    }
    const events = (session as { events?: unknown }).events;
    if (Array.isArray(events)) {
      for (const key of candidates) {
        const hit = scanMessages(events as Iterable<unknown>, key);
        if (hit) return hit;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
