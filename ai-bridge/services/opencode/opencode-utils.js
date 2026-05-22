/**
 * Shared opencode bridge utilities.
 */
import { loadOpenCodeSdk } from '../../utils/sdk-loader.js';

export async function ensureOpenCodeSdk() {
  const sdk = await loadOpenCodeSdk();

  if (!sdk || typeof sdk.createOpencodeClient !== 'function') {
    throw new Error('opencode SDK loaded, but createOpencodeClient export was not found');
  }

  return sdk;
}

export function normalizeOpenCodeSdkError(error) {
  const message = error && error.message ? error.message : String(error);
  if (message.includes('SDK_NOT_INSTALLED:opencode')) {
    return {
      code: 'SDK_NOT_INSTALLED',
      error: 'opencode SDK not installed. Install opencode SDK from Settings > Dependencies.'
    };
  }

  return {
    code: 'OPENCODE_ERROR',
    error: message
  };
}
