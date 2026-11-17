import { vi } from 'vitest';

// Newer Node.js releases expose their own Web Storage on globalThis. It differs from the
// browser Storage the code under test runs against: localStorage may lack methods such as
// clear() unless --localstorage-file is set, and sessionStorage turns vi.spyOn(storage,
// 'setItem') into a stored item instead of replacing the method. Replace any storage that
// does not behave like a browser one with a spec-shaped in-memory Storage.
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
      return typeof prop === 'symbol' || prop in t || items.has(prop);
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

/** True when the storage has the methods, lists its items as keys and lets tests spy on setItem. */
function behavesLikeBrowserStorage(storage: Storage | undefined): boolean {
  if (!storage || typeof storage.clear !== 'function') return false;
  try {
    storage.clear();
    storage.setItem('__vitest_probe__', '1');
    const listsItems = Object.keys(storage).includes('__vitest_probe__');
    storage.clear();
    const spy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('probe');
    });
    let spyable = false;
    try {
      storage.setItem('__vitest_probe__', '2');
    } catch {
      spyable = true;
    }
    spy.mockRestore();
    storage.clear();
    return listsItems && spyable;
  } catch {
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let current: Storage | undefined;
  try {
    current = globalThis[name];
  } catch {
    current = undefined;
  }
  if (!behavesLikeBrowserStorage(current)) {
    Object.defineProperty(globalThis, name, {
      value: createStorage(),
      writable: true,
      configurable: true,
    });
  }
}
