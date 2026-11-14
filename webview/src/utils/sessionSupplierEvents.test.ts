import { afterEach, expect, it, vi } from 'vitest';
import { installSessionSupplierCallbacks } from './sessionSupplierEvents';

afterEach(() => { delete window.notifySessionSupplierBindingChanged; });

it('dispatches a real binding event through the no-argument Java callback', () => {
  const listener = vi.fn();
  window.addEventListener('session-supplier-binding-changed', listener);
  try {
    installSessionSupplierCallbacks();
    window.notifySessionSupplierBindingChanged?.();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toBeInstanceOf(Event);
  } finally {
    window.removeEventListener('session-supplier-binding-changed', listener);
  }
});
