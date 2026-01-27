import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpServerSpec } from '../../types/mcp';

interface McpServerDialogProps {
  server?: McpServer | null;
  existingIds?: string[];
  currentProvider?: 'claude' | 'codex' | string;
  onClose: () => void;
  onSave: (server: McpServer) => void;
}

/**
 * MCP Server Configuration Dialog (Add/Edit)
 * Supports both Claude and Codex providers
 */
export function McpServerDialog({ server, existingIds = [], currentProvider = 'claude', onClose, onSave }: McpServerDialogProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  const [saving, setSaving] = useState(false);
  const [jsonContent, setJsonContent] = useState('');
  const [parseError, setParseError] = useState('');
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Placeholder examples based on provider
  const claudePlaceholder = `// demo:
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

  const codexPlaceholder = `// Codex MCP Server Example:
// {
//   "mcpServers": {
//     "context7": {
//       "command": "npx",
//       "args": ["-y", "@upstash/context7-mcp"],
//       "env": {
//         "CONTEXT7_API_KEY": "your-api-key"
//       },
//       "startup_timeout_sec": 20,
//       "tool_timeout_sec": 60
//     }
//   }
// }`;

  const placeholder = isCodexMode ? codexPlaceholder : claudePlaceholder;

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
          // Check if ID already exists (except in edit mode)
          if (!server && existingIds.includes(id)) {
            setParseError(t('mcp.serverDialog.errors.idExists', { id }));
            return null;
          }

          const serverConfig = config as any;
          // 保留所有原始字段，只设置默认的 type
          const serverSpec = {
            ...serverConfig,
            type: serverConfig.type || (serverConfig.command ? 'stdio' : serverConfig.url ? 'http' : 'stdio'),
          };
          // 移除不属于 server spec 的字段
          delete serverSpec.name;

          const newServer: McpServer = {
            id,
            name: serverConfig.name || id,
            server: serverSpec as McpServerSpec,
            apps: {
              claude: !isCodexMode,
              codex: isCodexMode,
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
        // 保留所有原始字段
        const serverSpec = {
          ...parsed,
          type: parsed.type || (parsed.command ? 'stdio' : 'http'),
        };
        // 移除不属于 server spec 的字段
        delete serverSpec.name;

        const newServer: McpServer = {
          id,
          name: parsed.name || id,
          server: serverSpec as McpServerSpec,
          apps: {
            claude: !isCodexMode,
            codex: isCodexMode,
            gemini: false,
          },
          enabled: true,
        };
        servers.push(newServer);
      }

      if (servers.length === 0) {
        setParseError(t('mcp.serverDialog.errors.unrecognizedFormat'));
        return null;
      }

      return servers;
    } catch (e) {
      setParseError(t('mcp.serverDialog.errors.jsonParseError', { message: (e as Error).message }));
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
          <h3>{server ? t('mcp.serverDialog.editTitle') : t('mcp.serverDialog.addTitle')}</h3>
          <div className="header-actions">
            <button className="mode-btn active">
              {t('mcp.serverDialog.rawConfig')}
            </button>
            <button className="close-btn" onClick={onClose}>
              <span className="codicon codicon-close"></span>
            </button>
          </div>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {t('mcp.serverDialog.description')}
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
            {t('mcp.serverDialog.securityWarning')}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button
              className="btn btn-primary"
              onClick={handleConfirm}
              disabled={!isValid() || saving}
            >
              {saving && <span className="codicon codicon-loading codicon-modifier-spin"></span>}
              {saving ? t('mcp.serverDialog.saving') : t('common.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
