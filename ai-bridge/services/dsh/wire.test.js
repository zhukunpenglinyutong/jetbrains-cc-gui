import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_DIALECT,
  MODERN_DIALECT,
  authorityFromOrigin,
  cookieNameForAuthority,
  launchUrlFromText,
  modernPayloadFor,
  muxPathFor,
  normalizeDialectId,
  parseSetCookie,
  probeMethodFor,
  requiresBrowserSession,
  respondPathFor,
  rpcPayloadFor,
  signSessionCookie,
  signingSecretFromCredentials,
  wireMethodFor,
} from './wire.js';

test('dialect descriptors carry the paths each DSH line serves', () => {
  assert.equal(muxPathFor(LEGACY_DIALECT), '/api/events.mux');
  assert.equal(muxPathFor(MODERN_DIALECT), '/api/remote.mux');
  assert.equal(respondPathFor(LEGACY_DIALECT), '/api/respond');
  assert.equal(respondPathFor(MODERN_DIALECT), '/api/$events/result');
  assert.equal(probeMethodFor(LEGACY_DIALECT), 'host.describe');
  assert.equal(probeMethodFor(MODERN_DIALECT), 'session.list');
  assert.equal(requiresBrowserSession(LEGACY_DIALECT), false);
  assert.equal(requiresBrowserSession(MODERN_DIALECT), true);
});

test('wireMethodFor keeps the legacy spelling and modernizes the modern one', () => {
  assert.equal(wireMethodFor(LEGACY_DIALECT, 'session.list'), 'session.list');
  assert.equal(wireMethodFor(MODERN_DIALECT, 'session.list'), 'session/list');
  assert.equal(wireMethodFor(MODERN_DIALECT, 'session.selectModel'), 'session/selectModel');
  assert.equal(wireMethodFor(MODERN_DIALECT, 'workspace.archiveSession'), 'workspace/archiveSession');
});

test('wireMethodFor maps the endpoints modern hosts renamed or removed', () => {
  assert.equal(wireMethodFor(MODERN_DIALECT, 'session.history'), 'session/page');
  assert.equal(wireMethodFor(MODERN_DIALECT, 'llm.models'), 'session/modelCatalog');
  // `host.describe` is gone on modern hosts: the probe uses the catalog instead.
  assert.equal(wireMethodFor(MODERN_DIALECT, 'host.describe'), null);
  assert.equal(wireMethodFor(LEGACY_DIALECT, 'host.describe'), 'host.describe');
});

test('modernPayloadFor uses each endpoint\'s descriptor argument name', () => {
  assert.deepEqual(modernPayloadFor('session/list', {}), { _request: {} });
  assert.deepEqual(modernPayloadFor('session/modelCatalog', {}), {});
  assert.deepEqual(modernPayloadFor('session/prompt', { a: 1 }), { request: { a: 1 } });
  assert.deepEqual(modernPayloadFor('workspace/archiveSession', { sessionId: 's' }), {
    request: { sessionId: 's' },
  });
});

test('rpcPayloadFor wraps only the modern dialect', () => {
  assert.deepEqual(rpcPayloadFor(LEGACY_DIALECT, 'session.list', { a: 1 }), { a: 1 });
  assert.deepEqual(rpcPayloadFor(MODERN_DIALECT, 'session/list', { a: 1 }), {
    args: { _request: { a: 1 } },
  });
  assert.deepEqual(rpcPayloadFor(MODERN_DIALECT, 'session/modelCatalog', {}), { args: {} });
});

test('normalizeDialectId accepts only the known pins', () => {
  assert.equal(normalizeDialectId('modern'), MODERN_DIALECT);
  assert.equal(normalizeDialectId(' LEGACY '), LEGACY_DIALECT);
  assert.equal(normalizeDialectId(''), null);
  assert.equal(normalizeDialectId('v9'), null);
});

test('signSessionCookie reproduces the host cookie grammar', () => {
  const authority = authorityFromOrigin('http://127.0.0.1:3080');
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const cookie = signSessionCookie(authority, secret, 1_700_000_000_000);

  assert.equal(cookie.name, cookieNameForAuthority('127.0.0.1:3080'));
  assert.match(cookie.value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(cookie.header, `${cookie.name}=${cookie.value}`);

  const payload = JSON.parse(Buffer.from(cookie.value.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.version, 1);
  assert.equal(payload.authority, '127.0.0.1:3080');
  // Issued slightly in the past so a small clock skew cannot invalidate it,
  // and well inside the host's default 30-day cookie lifetime.
  assert.ok(payload.issuedAt < 1_700_000_000_000);
  assert.ok(payload.expiresAt - payload.issuedAt < 30 * 24 * 60 * 60 * 1000);
});

test('signSessionCookie rejects a secret that is not 32 bytes', () => {
  assert.throws(() => signSessionCookie('127.0.0.1:3080', 'short'), /32-byte/);
  assert.throws(() => signSessionCookie('127.0.0.1:3080', ''), /32-byte/);
});

test('parseSetCookie reads the first pair only', () => {
  assert.deepEqual(parseSetCookie('dsh-auth-abc=v1.x.y; Max-Age=60; Path=/; HttpOnly'), {
    name: 'dsh-auth-abc',
    value: 'v1.x.y',
  });
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie('novalue'), null);
});

test('launchUrlFromText extracts the tokenized loopback URL', () => {
  const text = [
    'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://10.0.0.5:3080/?token=lantoken)',
    'dsh web: opening the default browser; pass --no-open to disable',
  ].join('\n');
  assert.equal(launchUrlFromText(text, 'http://127.0.0.1:3080'), 'http://127.0.0.1:3080/?token=abc123');
  // Another authority (or a token-less URL) is never used for the exchange.
  assert.equal(launchUrlFromText(text, 'http://127.0.0.1:3081'), null);
  assert.equal(launchUrlFromText('dsh web: http://127.0.0.1:3080/', 'http://127.0.0.1:3080'), null);
  assert.equal(launchUrlFromText('nothing here', 'http://127.0.0.1:3080'), null);
});

test('signingSecretFromCredentials reads the browser-session record', () => {
  const yaml = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-x',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: k4elfV_f9ThPYKiuLRSmVgo7Fqg-cP5Y7lzIfEjRlMY',
    '  other/record:',
    '    kind: grant',
    '',
  ].join('\n');
  assert.equal(
    signingSecretFromCredentials(yaml),
    'k4elfV_f9ThPYKiuLRSmVgo7Fqg-cP5Y7lzIfEjRlMY'
  );
  assert.equal(signingSecretFromCredentials('version: 1\nrecords: {}\n'), null);
  assert.equal(signingSecretFromCredentials(''), null);
});
