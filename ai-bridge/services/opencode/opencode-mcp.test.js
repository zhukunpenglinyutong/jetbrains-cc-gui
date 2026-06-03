import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  listMcpServers,
  normalizeOpenCodeMcpServers,
  normalizeOpenCodeMcpStatusList,
  normalizeOpenCodeMcpToolIds,
  normalizeOpenCodeMcpTools
} from './message-service.js';

async function withJsonServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function captureConsoleJson(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  const jsonLine = lines.find((line) => line.startsWith('{'));
  return JSON.parse(jsonLine);
}

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

test('opencode MCP server listing includes live /mcp status', async () => {
  const config = {
    mcp: {
      intellij: {
        type: 'local',
        command: ['java', '-jar', 'mcp.jar'],
      },
    },
  };

  await withJsonServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/mcp')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ intellij: { status: 'connected' } }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not found"}');
  }, async (baseUrl) => {
    const runtime = {
      baseUrl,
      client: {
        config: {
          get: async () => ({ data: config }),
        },
      },
    };

    const payload = await captureConsoleJson(async () => {
      await listMcpServers('/repo', { runtime });
    });

    assert.equal(payload.success, true);
    assert.equal(payload.servers[0].opencode.status.status, 'connected');
    assert.deepEqual(payload.status.map((entry) => [entry.name, entry.status]), [
      ['intellij', 'connected'],
    ]);
  });
});
