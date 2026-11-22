declare global {
  interface Window {
    notifySessionSupplierBindingChanged?: () => void;
  }
}

/** Java's batched bridge accepts string arguments, so dispatch the Event here. */
export function installSessionSupplierCallbacks(): void {
  window.notifySessionSupplierBindingChanged = () => {
    window.dispatchEvent(new Event('session-supplier-binding-changed'));
  };
}
