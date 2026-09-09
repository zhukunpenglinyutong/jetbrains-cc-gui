/**
 * Unit tests for CLI image attachment helpers.
 * Run: node --test utils/cli-image-input.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGrokImageBlocks,
  buildKimiPromptWithImages,
  buildReadPathPromptWithImages,
  estimateBase64DecodedBytes,
  GROK_IMAGE_ONLY_FALLBACK_TEXT,
  KIMI_IMAGE_INJECTION_MARKER,
  normalizeImageMimeType,
  parseAttachmentData,
} from './cli-image-input.js';
import { buildPromptBlocks } from '../services/grok/grok-acp-client.js';

/**
 * buildPromptBlocks reads ~/.grok/grok-rules.md - point HOME at an empty temp
 * dir so assertions are exact instead of machine-dependent.
 */
function withStubbedGrokHome(run) {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const dir = mkdtempSync(join(tmpdir(), 'grok-home-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return run();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1x1 PNG
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('parseAttachmentData', () => {
  it('accepts raw base64', () => {
    const parsed = parseAttachmentData(TINY_PNG_B64);
    assert.ok(parsed);
    assert.equal(parsed.mimeType, null);
    assert.equal(parsed.base64, TINY_PNG_B64);
  });

  it('accepts data URL', () => {
    const parsed = parseAttachmentData(`data:image/png;base64,${TINY_PNG_B64}`);
    assert.ok(parsed);
    assert.equal(parsed.mimeType, 'image/png');
    assert.equal(parsed.base64, TINY_PNG_B64);
  });

  it('rejects empty', () => {
    assert.equal(parseAttachmentData(''), null);
    assert.equal(parseAttachmentData(null), null);
  });
});

describe('buildGrokImageBlocks', () => {
  it('builds ACP image blocks from attachments', () => {
    const { blocks, loaded, errors } = buildGrokImageBlocks([
      { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
    ]);
    assert.equal(loaded, 1);
    assert.equal(errors.length, 0);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].mimeType, 'image/png');
    assert.ok(blocks[0].data.length > 0);
  });

  it('skips non-image attachments', () => {
    const { blocks, loaded } = buildGrokImageBlocks([
      { fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGVsbG8=' },
    ]);
    assert.equal(loaded, 0);
    assert.equal(blocks.length, 0);
  });
});

describe('buildPromptBlocks multimodal', () => {
  it('embeds image blocks alongside text', () => {
    withStubbedGrokHome(() => {
      const blocks = buildPromptBlocks({
        message: 'What is in this image?',
        attachments: [
          { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
        ],
      });
      const text = blocks.find((b) => b.type === 'text');
      assert.ok(text);
      assert.equal(text.text, 'What is in this image?');
      const images = blocks.filter((b) => b.type === 'image');
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, 'image/png');
    });
  });

  it('injects exactly the fallback text for image-only turns', () => {
    withStubbedGrokHome(() => {
      const blocks = buildPromptBlocks({
        message: '',
        attachments: [
          { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
        ],
      });
      const text = blocks.find((b) => b.type === 'text');
      assert.ok(text);
      assert.equal(text.text, GROK_IMAGE_ONLY_FALLBACK_TEXT);
      assert.equal(blocks.filter((b) => b.type === 'image').length, 1);
    });
  });

  it('keeps the fallback ahead of the agentPrompt concat', () => {
    withStubbedGrokHome(() => {
      const blocks = buildPromptBlocks({
        message: '',
        agentPrompt: 'You are a reviewer.',
        attachments: [
          { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
        ],
      });
      const text = blocks.find((b) => b.type === 'text');
      assert.ok(text);
      assert.ok(text.text.startsWith(GROK_IMAGE_ONLY_FALLBACK_TEXT));
      assert.ok(text.text.includes('## Agent Role and Instructions'));
      assert.ok(text.text.includes('You are a reviewer.'));
      assert.equal(blocks.filter((b) => b.type === 'image').length, 1);
    });
  });

  it('does not promise image analysis when every image failed to load', () => {
    withStubbedGrokHome(() => {
      const blocks = buildPromptBlocks({
        message: '',
        attachments: [
          // path-only attachment: cannot be embedded, produces a load error
          { fileName: 'local.png', mediaType: 'image/png', path: '/tmp/local.png' },
        ],
      });
      const text = blocks.find((b) => b.type === 'text');
      assert.ok(text);
      assert.equal(text.text.includes(GROK_IMAGE_ONLY_FALLBACK_TEXT), false);
      assert.ok(text.text.includes('## Attachments'));
      assert.ok(text.text.includes('local.png'));
      assert.equal(blocks.filter((b) => b.type === 'image').length, 0);
    });
  });

  it('does not only list attachment names when image data is present', () => {
    withStubbedGrokHome(() => {
      const blocks = buildPromptBlocks({
        message: 'see',
        attachments: [
          { fileName: 'secret.png', mediaType: 'image/png', data: TINY_PNG_B64 },
        ],
      });
      const text = blocks.find((b) => b.type === 'text')?.text || '';
      assert.equal(text.includes('## Attachments'), false);
      assert.ok(blocks.some((b) => b.type === 'image'));
    });
  });
});

describe('kimi / read-path prompt builders', () => {
  it('kimi injects ReadMediaFile instructions and path tags', () => {
    const prompt = buildKimiPromptWithImages('describe', ['/tmp/a.png']);
    assert.ok(prompt.includes(KIMI_IMAGE_INJECTION_MARKER));
    assert.ok(prompt.includes('ReadMediaFile'));
    assert.ok(prompt.includes('<image path="/tmp/a.png"></image>'));
    assert.ok(prompt.startsWith('describe'));
  });

  it('read-path builder keeps user text and lists paths', () => {
    const prompt = buildReadPathPromptWithImages('hello', ['/tmp/b.png']);
    assert.ok(prompt.includes('/tmp/b.png'));
    assert.ok(prompt.includes('Read tool'));
    assert.ok(prompt.includes('hello'));
  });
});

describe('misc helpers', () => {
  it('normalizeImageMimeType defaults to png', () => {
    assert.equal(normalizeImageMimeType('image/jpeg'), 'image/jpeg');
    assert.equal(normalizeImageMimeType(''), 'image/png');
  });

  it('estimateBase64DecodedBytes handles padding', () => {
    assert.equal(estimateBase64DecodedBytes('YQ=='), 1);
    assert.equal(estimateBase64DecodedBytes('YWI='), 2);
    assert.equal(estimateBase64DecodedBytes('YWJj'), 3);
  });
});
