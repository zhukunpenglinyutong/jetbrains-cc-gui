import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { normalizeBlocks } from './contentBlockNormalize';
import { getContentBlocks } from './messageUtils';

const t = ((key: string) => key) as TFunction;

describe('normalizeBlocks', () => {
  it('drops the invisible Codex sentinel from image-only user messages', () => {
    const blocks = normalizeBlocks(
      {
        type: 'user',
        message: {
          content: [
            { type: 'image', src: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
            { type: 'text', text: ' \n\u2063\t ' },
          ],
        },
      },
      (text) => text,
      t,
    );

    expect(blocks).toEqual([
      { type: 'image', src: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
    ]);
  });

  it('does not restore the invisible sentinel as fallback text during history replay', () => {
    const message = {
      type: 'user' as const,
      content: '\u2063',
      raw: {
        message: {
          content: [
            { type: 'image' as const, src: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
            { type: 'text' as const, text: '\u2063' },
          ],
        },
      },
    };

    const blocks = getContentBlocks(
      message,
      (raw) => normalizeBlocks(raw, (text) => text, t),
      (text) => text,
    );

    expect(blocks).toEqual([
      { type: 'image', src: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
    ]);
  });
});
