import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCodexRunInput } from './message-service.js';

describe('buildCodexRunInput', () => {
  it('keeps image-only turns visually empty while satisfying Codex stdin', () => {
    const input = buildCodexRunInput('', [
      { type: 'local_image', path: 'C:\\temp\\second.png' },
    ]);

    assert.deepEqual(input, [
      { type: 'localImage', path: 'C:\\temp\\second.png' },
    ]);
  });

  it('preserves user text when an image is attached', () => {
    const input = buildCodexRunInput('compare this', [
      { type: 'local_image', path: '/tmp/image.png' },
    ]);

    assert.deepEqual(input, [
      { type: 'text', text: 'compare this' },
      { type: 'localImage', path: '/tmp/image.png' },
    ]);
  });

  it('uses a native text item when no valid image is attached', () => {
    assert.deepEqual(buildCodexRunInput('hello', [{ type: 'local_image', path: '' }]), [
      { type: 'text', text: 'hello' },
    ]);
  });
});
