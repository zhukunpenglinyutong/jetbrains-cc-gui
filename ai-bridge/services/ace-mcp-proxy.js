/**
 * ACE MCP 代理服务
 * 
 * 功能：
 * 1. 作为长期运行的 HTTP 服务器
 * 2. 维护与 ACE MCP (auggie --mcp) 的持久连接
 * 3. 提供 /retrieve API 供 prompt-enhancer.js 调用
 * 4. 避免每次调用都重新启动和索引
 * 
 * 启动参数：
 * --port <port>     HTTP 服务端口
 * --project <path>  项目路径（ACE 工作目录）
 */

import http from 'http';
import { readMcpConfig } from '../config/api-config.js';

// 解析命令行参数
const args = process.argv.slice(2);
let port = 19800;
let projectPath = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--project' && args[i + 1]) {
    projectPath = args[i + 1];
    i++;
  }
}

console.log(`[AceMcpProxy] Starting proxy service...`);
console.log(`[AceMcpProxy] Port: ${port}`);
console.log(`[AceMcpProxy] Project: ${projectPath}`);

// ACE MCP 配置
const ACE_SERVER_NAMES = ['auggie-mcp', 'auggie', 'augment', 'ace', 'augment-context-engine'];

// MCP 客户端状态
let mcpClient = null;
let mcpTransport = null;
let aceServerConfig = null;
let isConnecting = false;
let isConnected = false;

/**
 * 查找 ACE 服务器配置
 */
function findAceServerConfig() {
  const mcpConfig = readMcpConfig();
  const configKeys = Object.keys(mcpConfig);
  
  for (const serverName of configKeys) {
    const normalizedName = serverName.toLowerCase().replace(/[-_\s]/g, '');
    
    for (const aceName of ACE_SERVER_NAMES) {
      if (normalizedName.includes(aceName.replace(/[-_\s]/g, ''))) {
        const serverConfig = mcpConfig[serverName];
        if (serverConfig && serverConfig.command) {
          console.log(`[AceMcpProxy] Found ACE server: ${serverName}`);
          return { serverName, serverConfig };
        }
      }
    }
  }
  
  console.log('[AceMcpProxy] ACE server not found in config');
  return null;
}

/**
 * 连接到 ACE MCP 服务器
 */
async function connectToAce() {
  if (isConnecting) {
    console.log('[AceMcpProxy] Already connecting...');
    return false;
  }
  
  if (isConnected && mcpClient) {
    return true;
  }
  
  isConnecting = true;
  
  try {
    const aceConfig = findAceServerConfig();
    if (!aceConfig) {
      console.log('[AceMcpProxy] No ACE server configured');
      isConnecting = false;
      return false;
    }
    
    aceServerConfig = aceConfig;
    
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    
    console.log(`[AceMcpProxy] Connecting to ACE: ${aceConfig.serverName}`);
    console.log(`[AceMcpProxy] Command: ${aceConfig.serverConfig.command} ${(aceConfig.serverConfig.args || []).join(' ')}`);
    console.log(`[AceMcpProxy] Working directory: ${projectPath}`);
    
    // 创建传输层
    mcpTransport = new StdioClientTransport({
      command: aceConfig.serverConfig.command,
      args: aceConfig.serverConfig.args || [],
      env: { ...process.env, ...(aceConfig.serverConfig.env || {}) },
      cwd: projectPath
    });
    
    // 创建客户端
    mcpClient = new Client({
      name: 'ace-mcp-proxy',
      version: '1.0.0'
    }, {
      capabilities: {}
    });
    
    // 连接
    await mcpClient.connect(mcpTransport);
    isConnected = true;
    isConnecting = false;
    
    console.log('[AceMcpProxy] Connected to ACE MCP successfully');
    return true;
  } catch (error) {
    console.error('[AceMcpProxy] Failed to connect to ACE:', error.message);
    isConnecting = false;
    isConnected = false;
    mcpClient = null;
    mcpTransport = null;
    return false;
  }
}

/**
 * 调用 codebase-retrieval 工具
 */
async function callCodebaseRetrieval(informationRequest) {
  if (!isConnected || !mcpClient) {
    const connected = await connectToAce();
    if (!connected) {
      throw new Error('ACE MCP not connected');
    }
  }

  console.log(`[AceMcpProxy] Calling codebase-retrieval...`);
  console.log(`[AceMcpProxy] Request: ${informationRequest.substring(0, 100)}...`);

  try {
    const result = await mcpClient.callTool({
      name: 'codebase-retrieval',
      arguments: {
        information_request: informationRequest
      }
    });

    if (result && result.content) {
      const textContent = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      console.log(`[AceMcpProxy] Retrieved ${textContent.length} characters`);
      return textContent;
    }

    return null;
  } catch (error) {
    console.error('[AceMcpProxy] codebase-retrieval failed:', error.message);

    // 连接可能已断开，重置状态
    isConnected = false;
    mcpClient = null;

    throw error;
  }
}

/**
 * 处理 HTTP 请求
 */
async function handleRequest(req, res) {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${port}`);

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connected: isConnected,
      project: projectPath
    }));
    return;
  }

  // 代码检索 API
  if (url.pathname === '/retrieve' && req.method === 'POST') {

    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        let parsedBody;
        try {
          parsedBody = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const { query } = parsedBody;

        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query parameter' }));
          return;
        }

        const result = await callCodebaseRetrieval(query);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          context: result
        }));
      } catch (error) {
        console.error('[AceMcpProxy] Request error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error.message
        }));
      }
    });

    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * 启动 HTTP 服务器
 */
const server = http.createServer(handleRequest);

server.listen(port, '127.0.0.1', async () => {
  console.log(`[AceMcpProxy] Server listening on port ${port}`);
  console.log('[READY]'); // 信号给 Java 端

  // 预先连接到 ACE
  const connected = await connectToAce();
  if (connected) {
    console.log('[AceMcpProxy] ACE connection established');
  } else {
    console.log('[AceMcpProxy] ACE connection will be established on first request');
  }
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[AceMcpProxy] Received SIGTERM, shutting down...');
  cleanup();
});

process.on('SIGINT', () => {
  console.log('[AceMcpProxy] Received SIGINT, shutting down...');
  cleanup();
});

async function cleanup() {
  try {
    if (mcpClient) {
      await mcpClient.close();
    }
    if (mcpTransport) {
      mcpTransport.close();
    }
  } catch (e) {
    // ignore
  }

  server.close(() => {
    console.log('[AceMcpProxy] Server closed');
    process.exit(0);
  });

  // 强制退出超时
  setTimeout(() => {
    process.exit(0);
  }, 3000);
}

