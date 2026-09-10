/**
 * Server Tools List Panel Component
 * Displays the server's tools list with hover-to-view tool details
 */

import type { ServerToolsState, McpTool } from './types';
import { ServerToolsHeader } from './ServerToolsHeader';
import { ServerToolsContent } from './ServerToolsContent';

export interface ServerToolsPanelProps {
  toolsInfo?: ServerToolsState[string];
  isConnected: boolean;
  isCodexMode: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLoadTools: (forceRefresh: boolean) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Server Tools List Panel
 */
export function ServerToolsPanel({
  toolsInfo,
  isConnected,
  t,
  onLoadTools,
  onToolHover,
}: ServerToolsPanelProps) {
  // Tool results are only meaningful while the server is connected. Keeping a
  // stale empty result visible after a disconnect makes the panel report
  // "no tools" instead of the actual connection state.
  const visibleToolsInfo = isConnected ? toolsInfo : undefined;
  const emptyToolsResult = isEmptyToolsResult(visibleToolsInfo);

  return (
    <div className="server-detail-panel">
      {/* Tools list */}
      <div className="server-sidebar">
        <ServerToolsHeader
          toolsInfo={toolsInfo}
          visibleToolsInfo={visibleToolsInfo}
          isConnected={isConnected}
          t={t}
          onLoadTools={onLoadTools}
        />
        <ServerToolsContent
          toolsInfo={toolsInfo}
          visibleToolsInfo={visibleToolsInfo}
          isConnected={isConnected}
          emptyToolsResult={emptyToolsResult}
          t={t}
          onToolHover={onToolHover}
        />
      </div>
    </div>
  );
}

export function isEmptyToolsResult(toolsInfo: ServerToolsState[string] | undefined): boolean {
  return toolsInfo != null
    && !toolsInfo.loading
    && !toolsInfo.error
    && toolsInfo.tools.length === 0;
}
