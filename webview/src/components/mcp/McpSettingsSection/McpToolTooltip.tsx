/**
 * Tool hover tooltip popup for the MCP settings panel
 */

import { useRef } from 'react';
import type { McpTool } from '../types';
import { getToolIcon } from '../utils';

export interface HoveredToolState {
  serverId: string;
  tool: McpTool;
  position: { x: number; y: number };
}

export interface McpToolTooltipProps {
  hoveredTool: HoveredToolState | null;
  t: (key: string) => string;
}

export function McpToolTooltip({ hoveredTool, t }: McpToolTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);

  if (!hoveredTool) {
    return null;
  }

  const tooltipStyle: React.CSSProperties = {
    left: `${Math.min(hoveredTool.position.x, window.innerWidth - 420)}px`,
    top: `${hoveredTool.position.y}px`,
  };

  return (
    <div
      ref={tooltipRef}
      className="mcp-tool-tooltip"
      style={tooltipStyle}
    >
      <div className="tooltip-header">
        <span className="tooltip-icon">
          <span className={`codicon tool-icon ${getToolIcon(hoveredTool.tool.name)}`}></span>
        </span>
        <span className="tooltip-name">{hoveredTool.tool.name}</span>
      </div>
      {hoveredTool.tool.description && (
        <div className="tooltip-description">{hoveredTool.tool.description}</div>
      )}
      {hoveredTool.tool.inputSchema && (
        <div className="tooltip-params">
          {renderInputSchema(hoveredTool.tool.inputSchema, t)}
        </div>
      )}
    </div>
  );
}

/**
 * Render inputSchema as a parameter list
 */
function renderInputSchema(
  schema: Record<string, unknown> | undefined,
  t: (key: string) => string
): React.ReactElement {
  if (!schema) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  const properties = schema.properties as Record<string, { type?: string; description?: string }> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  return (
    <>
      {Object.entries(properties).map(([paramName, paramDef]) => {
        const isRequired = required.includes(paramName);
        const paramType = paramDef.type || 'unknown';
        const paramDesc = paramDef.description;

        return (
          <div key={paramName} className="tooltip-param">
            <div className="tooltip-param-name">{paramName}</div>
            {paramDesc && <div className="tooltip-param-desc">{paramDesc}</div>}
            <div className="tooltip-param-meta">
              <span className="tooltip-param-type">{paramType}</span>
              <span className={isRequired ? 'tooltip-param-required' : 'tooltip-param-optional'}>
                {isRequired ? t('mcp.required') : t('mcp.optional')}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
