import type { ClaudeContentBlock } from '../types';

export const ACP_CONTEXT_HEADER = 'Additional ACP context:';

const ACP_RESOURCE_LINK_LINE =
  /^\[ACP resource_link\]\s+(\S+)\s+\(([^)]+)\)\s*$/;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function isAcpContextText(text: string): boolean {
  if (!text) return false;
  return text.includes(ACP_CONTEXT_HEADER) || /\[ACP resource_link\]/m.test(text);
}

function mediaTypeFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function resourceLinkToBlock(fileName: string, uri: string): ClaudeContentBlock {
  const mediaType = mediaTypeFromFileName(fileName);
  const isImage = mediaType.startsWith('image/') || IMAGE_EXTENSIONS.test(fileName);
  if (isImage && (uri.startsWith('file://') || uri.startsWith('data:'))) {
    return { type: 'image', src: uri, mediaType };
  }
  return { type: 'attachment', fileName, mediaType };
}

/**
 * Split JetBrains ACP attachment metadata out of plain-text message content.
 * Returns image/attachment blocks plus any remaining user-visible text.
 */
export function parseAcpContextText(text: string): {
  textBlocks: string[];
  resourceBlocks: ClaudeContentBlock[];
} {
  const textLines: string[] = [];
  const resourceBlocks: ClaudeContentBlock[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ACP_CONTEXT_HEADER) {
      continue;
    }

    const match = trimmed.match(ACP_RESOURCE_LINK_LINE);
    if (match) {
      resourceBlocks.push(resourceLinkToBlock(match[1], match[2].trim()));
      continue;
    }

    textLines.push(line);
  }

  const cleaned = textLines.join('\n').trim();
  return {
    textBlocks: cleaned ? [cleaned] : [],
    resourceBlocks,
  };
}

export function stripAcpContextText(text: string): string {
  if (!isAcpContextText(text)) {
    return text;
  }
  return parseAcpContextText(text).textBlocks.join('\n').trim();
}

export function expandTextWithAcpContext(
  text: string,
  localize: (value: string) => string,
): ClaudeContentBlock[] {
  if (!isAcpContextText(text)) {
    return [{ type: 'text', text: localize(text) }];
  }

  const { textBlocks, resourceBlocks } = parseAcpContextText(text);
  const blocks: ClaudeContentBlock[] = [...resourceBlocks];
  for (const textBlock of textBlocks) {
    if (textBlock.trim()) {
      blocks.push({ type: 'text', text: localize(textBlock) });
    }
  }
  return blocks;
}
