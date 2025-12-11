import { useTranslation } from 'react-i18next';
import type { McpPreset } from '../../types/mcp';

interface McpPresetDialogProps {
  onClose: () => void;
  onSelect: (preset: McpPreset) => void;
}

/**
 * MCP 预设服务器选择对话框
 */
export function McpPresetDialog({ onClose, onSelect }: McpPresetDialogProps) {
  const { t } = useTranslation();
  // MCP 预设服务器配置
  const MCP_PRESETS: McpPreset[] = [
    {
      id: 'fetch',
      name: 'mcp-server-fetch',
      description: t('mcp.presets.fetch'),
      tags: ['stdio', 'http', 'web'],
      server: {
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
      },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    },
    {
      id: 'time',
      name: '@modelcontextprotocol/server-time',
      description: t('mcp.presets.time'),
      tags: ['stdio', 'time', 'utility'],
      server: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-time'],
      },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    },
    {
      id: 'memory',
      name: '@modelcontextprotocol/server-memory',
      description: t('mcp.presets.memory'),
      tags: ['stdio', 'memory', 'graph'],
      server: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    },
    {
      id: 'sequential-thinking',
      name: '@modelcontextprotocol/server-sequential-thinking',
      description: t('mcp.presets.sequentialThinking'),
      tags: ['stdio', 'thinking', 'reasoning'],
      server: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    },
    {
      id: 'context7',
      name: '@upstash/context7-mcp',
      description: t('mcp.presets.context7'),
      tags: ['stdio', 'docs', 'search'],
      server: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      },
      homepage: 'https://context7.com',
      docs: 'https://github.com/upstash/context7/blob/master/README.md',
    },
  ];

  // 服务器图标颜色
  const iconColors = [
    '#3B82F6', // blue
    '#10B981', // green
    '#8B5CF6', // purple
    '#F59E0B', // amber
    '#EF4444', // red
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#6366F1', // indigo
  ];

  const getIconColor = (presetId: string): string => {
    let hash = 0;
    for (let i = 0; i < presetId.length; i++) {
      hash = presetId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return iconColors[Math.abs(hash) % iconColors.length];
  };

  const getServerType = (preset: McpPreset): string => {
    return preset.server.type || 'stdio';
  };

  const getServerTypeLabel = (preset: McpPreset): string => {
    const type = getServerType(preset);
    const labels: Record<string, string> = {
      stdio: 'STDIO',
      http: 'HTTP',
      sse: 'SSE',
    };
    return labels[type] || type.toUpperCase();
  };

  const handleSelect = (preset: McpPreset) => {
    onSelect(preset);
  };

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-preset-dialog">
        <div className="dialog-header">
          <h3>选择预设服务器</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            选择一个预设的 MCP 服务器快速添加。这些是官方推荐的常用工具。
          </p>

          <div className="preset-list">
            {MCP_PRESETS.map(preset => (
              <div
                key={preset.id}
                className="preset-item"
                onClick={() => handleSelect(preset)}
              >
                <div className="preset-icon" style={{ background: getIconColor(preset.id) }}>
                  {preset.name.charAt(0).toUpperCase()}
                </div>
                <div className="preset-info">
                  <h4 className="preset-name">{preset.name}</h4>
                  {preset.description && <p className="preset-desc">{preset.description}</p>}
                  <div className="preset-meta">
                    <span className={`type-badge ${getServerType(preset)}`}>
                      {getServerTypeLabel(preset)}
                    </span>
                    {preset.tags && (
                      <span className="preset-tags">
                        {preset.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="tag">{tag}</span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
                <span className="add-icon codicon codicon-add"></span>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer">
          <div className="footer-hint">
            <span className="codicon codicon-info"></span>
            点击预设项即可添加
          </div>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
