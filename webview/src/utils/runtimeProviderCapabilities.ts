/**
 * Runtime provider capabilities subscriber registry.
 *
 * The Java bridge invokes a single set of `window.update*` callbacks to deliver
 * provider-list and active-provider updates. Multiple React components
 * (Settings hook, RuntimeProviderSelect, etc.) need to react to those events.
 *
 * Registering a single dispatcher on `window` and routing events through a
 * subscriber Set keeps behavior deterministic regardless of mount order, and
 * avoids the previous "chain of overridden window callbacks" pattern, which
 * produced non-deterministic teardown when more than one consumer was alive.
 */

type ProviderListListener = (json: string) => void;
type ActiveProviderListener = (json: string) => void;

const providerListListeners = new Set<ProviderListListener>();
const activeProviderListeners = new Set<ActiveProviderListener>();
const codexProviderListListeners = new Set<ProviderListListener>();
const activeCodexProviderListeners = new Set<ActiveProviderListener>();

function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  // Snapshot to avoid mutation during iteration.
  Array.from(listeners).forEach((listener) => {
    try {
      listener(value);
    } catch (error) {
      console.error('[runtimeProviderCapabilities] Listener threw:', error);
    }
  });
}

/**
 * Installs (or re-installs) the single dispatcher on `window`. Safe to call
 * multiple times — calling it during a test reset, for example, simply
 * re-attaches the dispatcher.
 */
export function installRuntimeProviderDispatchers(): void {
  window.updateProviders = (json: string) => {
    emit(providerListListeners, json);
  };

  window.updateActiveProvider = (json: string) => {
    emit(activeProviderListeners, json);
  };

  window.updateCodexProviders = (json: string) => {
    emit(codexProviderListListeners, json);
  };

  window.updateActiveCodexProvider = (json: string) => {
    emit(activeCodexProviderListeners, json);
  };
}

function ensureInstalled(): void {
  // The dispatcher is cheap to (re)install — make subscription self-bootstrapping
  // so that consumers do not depend on a separate bootstrap call.
  if (typeof window === 'undefined') return;
  if (window.updateProviders && window.updateActiveProvider
      && window.updateCodexProviders && window.updateActiveCodexProvider) {
    return;
  }
  installRuntimeProviderDispatchers();
}

export function subscribeProviderList(listener: ProviderListListener): () => void {
  ensureInstalled();
  providerListListeners.add(listener);
  return () => {
    providerListListeners.delete(listener);
  };
}

export function subscribeActiveProvider(listener: ActiveProviderListener): () => void {
  ensureInstalled();
  activeProviderListeners.add(listener);
  return () => {
    activeProviderListeners.delete(listener);
  };
}

export function subscribeCodexProviderList(listener: ProviderListListener): () => void {
  ensureInstalled();
  codexProviderListListeners.add(listener);
  return () => {
    codexProviderListListeners.delete(listener);
  };
}

export function subscribeActiveCodexProvider(listener: ActiveProviderListener): () => void {
  ensureInstalled();
  activeCodexProviderListeners.add(listener);
  return () => {
    activeCodexProviderListeners.delete(listener);
  };
}
