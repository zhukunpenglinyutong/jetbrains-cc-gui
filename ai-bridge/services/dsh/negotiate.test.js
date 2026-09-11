import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireCookie,
  cookieFromCredentials,
  cookieFromLaunchLog,
  cookieMatchesAuthority,
  negotiateWire,
} from './negotiate.js';
import { DshTransportError } from './host.js';
import { authorityFromOrigin, cookieNameForAuthority } from './wire.js';

/** 32-byte base64url secret, the shape the host stores. */
const SECRET = Buffer.alloc(32, 9).toString('base64url');

function tempDshHome(secret = SECRET) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  writeFileSync(
    join(dir, '.credentials.yaml'),
    [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${secret}`,
      '',
    ].join('\n')
  );
  return dir;
}

function rpc(value, rpcId = 'r') {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } });
}

/** Echo the caller's rpcId the way the host does. */
function rpcIdOf(body) {
  try {
    return JSON.parse(body).rpcId;
  } catch {
    return 'r';
  }
}

/**
 * A stub host. `mode` decides what `host.describe` answers, which is exactly
 * the signal negotiation observes.
 */
async function stubHost(mode, options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ path: url.pathname, cookie: req.headers.cookie || '', body });
      if (url.pathname === '/') {
        res.writeHead(303, { 'set-cookie': 'dsh-auth-stub=v1.a.b; Path=/; HttpOnly' });
        res.end();
        return;
      }
      if (mode === 'modern' && !String(req.headers.cookie || '').startsWith('dsh-auth-')) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      if (mode === 'modern' && options.rejectCookie) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      if (url.pathname === '/api/host.describe') {
        if (mode === 'legacy') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(rpc({
            version: '0.0.1',
            provider: 'deepseek-official',
            model: 'deepseek-flash',
          }, rpcIdOf(body)));
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (url.pathname === '/api/session/modelCatalog') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(rpc({
          default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
          routableProviders: ['deepseek-official'],
          groups: [],
          failures: [],
        }, rpcIdOf(body)));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a legacy host is adopted without authentication', async () => {
  const host = await stubHost('legacy');
  try {
    const { client, dialect, cookie, describe } = await negotiateWire({ origin: host.origin });
    assert.equal(dialect, 'legacy');
    assert.equal(cookie, null);
    assert.equal(client.dialect, 'legacy');
    assert.equal(client.muxUrl(), `ws://127.0.0.1:${new URL(host.origin).port}/api/events.mux`);
    assert.equal(describe.model, 'deepseek-flash');
    assert.equal(host.requests[0].cookie, '');
  } finally {
    await host.close();
  }
});

test('a 401 on host.describe marks the modern wire and mints a cookie', async () => {
  const host = await stubHost('modern');
  const dshHome = tempDshHome();
  try {
    const { client, dialect, cookie, describe } = await negotiateWire({
      origin: host.origin,
      dshHome,
    });
    assert.equal(dialect, 'modern');
    assert.equal(client.dialect, 'modern');
    assert.ok(cookieMatchesAuthority(cookie, host.origin), 'cookie must carry the authority-bound name');
    // `host.describe` is gone, so the catalog's default is the describe value.
    assert.deepEqual(describe, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    });
    assert.equal(client.muxUrl(), `ws://127.0.0.1:${new URL(host.origin).port}/api/remote.mux`);
    // The unauthenticated legacy probe is what discovered the dialect; every
    // request after it must carry the minted cookie.
    const afterProbe = host.requests.slice(1);
    assert.ok(afterProbe.length >= 1);
    assert.ok(
      afterProbe.every((entry) => entry.cookie.startsWith('dsh-auth-')),
      `expected every post-probe request to be authenticated, got ${JSON.stringify(afterProbe)}`
    );
  } finally {
    await host.close();
  }
});

test('a modern host without a reachable secret fails with an actionable message', async () => {
  const host = await stubHost('modern');
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-empty-'));
  try {
    await assert.rejects(
      () => negotiateWire({ origin: host.origin, dshHome: emptyHome }),
      (error) => {
        assert.ok(error instanceof DshTransportError);
        assert.match(error.message, /requires browser-session authentication/);
        assert.match(error.message, /DSH_HOME/);
        return true;
      }
    );
  } finally {
    await host.close();
  }
});

test('a rejected minted cookie explains the DSH_HOME mismatch', async () => {
  const host = await stubHost('modern', { rejectCookie: true });
  const dshHome = tempDshHome();
  try {
    await assert.rejects(
      () => negotiateWire({ origin: host.origin, dshHome }),
      /rejected the minted browser-session cookie/
    );
  } finally {
    await host.close();
  }
});

test('DSH_WIRE pins the dialect and skips observation', async () => {
  const host = await stubHost('legacy');
  try {
    const { dialect } = await negotiateWire({ origin: host.origin, dialect: 'legacy' });
    assert.equal(dialect, 'legacy');
    // Only the pinned probe ran: no attempt at the modern catalog.
    assert.deepEqual(host.requests.map((entry) => entry.path), ['/api/host.describe']);
  } finally {
    await host.close();
  }
});

test('cookieFromLaunchLog exchanges the printed launch token', async () => {
  const host = await stubHost('modern');
  const logFile = join(mkdtempSync(join(tmpdir(), 'dsh-log-')), 'dsh-web.log');
  writeFileSync(
    logFile,
    `dsh web: ${host.origin}/?token=launch-token\n`
      + 'dsh web: opening the default browser; pass --no-open to disable\n'
  );
  try {
    const cookie = await cookieFromLaunchLog(host.origin, logFile, { timeoutMs: 3_000 });
    assert.equal(cookie, 'dsh-auth-stub=v1.a.b');
    assert.equal(host.requests[0].path, '/');
  } finally {
    await host.close();
  }
});

test('cookieFromLaunchLog gives up when the log never carries a token', async () => {
  const logFile = join(mkdtempSync(join(tmpdir(), 'dsh-log-')), 'dsh-web.log');
  writeFileSync(logFile, 'dsh web: http://127.0.0.1:3080\n');
  assert.equal(
    await cookieFromLaunchLog('http://127.0.0.1:3080', logFile, { timeoutMs: 400 }),
    null
  );
});

test('acquireCookie prefers the launch log over the credential store', async () => {
  const host = await stubHost('modern');
  const logFile = join(mkdtempSync(join(tmpdir(), 'dsh-log-')), 'dsh-web.log');
  writeFileSync(logFile, `dsh web: ${host.origin}/?token=launch-token\n`);
  try {
    const cookie = await acquireCookie({
      origin: host.origin,
      logFile,
      dshHome: tempDshHome(),
      launchTimeoutMs: 3_000,
    });
    assert.equal(cookie, 'dsh-auth-stub=v1.a.b');
  } finally {
    await host.close();
  }
});

test('cookieMatchesAuthority binds the cookie to its authority', () => {
  const home = tempDshHome();
  const cookie = cookieFromCredentials('http://127.0.0.1:3080', home);
  assert.ok(cookie);
  assert.ok(cookie.startsWith(`${cookieNameForAuthority(authorityFromOrigin('http://127.0.0.1:3080'))}=`));
  assert.equal(cookieMatchesAuthority(cookie, 'http://127.0.0.1:3081'), false);
  assert.equal(cookieMatchesAuthority(cookie, 'http://127.0.0.1:3080'), true);
});
