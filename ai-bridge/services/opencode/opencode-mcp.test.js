import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenCodeMcpServers,
  normalizeOpenCodeMcpStatusList,
  normalizeOpenCodeMcpToolIds,
  normalizeOpenCodeMcpTools
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

test('opencode MCP tool normalization filters tools by sanitized server prefix', () => {
  const tools = normalizeOpenCodeMcpTools('my.server', [
    {
      id: 'my_server_search',
      description: 'Search things',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      id: 'other_server_search',
      description: 'Wrong server',
      parameters: { type: 'object' },
    },
    {
      id: 'my_server_read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
      },
    },
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), ['read_file', 'search']);
  assert.equal(tools[1].description, 'Search things');
  assert.deepEqual(tools[1].inputSchema.required, ['query']);
});

test('opencode MCP tool ID normalization supports ids endpoint fallback', () => {
  const tools = normalizeOpenCodeMcpToolIds('intellij', [
    'bash',
    'intellij_find_files_by_name_keyword',
    'intellij_get_file_problems',
    'puppeteer_click',
  ]);

  assert.deepEqual(tools, [
    { name: 'find_files_by_name_keyword' },
    { name: 'get_file_problems' },
  ]);
});
