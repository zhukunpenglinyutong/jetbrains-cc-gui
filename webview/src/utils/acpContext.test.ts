import { describe, expect, it } from 'vitest';
import {
  isAcpContextText,
  parseAcpContextText,
  stripAcpContextText,
} from './acpContext';
import { normalizeBlocks } from './contentBlockNormalize';

const ACP_SAMPLE = `Additional ACP context:
[ACP resource_link] ai-chat-attachment-4595349767939345511.png (file:///tmp/ai-chat-attachment-4595349767939345511.png)
[ACP resource_link] ai-chat-attachment-1369146062596565820.png (file:///tmp/ai-chat-attachment-1369146062596565820.png)`;

describe('acpContext', () => {
  it('detects ACP attachment metadata', () => {
    expect(isAcpContextText(ACP_SAMPLE)).toBe(true);
    expect(isAcpContextText('hello')).toBe(false);
  });

  it('parses resource links into image blocks', () => {
    const { textBlocks, resourceBlocks } = parseAcpContextText(ACP_SAMPLE);
    expect(textBlocks).toEqual([]);
    expect(resourceBlocks).toHaveLength(2);
    expect(resourceBlocks[0]).toEqual({
      type: 'image',
      src: 'file:///tmp/ai-chat-attachment-4595349767939345511.png',
      mediaType: 'image/png',
    });
  });

  it('preserves user text around ACP metadata', () => {
    const parsed = parseAcpContextText(`What is in these screenshots?\n\n${ACP_SAMPLE}`);
    expect(parsed.textBlocks).toEqual(['What is in these screenshots?']);
    expect(parsed.resourceBlocks).toHaveLength(2);
    expect(stripAcpContextText(`What is in these screenshots?\n\n${ACP_SAMPLE}`)).toBe(
      'What is in these screenshots?',
    );
  });

  it('normalizes ACP metadata into image blocks instead of raw text', () => {
    const blocks = normalizeBlocks(
      {
        type: 'user',
        message: {
          role: 'user',
          content: ACP_SAMPLE,
        },
      },
      (value) => value,
      ((key: string) => key) as never,
    );

    expect(blocks).toEqual([
      {
        type: 'image',
        src: 'file:///tmp/ai-chat-attachment-4595349767939345511.png',
        mediaType: 'image/png',
      },
      {
        type: 'image',
        src: 'file:///tmp/ai-chat-attachment-1369146062596565820.png',
        mediaType: 'image/png',
      },
    ]);
  });
});
