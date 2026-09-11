/**
 * Dialect negotiation and browser-session authentication for one dsh host.
 *
 * The bridge must serve hosts from two DSH lines at once:
 *
 *   legacy (<= 0.1.0-rc.x)  `/api` is open, endpoints are dotted, and the
 *                           readiness probe is `host.describe`.
 *   modern (>= 0.1.5-rc.x)  `/api` sits behind a browser-session cookie,
 *                           endpoints are `<namespace>/<method>`, and
 *                           `host.describe` is gone.
 *
 * Neither line reports a version over the wire and an adopted host was not
 * started by us, so the dialect is *observed*: `host.describe` answering 200
 * means legacy, 401 means a modern host's auth fence, and 404 means the
 * endpoint is gone (modern, or something newer still). `DSH_WIRE` pins the
 * answer when observation is not enough.
 */

import { readFileSync } from 'node:fs';
import {
  LEGACY_DIALECT,
  MODERN_DIALECT,
  authorityFromOrigin,
  cookieNameForAuthority,
  launchUrlFromText,
  normalizeDialectId,
  parseSetCookie,
  readSigningSecret,
  requiresBrowserSession,
  resolveDshHome,
  signSessionCookie,
} from './wire.js';
import { DshHostClient, DshHttpError, DshTransportError } from './host.js';

/** How long a freshly spawned host may take to print its launch URL. */
const LAUNCH_URL_TIMEOUT_MS = 45_000;
const LAUNCH_URL_POLL_MS = 250;

function defaultLog() {
  // Negotiation details are diagnostics, never protocol output.
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Read `set-cookie` off a response without depending on undici internals. */
function firstSetCookie(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length > 0) {
      return list[0];
    }
  }
  return headers.get('set-cookie') || '';
}

/**
 * Wait for `dsh web` to print its launch URL and exchange the one-shot token
 * for a browser-session cookie. Only a host this bridge spawned logs that line,
 * so this path needs no access to the host's credential store.
 *
 * @returns {Promise<string|null>} `name=value` header, or null when the host
 *   never printed an exchangeable URL inside the window.
 */
export async function cookieFromLaunchLog(origin, logFile, options = {}) {
  if (!logFile) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? LAUNCH_URL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = readFileSync(logFile, 'utf8');
    } catch {
      text = '';
    }
    const launchUrl = launchUrlFromText(text, origin);
    if (launchUrl) {
      try {
        const response = await fetch(launchUrl, { redirect: 'manual' });
        const parsed = parseSetCookie(firstSetCookie(response.headers));
        if (parsed) {
          return `${parsed.name}=${parsed.value}`;
        }
      } catch {
        // The server may not accept connections yet; keep polling the log.
      }
    }
    if (options.signal?.aborted) {
      return null;
    }
    await sleep(LAUNCH_URL_POLL_MS);
  }
  return null;
}

/**
 * Mint a cookie from the host's persistent signing secret. This is the only
 * way to authenticate to a host this bridge did not spawn (its launch token
 * was printed to a console we cannot read).
 */
export function cookieFromCredentials(origin, dshHome) {
  const authority = authorityFromOrigin(origin);
  if (!authority) {
    return null;
  }
  const secret = readSigningSecret(dshHome);
  if (!secret) {
    return null;
  }
  try {
    return signSessionCookie(authority, secret).header;
  } catch {
    return null;
  }
}

/**
 * Acquire a browser-session cookie for `origin`, preferring the launch URL of a
 * host this bridge spawned and falling back to the stored signing secret.
 */
export async function acquireCookie(options) {
  const { origin, logFile, dshHome, log = defaultLog, launchTimeoutMs } = options;
  const fromLaunch = await cookieFromLaunchLog(origin, logFile, { timeoutMs: launchTimeoutMs });
  if (fromLaunch) {
    log(`[dsh] authenticated via the launch URL of ${origin}`);
    return fromLaunch;
  }
  const fromCredentials = cookieFromCredentials(origin, dshHome || resolveDshHome());
  if (fromCredentials) {
    log(`[dsh] authenticated ${origin} with the stored browser-session secret`);
    return fromCredentials;
  }
  return null;
}

/** Human-readable explanation for a host we cannot authenticate to. */
function authFailureMessage(origin) {
  return `dsh ${origin} requires browser-session authentication and no cookie could be `
    + 'minted: the host was not started by this plugin (so its launch URL is unknown) and '
    + `no browser-session secret was found in ${resolveDshHome()}. Start the host from the `
    + 'IDE, or point DSH_HOME at the home the running host uses.';
}

/**
 * Observe the dialect of one live host and return the client that speaks it.
 *
 * @param {object} options
 * @param {string} options.origin canonical `http://host:port`
 * @param {string} [options.logFile] stdout log of a host this bridge spawned
 * @param {string} [options.dshHome] `$DSH_HOME` of the running host
 * @param {string} [options.dialect] pinned dialect (`DSH_WIRE`)
 * @param {string} [options.cookie] cookie already known for this host
 * @param {Function} [options.log]
 * @returns {Promise<{ client: DshHostClient, dialect: string, cookie: string|null, describe: object }>}
 */
export async function negotiateWire(options) {
  const { origin, logFile, dshHome, cookie: knownCookie } = options;
  const log = typeof options.log === 'function' ? options.log : defaultLog;
  const pinned = normalizeDialectId(options.dialect);

  if (pinned) {
    const cookie = requiresBrowserSession(pinned)
      ? knownCookie || await acquireCookie({ origin, logFile, dshHome, log })
      : null;
    if (requiresBrowserSession(pinned) && !cookie) {
      throw new DshTransportError(authFailureMessage(origin));
    }
    const client = new DshHostClient(origin, { dialect: pinned, cookie });
    return { client, dialect: pinned, cookie, describe: await client.describe() };
  }

  // Observation step 1: the legacy-only readiness probe.
  try {
    const describe = await new DshHostClient(origin, { dialect: LEGACY_DIALECT }).describe();
    log(`[dsh] ${origin} speaks the legacy wire`);
    return {
      client: new DshHostClient(origin, { dialect: LEGACY_DIALECT }),
      dialect: LEGACY_DIALECT,
      cookie: null,
      describe,
    };
  } catch (error) {
    if (!(error instanceof DshHttpError) || (error.status !== 401 && error.status !== 404)) {
      throw error;
    }
    log(`[dsh] ${origin} answered HTTP ${error.status} to host.describe — assuming the modern wire`);
  }

  // Observation step 2: a modern host. Authenticate, then verify.
  const cookie = knownCookie || await acquireCookie({ origin, logFile, dshHome, log });
  if (!cookie) {
    throw new DshTransportError(authFailureMessage(origin));
  }
  const client = new DshHostClient(origin, { dialect: MODERN_DIALECT, cookie });
  try {
    const describe = await client.describe();
    return { client, dialect: MODERN_DIALECT, cookie, describe };
  } catch (error) {
    if (error instanceof DshHttpError && error.status === 401) {
      throw new DshTransportError(
        `dsh ${origin} rejected the minted browser-session cookie (HTTP 401). The cookie is `
        + `bound to ${authorityFromOrigin(origin) || origin} and signed by the secret of the `
        + 'home that started the host; check that DSH_HOME matches that home.'
      );
    }
    throw error;
  }
}

/** Whether `cookie` is the cookie name this host expects for its authority. */
export function cookieMatchesAuthority(cookie, origin) {
  const authority = authorityFromOrigin(origin);
  if (!authority || !cookie) {
    return false;
  }
  return String(cookie).startsWith(`${cookieNameForAuthority(authority)}=`);
}
