import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpServerSpec } from '../../types/mcp';

interface McpServerDialogProps {
  server?: McpServer | null;
  existingIds?: string[];
  onClose: () => void;
  onSave: (server: McpServer) => void;
}

/**
 * MCP 服务器配置对话框（添加/编辑）
 */
export function McpServerDialog({ server, existingIds = [], onClose, onSave }: McpServerDialogProps) {
  const [saving, setSaving] = useState(false);
  const [jsonContent, setJsonContent] = useState('');
  const [parseError, setParseError] = useState('');
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // 示例占位符
  const placeholder = `// 示例:
// {
//   "mcpServers": {
//     "example-server": {
//       "command": "npx",
//       "args": [
//         "-y",
//         "mcp-server-example"
//       ]
//     }
//   }
// }`;

  // 计算行数
  const lineCount = Math.max((jsonContent || placeholder).split('\n').length, 12);

  // 验证 JSON 是否有效
  const isValid = useCallback(() => {
    if (!jsonContent.trim()) return false;

    // 移除注释行
    const cleanedContent = jsonContent
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');

    if (!cleanedContent.trim()) return false;

    try {
      const parsed = JSON.parse(cleanedContent);
      // 验证结构
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        return Object.keys(parsed.mcpServers).length > 0;
      }
      // 直接是服务器配置 (有 command 或 url)
      if (parsed.command || parsed.url) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [jsonContent]);

  // 处理输入
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonContent(e.target.value);
    setParseError('');
  };

  // 处理 Tab 键
  const handleTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = editorRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      setJsonContent(value.substring(0, start) + '  ' + value.substring(end));

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  // 解析 JSON 配置
  const parseConfig = (): McpServer[] | null => {
    try {
      // 移除注释行
      const cleanedContent = jsonContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');

      const parsed = JSON.parse(cleanedContent);
      const servers: McpServer[] = [];

      // mcpServers 格式
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const [id, config] of Object.entries(parsed.mcpServers)) {
          // 检查 ID 是否已存在（编辑模式除外）
          if (!server && existingIds.includes(id)) {
            setParseError(`服务器 ID "${id}" 已存在`);
            return null;
          }

          const serverConfig = config as any;
          const newServer: McpServer = {
            id,
            name: serverConfig.name || id,
            server: {
              type: serverConfig.type || (serverConfig.command ? 'stdio' : serverConfig.url ? 'http' : 'stdio'),
              command: serverConfig.command,
              args: serverConfig.args,
              env: serverConfig.env,
              url: serverConfig.url,
              headers: serverConfig.headers,
            } as McpServerSpec,
            apps: {
              claude: true,
              codex: false,
              gemini: false,
            },
            enabled: true,
          };
          servers.push(newServer);
        }
      }
      // 直接服务器配置格式
      else if (parsed.command || parsed.url) {
        const id = `server-${Date.now()}`;
        const newServer: McpServer = {
          id,
          name: parsed.name || id,
          server: {
            type: parsed.type || (parsed.command ? 'stdio' : 'http'),
            command: parsed.command,
            args: parsed.args,
            env: parsed.env,
            url: parsed.url,
            headers: parsed.headers,
          } as McpServerSpec,
          apps: {
            claude: true,
            codex: false,
            gemini: false,
          },
          enabled: true,
        };
        servers.push(newServer);
      }

      if (servers.length === 0) {
        setParseError('无法识别的配置格式');
        return null;
      }

      return servers;
    } catch (e) {
      setParseError(`JSON 解析错误: ${(e as Error).message}`);
      return null;
    }
  };

  // 确认保存
  const handleConfirm = async () => {
    const servers = parseConfig();
    if (!servers) return;

    setSaving(true);
    try {
      // 逐个保存服务器
      for (const srv of servers) {
        onSave(srv);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // 初始化编辑模式
  useEffect(() => {
    if (server) {
      // 编辑模式：转换为 JSON 格式
      const config: any = {
        mcpServers: {
          [server.id]: {
            ...server.server,
          },
        },
      };
      setJsonContent(JSON.stringify(config, null, 2));
    }
  }, [server]);

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-server-dialog">
        <div className="dialog-header">
          <h3>{server ? '编辑服务器' : '手动配置'}</h3>
          <div className="header-actions">
            <button className="mode-btn active">
              原始配置（JSON）
            </button>
            <button className="close-btn" onClick={onClose}>
              <span className="codicon codicon-close"></span>
            </button>
          </div>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            请输入 MCP Servers 配置 JSON（优先使用 NPX 或 UVX 配置）
          </p>

          <div className="json-editor">
            <div className="line-numbers">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i + 1} className="line-num">{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={editorRef}
              value={jsonContent}
              className="json-textarea"
              placeholder={placeholder}
              spellCheck="false"
              onChange={handleInput}
              onKeyDown={handleTab}
            />
          </div>

          {parseError && (
            <div className="error-message">
              <span className="codicon codicon-error"></span>
              {parseError}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <div className="footer-hint">
            <span className="codicon codicon-info"></span>
            配置前请自行确认来源，甄别风险
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>取消</button>
            <button
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={!isValid() || saving}
            >
              {saving && <span className="codicon codicon-loading codicon-modifier-spin"></span>}
              {saving ? '保存中...' : '确认'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
