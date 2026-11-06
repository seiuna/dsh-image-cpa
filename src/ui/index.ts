import { createElement, type ReactNode } from 'react';

/**
 * Client half: a conversation card that shows the generated picture.
 *
 * The shipped Web client only draws an image for a tool named `read_image`, so
 * every other tool falls back to a text-only generic row. Registering a keyed
 * `tool.call.toolview` entry for our two tools, plus the `tool.call.images`
 * child slot that authorizes the gallery, reuses the same stock gallery
 * renderer the built-in image row uses.
 */

export const name = 'dsh-cpa-image-client';

export const inject = ['slots'];

/** The tool names this card owns. */
const TOOL_NAMES = ['cpa_image_generate', 'cpa_image_edit'] as const;

interface ContentPart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attachment?: { readonly attachmentId?: unknown; readonly width?: unknown; readonly height?: unknown };
}

interface ToolBlock {
  readonly content?: unknown;
  readonly meta?: unknown;
  readonly isError?: unknown;
}

interface RowProps {
  readonly block: ToolBlock;
  readonly renderSlot?: (name: string, props: unknown, options?: unknown) => unknown;
  readonly loadImage?: unknown;
}

/** Split a tool result's content into its text and its durable image references. */
export function splitContent(block: ToolBlock): { text: string; images: { attachment: unknown }[] } {
  const parts = Array.isArray(block?.content) ? block.content as ContentPart[] : [];
  let text = '';
  const images: { attachment: unknown }[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      text = text === '' ? part.text : `${text}\n${part.text}`;
    } else if (part.type === 'image' && part.attachment !== undefined) {
      images.push({ attachment: part.attachment });
    }
  }
  return { text, images };
}

/**
 * One card for both tools. Images render through the stock gallery slot; the
 * text keeps the saved paths, sizes, and any partial-failure note.
 */
export function CpaImageRow(props: RowProps) {
  const { images, text } = splitContent(props.block);
  const children: ReactNode[] = [];
  if (images.length > 0 && typeof props.renderSlot === 'function') {
    children.push(props.renderSlot('tool.call.images', {
      images,
      loadImage: props.loadImage,
      align: 'start',
    }) as ReactNode);
  }
  if (text !== '') {
    children.push(createElement('pre', {
      key: 'text',
      style: {
        margin: '4px 0 4px 4px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        font: 'var(--dsw-font-markdown-code-block-small, 12px/1.5 monospace)',
        color: 'var(--dsw-alias-label-secondary)',
        opacity: 0.85,
      },
    }, text));
  }
  if (children.length === 0) return null;
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, children);
}

export function apply(ctx: {
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
}): void {
  for (const toolName of TOOL_NAMES) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: toolName,
      children: { 'tool.call.images': { kind: 'single', scope: 'session' } },
    }, CpaImageRow));
  }
}
