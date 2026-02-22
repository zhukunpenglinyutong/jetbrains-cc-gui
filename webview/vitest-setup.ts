// Node.js 22+ exposes a built-in localStorage on globalThis that lacks
// full Storage API methods (e.g. clear) when --localstorage-file is not set.
// This conflicts with jsdom's own localStorage implementation.
// Replace it with a spec-compliant in-memory Storage polyfill.
function createStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    get length() {
      return Object.keys(store).length;
    },
  };
}

if (!globalThis.localStorage || typeof globalThis.localStorage.clear !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createStorage(),
    writable: true,
    configurable: true,
  });
}
