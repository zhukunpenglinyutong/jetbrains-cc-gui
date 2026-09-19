/**
 * Detects whether an error message indicates a provider-not-configured error.
 * The backend throws "API Key not configured and no CLI session found" and may
 * append Node.js diagnostics, so we match on the leading substring.
 */
export function isProviderNotConfiguredError(errorText: string): boolean {
  return errorText.includes('API Key not configured')
    || errorText.includes('local configuration access is not authorized')
    || errorText.includes('本地配置读取未获授权');
}
