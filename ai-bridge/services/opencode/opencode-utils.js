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

  if (
    error?.code === 'ENOENT'
    || /spawn opencode ENOENT/i.test(message)
    || /opencode.*ENOENT/i.test(message)
    || /command not found: opencode/i.test(message)
  ) {
    return {
      code: 'OPENCODE_CLI_NOT_FOUND',
      error: 'opencode CLI not found. Install opencode and make sure the IDE process PATH can find the opencode executable.'
    };
  }

  if (/Timeout waiting for server to start/i.test(message)) {
    return {
      code: 'OPENCODE_SERVER_START_TIMEOUT',
      error: message
    };
  }

  if (/401|Unauthorized|Authentication required/i.test(message)) {
    return {
      code: 'OPENCODE_SERVER_UNAUTHORIZED',
      error: 'opencode server rejected the request. Check OPENCODE_SERVER_PASSWORD/OPENCODE_SERVER_USERNAME in the IDE environment or clear them for the managed local server.'
    };
  }

  return {
    code: 'OPENCODE_ERROR',
    error: message
  };
}
