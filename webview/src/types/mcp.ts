/**
 * MCP (Model Context Protocol) 类型定义
 *
 * MCP 是 Anthropic 的标准协议,让 AI 模型与外部工具和数据源通信。
 *
 * 支持两种配置来源:
 * 1. cc-switch 格式: ~/.cc-switch/config.json (主要)
 * 2. Claude 原生格式: ~/.claude.json (兼容)
 */

/**
 * MCP 服务器连接规格
 * 支持三种连接方式: stdio, http, sse
 */
export interface McpServerSpec {
  /** 连接类型,默认为 stdio */
  type?: 'stdio' | 'http' | 'sse';

  // stdio 类型字段
  /** 执行命令 (stdio 类型必需) */
  command?: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;

  // http/sse 类型字段
  /** 服务器 URL (http/sse 类型必需) */
  url?: string;
  /** 请求头 */
  headers?: Record<string, string>;

  /** 允许扩展字段 */
  [key: string]: any;
}

/**
 * MCP 应用启用状态 (cc-switch v3.7.0 格式)
 * 标记服务器应用到哪些客户端
 */
export interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

/**
 * MCP 服务器完整配置
 */
export interface McpServer {
  /** 唯一标识符 (配置文件中的 key) */
  id: string;
  /** 显示名称 */
  name?: string;
  /** 服务器连接规格 */
  server: McpServerSpec;
  /** 应用启用状态 (cc-switch 格式) */
  apps?: McpApps;
  /** 描述 */
  description?: string;
  /** 标签 */
  tags?: string[];
  /** 主页链接 */
  homepage?: string;
  /** 文档链接 */
  docs?: string;
  /** 是否启用 (旧格式兼容) */
  enabled?: boolean;
  /** 允许扩展字段 */
  [key: string]: any;
}

/**
 * MCP 服务器映射 (id -> McpServer)
 */
export type McpServersMap = Record<string, McpServer>;

/**
 * cc-switch 配置文件结构 (~/.cc-switch/config.json)
 */
export interface CCSwitchConfig {
  /** MCP 配置 */
  mcp?: {
    /** 服务器列表 */
    servers?: Record<string, McpServer>;
  };
  /** Claude 供应商配置 */
  claude?: {
    providers?: Record<string, any>;
    current?: string;
  };
  /** 其他配置 */
  [key: string]: any;
}

/**
 * Claude 配置文件结构 (~/.claude.json)
 * 参考官方格式
 */
export interface ClaudeConfig {
  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerSpec>;
  /** 其他配置 */
  [key: string]: any;
}

/**
 * MCP 预设配置
 */
export interface McpPreset {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  server: McpServerSpec;
  homepage?: string;
  docs?: string;
}

/**
 * MCP 服务器状态
 */
export type McpServerStatus = 'connected' | 'checking' | 'error' | 'unknown';

/**
 * MCP 服务器连接状态信息 (来自 Claude SDK)
 */
export interface McpServerStatusInfo {
  /** 服务器名称 */
  name: string;
  /** 连接状态 */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending';
  /** 服务器信息 (连接成功时可用) */
  serverInfo?: {
    name: string;
    version: string;
  };
  /** 错误信息 (连接失败时可用) */
  error?: string;
}

/**
 * MCP 连接日志条目
 */
export interface McpLogEntry {
  /** 唯一标识符 */
  id: string;
  /** 时间戳 */
  timestamp: Date;
  /** 服务器名称 */
  serverName: string;
  /** 日志级别 */
  level: 'info' | 'warn' | 'error' | 'success';
  /** 日志消息 */
  message: string;
}

/**
 * MCP 服务器验证结果
 */
export interface McpServerValidationResult {
  valid: boolean;
  serverId?: string;
  errors?: string[];
  warnings?: string[];
}

// ==================== Codex MCP Types ====================

/**
 * Codex MCP 服务器连接规格
 * 配置格式基于 ~/.codex/config.toml
 *
 * 支持两种连接方式:
 * 1. STDIO: 本地命令行工具
 * 2. Streamable HTTP: 远程 HTTP 服务
 */
export interface CodexMcpServerSpec {
  // STDIO 类型字段
  /** 执行命令 (STDIO 类型必需) */
  command?: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
  /** 额外环境变量白名单 */
  env_vars?: string[];

  // Streamable HTTP 类型字段
  /** 服务器 URL (HTTP 类型必需) */
  url?: string;
  /** Bearer Token 环境变量名 */
  bearer_token_env_var?: string;
  /** HTTP 请求头 */
  http_headers?: Record<string, string>;
  /** 从环境变量读取的 HTTP 请求头 */
  env_http_headers?: Record<string, string>;

  // 通用可选字段
  /** 是否启用 */
  enabled?: boolean;
  /** 启动超时时间(秒) */
  startup_timeout_sec?: number;
  /** 工具调用超时时间(秒) */
  tool_timeout_sec?: number;
  /** 启用的工具列表 */
  enabled_tools?: string[];
  /** 禁用的工具列表 */
  disabled_tools?: string[];

  /** 允许扩展字段 */
  [key: string]: any;
}

/**
 * Codex MCP 服务器完整配置
 */
export interface CodexMcpServer {
  /** 唯一标识符 (配置文件中的 key) */
  id: string;
  /** 显示名称 */
  name?: string;
  /** 服务器连接规格 */
  server: CodexMcpServerSpec;
  /** 应用启用状态 */
  apps?: McpApps;
  /** 是否启用 */
  enabled?: boolean;
  /** 启动超时时间(秒) */
  startup_timeout_sec?: number;
  /** 工具调用超时时间(秒) */
  tool_timeout_sec?: number;
  /** 启用的工具列表 */
  enabled_tools?: string[];
  /** 禁用的工具列表 */
  disabled_tools?: string[];
  /** 允许扩展字段 */
  [key: string]: any;
}

/**
 * Codex config.toml 结构 (~/.codex/config.toml)
 */
export interface CodexConfig {
  /** MCP 服务器配置 */
  mcp_servers?: Record<string, CodexMcpServerSpec>;
  /** 其他配置 */
  [key: string]: any;
}

