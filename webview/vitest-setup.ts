// Node.js 25+ exposes its own Web Storage on globalThis, and it shadows happy-dom's. The tests
// are written against happy-dom's: localStorage from Node may lack methods such as clear()
// unless --localstorage-file is set, and Node's sessionStorage turns vi.spyOn(storage,
// 'setItem') into a stored item instead of replacing the method. Replace any storage that is
// not happy-dom's with an in-memory Storage that lists its items as keys and can be spied on.
const METHOD_NAMES = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length']);

function createStorage(): Storage {
  const items = new Map<string, string>();
  const target: Record<string, unknown> = {};
  const define = (name: string, descriptor: PropertyDescriptor) =>
    Object.defineProperty(target, name, { configurable: true, enumerable: false, ...descriptor });

  define('getItem', { writable: true, value: (key: string) => (items.has(String(key)) ? items.get(String(key)) : null) });
  define('setItem', { writable: true, value: (key: string, value: string) => void items.set(String(key), String(value)) });
  define('removeItem', { writable: true, value: (key: string) => void items.delete(String(key)) });
  define('clear', { writable: true, value: () => items.clear() });
  define('key', { writable: true, value: (index: number) => [...items.keys()][index] ?? null });
  define('length', { get: () => items.size });

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      return items.has(prop) ? items.get(prop) : undefined;
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'symbol' || METHOD_NAMES.has(prop)) return Reflect.set(t, prop, value, receiver);
      items.set(prop, String(value));
      return true;
    },
    defineProperty(t, prop, descriptor) {
      if (typeof prop === 'symbol' || METHOD_NAMES.has(prop)) return Reflect.defineProperty(t, prop, descriptor);
      items.set(prop, String((descriptor as { value?: unknown }).value));
      return true;
    },
    deleteProperty(t, prop) {
      if (typeof prop === 'symbol' || METHOD_NAMES.has(prop)) return Reflect.deleteProperty(t, prop);
      items.delete(prop);
      return true;
    },
    has(t, prop) {
      return prop in t || (typeof prop === 'string' && items.has(prop));
    },
    ownKeys() {
      return [...items.keys()];
    },
    getOwnPropertyDescriptor(t, prop) {
      if (typeof prop === 'symbol' || METHOD_NAMES.has(prop)) return Reflect.getOwnPropertyDescriptor(t, prop);
      return items.has(prop)
        ? { value: items.get(prop), writable: true, enumerable: true, configurable: true }
        : undefined;
    },
  }) as unknown as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let current: Storage | undefined;
  try {
    current = globalThis[name];
  } catch {
    current = undefined;
  }
  // Keep the DOM environment's own storage (happy-dom or jsdom); Node's is not an instance of
  // that Storage class. No probe here: spying on happy-dom's setItem leaves a mock behind.
  // shortcut: under `@vitest-environment node` on Node 25+, Storage is Node's class and its
  // sessionStorage is kept; add a check if a node-environment test ever needs storage.
  if (!(typeof Storage === 'function' && current instanceof Storage)) {
    Object.defineProperty(globalThis, name, {
      value: createStorage(),
      writable: true,
      configurable: true,
    });
  }
}
