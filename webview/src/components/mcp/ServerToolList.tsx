/**
 * Server Tool List Component
 * Renders the tools section header and the list of tool rows
 */

import type { McpTool } from './types';
import { getToolIcon } from './utils';

export interface ServerToolListProps {
  tools: McpTool[];
  t: (key: string, options?: Record<string, unknown>) => string;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Tools section header + list of tool rows
 */
export function ServerToolList({ tools, t, onToolHover }: ServerToolListProps) {
  return (
    <>
      <div className="sidebar-section-header">
        {t('mcp.tools')} ({tools.length})
      </div>
      <div className="sidebar-tool-list">
        {tools.map((tool, index) => (
          <ServerToolItem key={index} tool={tool} onToolHover={onToolHover} />
        ))}
      </div>
    </>
  );
}

interface ServerToolItemProps {
  tool: McpTool;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Single tool row with hover-to-view details
 */
function ServerToolItem({ tool, onToolHover }: ServerToolItemProps) {
  return (
    <div
      className="sidebar-tool-item"
      title={tool.description || tool.name}
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onToolHover(tool, {
          x: rect.right + 8,
          y: rect.top
        });
      }}
      onMouseLeave={() => {
        onToolHover(null);
      }}
    >
      <span className={`codicon tool-icon ${getToolIcon(tool.name)}`}></span>
      <div className="tool-info">
        <span className="tool-name-text">{tool.name}</span>
      </div>
    </div>
  );
}
