/**
 * DSH wire dialects — how the bridge reaches a `dsh web` host across DSH
 * releases, and how a non-browser client authenticates to one.
 *
 * Two dialects exist today:
 *
 *   legacy (<= 0.1.0-rc.x)  endpoints are dotted (`POST /api/session.list`),
 *                           `/api` carries only the Host/Origin fence, the
 *                           event stream is `/api/events.mux`, and host-minted
 *                           requests settle on `POST /api/respond`.
 *
 *   modern (>= 0.1.5-rc.x)  endpoints are `<namespace>/<method>`
 *                           (`POST /api/session/list`), `host.describe` is
 *                           gone, the event stream moved to
 *                           `/api/remote.mux`, and every `/api` request *and*
 *                           WebSocket upgrade carries a browser-session
 *                           cookie minted by `dsh web`.
 *
 * The dialect is negotiated against the live host (never inferred from a
 * version string — an adopted host never reports one) and cached in the
 * supervisor state file; `DSH_WIRE` pins it when negotiation guesses wrong.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_DIALECT = 'legacy';
export const MODERN_DIALECT = 'modern';

export const DIALECT_IDS = [LEGACY_DIALECT, MODERN_DIALECT];

/** Browser-session cookie name/value grammar shared with `dsh-client-connection`. */
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const SECRET_BYTES = 32;
/** Well under the host's default `cookieMaxAgeDays` (30), so the payload validates. */
const COOKIE_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Signed-in-the-past slack for clock skew between the bridge and the host. */
const COOKIE_CLOCK_SKEW_MS = 5_000;
/** Credential record key holding the signing secret (`credentialKey('client-connection','browser-session')`). */
const BROWSER_SESSION_RECORD = 'client-connection/browser-session';

const DIALECTS = {
  [LEGACY_DIALECT]: {
    id: LEGACY_DIALECT,
    authenticated: false,
    muxPath: '/api/events.mux',
    respondPath: '/api/respond',
    /** Probed to tell the dialects apart (legacy-only endpoint). */
    probeMethod: 'host.describe',
  },
  [MODERN_DIALECT]: {
    id: MODERN_DIALECT,
    authenticated: true,
    muxPath: '/api/remote.mux',
    respondPath: '/api/$events/result',
    /** Modern has no `host.describe`; the cheapest "is this a live host" call. */
    probeMethod: 'session.list',
  },
};

/**
 * Endpoints whose modern name is not just the dotted name with `/` separators.
 * `null` means the endpoint has no modern successor.
 */
const MODERN_ALIASES = {
  'host.describe': null,
  'session.history': 'session/page',
  'llm.models': 'session/modelCatalog',
  'llm.providers': 'llm/listProviders',
  'llm.discoverModels': 'llm/discoverModels',
};

/** Normalize a configured `DSH_WIRE` value; unknown values mean "negotiate". */
export function normalizeDialectId(value) {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DIALECT_IDS.includes(trimmed) ? trimmed : null;
}

export function isKnownDialect(id) {
  return DIALECT_IDS.includes(id);
}

export function dialectDescriptor(id) {
  const descriptor = DIALECTS[id];
  if (!descriptor) {
    throw new Error(`dsh: unknown wire dialect ${JSON.stringify(id)}`);
  }
  return descriptor;
}

export function requiresBrowserSession(id) {
  return dialectDescriptor(id).authenticated;
}

export function muxPathFor(id) {
  return dialectDescriptor(id).muxPath;
}

export function respondPathFor(id) {
  return dialectDescriptor(id).respondPath;
}

export function probeMethodFor(id) {
  return dialectDescriptor(id).probeMethod;
}

/**
 * Map one logical endpoint (the dotted legacy spelling used throughout this
 * bridge) onto the dialect's wire name. Returns null when the dialect has no
 * such endpoint.
 */
export function wireMethodFor(id, logicalMethod) {
  const method = String(logicalMethod || '').trim();
  if (!method) {
    return null;
  }
  if (id === MODERN_DIALECT && method in MODERN_ALIASES) {
    return MODERN_ALIASES[method];
  }
  if (id !== MODERN_DIALECT) {
    return method;
  }
  return method.replace(/\./g, '/');
}

/**
 * Modern endpoints whose single business argument is not named `request`, or
 * that take no argument at all. The gateway validates the `args` object
 * against the descriptor's parameter names, so these must match exactly.
 */
const MODERN_ARG_NAMES = {
  'session/list': '_request',
  'session/modelCatalog': null,
};

/**
 * Wrap one legacy-shaped business payload into the modern `args` object.
 * The legacy wire posts the payload itself; the modern gateway demands
 * `payload.args` keyed by the descriptor's parameter name.
 */
export function modernPayloadFor(wireMethod, payload) {
  if (wireMethod in MODERN_ARG_NAMES) {
    const name = MODERN_ARG_NAMES[wireMethod];
    return name === null ? {} : { [name]: payload };
  }
  return { request: payload };
}

/** Build the `payload` body of one RPC for a dialect. */
export function rpcPayloadFor(id, wireMethod, payload) {
  if (id !== MODERN_DIALECT) {
    return payload;
  }
  return { args: modernPayloadFor(wireMethod, payload) };
}

//#region browser-session cookie

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    return null;
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  return encodeBase64Url(decoded) === value ? decoded : null;
}

/** Canonical request authority (`host[:port]`), as the host derives it. */
export function authorityFromOrigin(origin) {
  try {
    return new URL(String(origin || '')).host || null;
  } catch {
    return null;
  }
}

/** Cookie name the host expects for one authority. */
export function cookieNameForAuthority(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/**
 * Self-sign a browser-session cookie from the host's persistent signing
 * secret. Mirrors `dsh-client-connection`'s `encodeCookie`, so a non-browser
 * client on the same machine can authenticate to a host it did not spawn
 * (whose one-shot launch token is unreachable).
 *
 * @param {string} authority - canonical `host[:port]`.
 * @param {string} secretBase64Url - the stored 32-byte secret.
 * @param {number} [now] - injectable clock for tests.
 * @returns {{ name: string, value: string, header: string, expiresAt: number }}
 */
export function signSessionCookie(authority, secretBase64Url, now = Date.now()) {
  const secret = decodeBase64Url(String(secretBase64Url || '').trim());
  if (!secret || secret.byteLength !== SECRET_BYTES) {
    throw new Error('dsh: browser-session secret is not a 32-byte base64url value');
  }
  const issuedAt = now - COOKIE_CLOCK_SKEW_MS;
  const expiresAt = issuedAt + COOKIE_LIFETIME_MS;
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  const name = cookieNameForAuthority(authority);
  return { name, value: `v1.${body}.${signature}`, header: `${name}=v1.${body}.${signature}`, expiresAt };
}

/** Read the first `name=value` pair from a `set-cookie` header. */
export function parseSetCookie(headerValue) {
  const first = String(headerValue || '').split(';', 1)[0].trim();
  const at = first.indexOf('=');
  if (at <= 0) {
    return null;
  }
  return { name: first.slice(0, at).trim(), value: first.slice(at + 1).trim() };
}

/**
 * Pull the one-shot launch URL out of `dsh web` output. The host prints
 * `dsh web: http://127.0.0.1:3080/?token=<launch token>` at boot, and that
 * token is the only way to mint a cookie for a host we spawned.
 */
export function launchUrlFromText(text, expectedOrigin) {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  const match = text.match(/dsh web:\s*(https?:\/\/\S+)/);
  if (!match) {
    return null;
  }
  let url;
  try {
    url = new URL(match[1]);
  } catch {
    return null;
  }
  if (!url.searchParams.get('token')) {
    return null;
  }
  if (expectedOrigin) {
    let expected;
    try {
      expected = new URL(expectedOrigin);
    } catch {
      return null;
    }
    // The LAN line in the same output advertises another authority; only the
    // loopback/expected-origin URL carries a token we may use here.
    if (url.port !== expected.port || url.hostname !== expected.hostname) {
      return null;
    }
  }
  return url.href;
}

/** Parse the signing secret out of a `$DSH_HOME/.credentials.yaml`. */
export function signingSecretFromCredentials(text) {
  if (typeof text !== 'string' || !text) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === `${BROWSER_SESSION_RECORD}:`);
  if (at === -1) {
    return null;
  }
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indentation = line.match(/^\s*/)[0].length;
    if (line.trim() && indentation === 0) {
      break;
    }
    const secret = line.match(/^\s*secret:\s*(\S+)\s*$/);
    if (secret) {
      return secret[1];
    }
  }
  return null;
}

/** Resolve `$DSH_HOME` the way the launcher does, defaulting to `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const configured = String(env.DSH_HOME || '').trim();
  return configured || join(env.HOME || env.USERPROFILE || homedir(), '.dsh');
}

/**
 * Read the host's persistent signing secret. Returns null when the store is
 * absent, unreadable, or predates browser authentication (a legacy host never
 * writes it).
 */
export function readSigningSecret(dshHome) {
  try {
    const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
    return signingSecretFromCredentials(text);
  } catch {
    return null;
  }
}

//#endregion
