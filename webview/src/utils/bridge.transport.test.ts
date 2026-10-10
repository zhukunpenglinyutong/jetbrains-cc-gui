import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBridgeEvent, undoFileChanges } from './bridge';

const originalBridge = window.sendToJava;
afterEach(() => { window.sendToJava = originalBridge; });

describe('local bridge dispatch', () => {
  it('reports refused undo dispatches without changing the shared bridge contract', () => {
    window.sendToJava = undefined;
    expect(undoFileChanges('/fixture.ts', 'M', [])).toBe(false);
    const received = vi.fn();
    window.sendToJava = received;
    expect(undoFileChanges('/fixture.ts', 'M', [])).toBe(true);
    expect(received).toHaveBeenCalledWith('undo_file_changes:{"filePath":"/fixture.ts","status":"M","operations":[]}');
  });
  it('turns a native bridge exception into a refused dispatch so the caller can retry', () => {
    window.sendToJava = vi.fn(() => { throw new Error('fixture unavailable'); });
    expect(sendBridgeEvent('codex_interaction_response', 'decision')).toBe(false);
    const restored = vi.fn();
    window.sendToJava = restored;
    expect(sendBridgeEvent('codex_interaction_response', 'decision')).toBe(true);
    expect(restored).toHaveBeenCalledWith('codex_interaction_response:decision');
  });
});
