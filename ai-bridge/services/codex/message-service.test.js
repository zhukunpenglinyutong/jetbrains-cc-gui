import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCodexRunInput } from './message-service.js';

describe('buildCodexRunInput', () => {
  it('keeps image-only turns visually empty while satisfying Codex stdin', () => {
    const input = buildCodexRunInput('', [
      { type: 'local_image', path: 'C:\\temp\\second.png' },
    ]);

    assert.deepEqual(input, [
      { type: 'text', text: '\u2063' },
      { type: 'local_image', path: 'C:\\temp\\second.png' },
    ]);
    assert.equal(input[0].text.includes('analyze'), false);
  });

  it('preserves user text when an image is attached', () => {
    const input = buildCodexRunInput('compare this', [
      { type: 'local_image', path: '/tmp/image.png' },
    ]);

    assert.equal(input[0].text, 'compare this');
  });

  it('uses string input when no valid image is attached', () => {
    assert.equal(buildCodexRunInput('hello', [{ type: 'local_image', path: '' }]), 'hello');
  });
});
