import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenCodeMcpServers,
  normalizeOpenCodeMcpStatusList
} from './message-service.js';

test('opencode MCP normalization merges config with /mcp status', () => {
  const config = {
    mcp: {
      filesystem: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem'],
        environment: {
          TOKEN: 'secret',
        },
      },
      remote: {
        type: 'remote',
        url: 'https://mcp.example.com',
        headers: {
          Authorization: 'Bearer secret',
        },
      },
    },
  };
  const status = {
    filesystem: { status: 'connected' },
    remote: { status: 'needs_auth' },
    disabledOnly: { status: 'disabled' },
  };

  const servers = normalizeOpenCodeMcpServers(config, status);
  assert.deepEqual(servers.map((server) => server.id), ['disabledOnly', 'filesystem', 'remote']);
  assert.equal(servers[1].server.command, 'npx');
  assert.deepEqual(servers[1].server.args, ['-y', '@modelcontextprotocol/server-filesystem']);
  assert.deepEqual(servers[1].server.env, { TOKEN: '***' });
  assert.equal(servers[2].server.url, 'https://mcp.example.com');
  assert.deepEqual(servers[2].server.headers, { Authorization: '***' });
  assert.equal(servers[0].enabled, false);
  assert.equal(servers[1].apps.opencode, true);

  const statuses = normalizeOpenCodeMcpStatusList(config, status);
  assert.deepEqual(statuses.map((entry) => [entry.name, entry.status]), [
    ['disabledOnly', 'pending'],
    ['filesystem', 'connected'],
    ['remote', 'needs-auth'],
  ]);
});

test('opencode MCP normalization maps failures with error details', () => {
  const statuses = normalizeOpenCodeMcpStatusList({}, {
    broken: {
      status: 'failed',
      error: 'spawn ENOENT',
    },
  });

  assert.deepEqual(statuses, [
    {
      name: 'broken',
      status: 'failed',
      opencode: {
        status: 'failed',
        error: 'spawn ENOENT',
      },
      error: 'spawn ENOENT',
    },
  ]);
});
