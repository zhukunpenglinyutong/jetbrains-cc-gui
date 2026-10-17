import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { normalizeBlocks } from './contentBlockNormalize';
import { getContentBlocks } from './messageUtils';

const t = ((key: string) => key) as TFunction;

describe('normalizeBlocks', () => {
  it.each(['', 'Visible native summary'])('preserves native reasoning lifecycle with summary %j', (thinking) => {
    const blocks = normalizeBlocks({ message: { content: [
      { type: 'thinking', thinking, text: thinking, native: true, status: 'completed' },
    ] } }, (text) => text, t);

    expect(blocks).toEqual([{ type: 'thinking', thinking, text: thinking, native: true, status: 'completed' }]);
  });

  it('keeps native reasoning markers when normalized blocks are merged and normalized again', () => {
    const blocks = normalizeBlocks({ message: { content: [
      { type: 'thinking', thinking: '', native: true, status: 'inProgress' },
    ] } }, (text) => text, t);
    const merged = normalizeBlocks({ content: blocks ?? [] }, (text) => text, t);

    expect(merged?.[0]).toMatchObject({ type: 'thinking', native: true, status: 'inProgress' });
  });

  it('leaves ordinary Claude empty thinking blocks unchanged', () => {
    const blocks = normalizeBlocks({ message: { content: [
      { type: 'thinking', thinking: '' },
    ] } }, (text) => text, t);

    expect(blocks).toEqual([{ type: 'thinking', thinking: '', text: '' }]);
  });

  it.each([
    { type: 'image', url: 'data:image/png;base64,fixture', alt: 'Screenshot' },
    { type: 'input_image', image_url: 'data:image/png;base64,fixture', alt: 'Screenshot' },
  ])('normalizes native and legacy image URLs without losing the accessible caption', (image) => {
    const blocks = normalizeBlocks(JSON.parse(JSON.stringify({ type: 'user', message: { content: [image] } })), (text) => text, t);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ type: 'image', src: 'data:image/png;base64,fixture', alt: 'Screenshot' });
  });
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
