import { execSync } from 'child_process';

/**
 * Detect whether an error is an AWS token expiry (403 ExpiredTokenException).
 */
export function isAwsTokenExpiredError(error) {
  const msg = error?.message || String(error);
  return msg.includes('ExpiredTokenException')
      || (msg.includes('security token') && msg.includes('expired'));
}

/**
 * Run the AWS token refresh command from process.env.awsAuthRefresh.
 * Returns true if refresh succeeded, false if not configured or failed.
 */
export function runAwsTokenRefresh() {
  const cmd = process.env.awsAuthRefresh;
  if (!cmd) return false;
  try {
    execSync(cmd, { timeout: 30000, stdio: 'pipe' });
    console.log('[AWS_REFRESH] Token refresh succeeded');
    return true;
  } catch (e) {
    console.error('[AWS_REFRESH] Token refresh failed:', e.message);
    return false;
  }
}
