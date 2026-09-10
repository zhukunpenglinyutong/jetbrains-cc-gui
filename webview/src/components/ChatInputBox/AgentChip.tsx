import React, { memo } from 'react';
import type { SelectedAgent } from './types';
import { CURSOR_DEFAULT_STYLE } from './contextBarStyles';

const ROBOT_ICON_STYLE: React.CSSProperties = { marginRight: 4 };

interface AgentChipProps {
  agent: SelectedAgent;
  onClearAgent?: () => void;
}

/** Selected Agent chip shown in the ContextBar. */
export const AgentChip: React.FC<AgentChipProps> = memo(({ agent, onClearAgent }) => (
  <div
    className="context-item has-tooltip"
    data-tooltip={agent.name}
    style={CURSOR_DEFAULT_STYLE}
  >
    <span
      className="codicon codicon-robot"
      style={ROBOT_ICON_STYLE}
    />
    <span className="context-text">
      <span dir="ltr">
        {agent.name.length > 3
          ? `${agent.name.slice(0, 3)}...`
          : agent.name}
      </span>
    </span>
    <span
      className="codicon codicon-close context-close"
      onClick={onClearAgent}
      title="Remove agent"
    />
  </div>
));
