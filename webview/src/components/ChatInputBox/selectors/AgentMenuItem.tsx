import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CREATE_NEW_AGENT_ID, EMPTY_STATE_ID, type AgentItem } from '../providers/agentProvider';
import type { SelectedAgent } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import {
  AGENT_DESC_PLAIN_STYLE,
  ARROW_CONTAINER_STYLE,
  ARROW_ICON_STYLE,
  ITEM_INFO_STYLE,
  SELECTOR_OPTION_RELATIVE_STYLE,
} from './selectorStyles';

const SUBMENU_BASE_STYLE: React.CSSProperties = {
  minWidth: 0,
  maxWidth: '360px',
  maxHeight: '300px',
  overflowY: 'auto',
};

const LOADING_OPTION_STYLE: React.CSSProperties = { cursor: 'default' };

const AGENT_BODY_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
};

const AGENT_NAME_STYLE: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const AGENT_DESC_STYLE: React.CSSProperties = {
  fontStyle: 'normal',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

function getAgentOptionStyle(isInfo: boolean): React.CSSProperties {
  return {
    alignItems: 'flex-start',
    cursor: isInfo ? 'default' : 'pointer',
  };
}

interface AgentMenuItemProps {
  selectedAgent?: SelectedAgent | null;
  agents: AgentItem[];
  loading: boolean;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onSelectAgent: (agent: SelectedAgent) => void;
  onCreateAgent: () => void;
}

/**
 * AgentMenuItem - Agent trigger row inside the ConfigSelect dropdown plus its
 * hover submenu listing the available agents (loading state included).
 */
export const AgentMenuItem = ({
  selectedAgent,
  agents,
  loading,
  active,
  onEnter,
  onLeave,
  onSelectAgent,
  onCreateAgent,
}: AgentMenuItemProps) => {
  const { t } = useTranslation();
  const agentTriggerRef = useRef<HTMLDivElement>(null);
  const agentSubmenuRef = useRef<HTMLDivElement>(null);

  const { positionedStyle, maxHeight, maxWidth, recalculate } = useDropdownPosition({
    buttonRef: agentTriggerRef,
    dropdownRef: agentSubmenuRef,
    submenu: true,
    minWidth: 260,
    maxWidth: 360,
    submenuMaxHeight: 300,
    submenuBottomClearance: 96,
  });

  useLayoutEffect(() => {
    if (!active) return;
    recalculate();
  }, [active, agents.length, loading, recalculate]);

  const submenuMaxHeightPx = maxHeight ? `${Math.min(300, maxHeight)}px` : '300px';

  return (
    <div
      ref={agentTriggerRef}
      className="selector-option"
      data-testid="config-option-agent"
      onMouseEnter={() => {
        onEnter();
        recalculate();
      }}
      onMouseLeave={onLeave}
      style={SELECTOR_OPTION_RELATIVE_STYLE}
    >
      <span className="codicon codicon-robot" />
      <div style={ITEM_INFO_STYLE}>
        <span>{t('settings.agent.title')}</span>
        {selectedAgent?.name ? (
          <span className="model-description" style={AGENT_DESC_PLAIN_STYLE}>
            {selectedAgent.name}
          </span>
        ) : null}
      </div>
      <div style={ARROW_CONTAINER_STYLE}>
        <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
      </div>

      {active && (
        <div
          ref={agentSubmenuRef}
          className="selector-dropdown"
          style={{
            ...SUBMENU_BASE_STYLE,
            maxWidth: maxWidth ?? 360,
            ...positionedStyle,
            maxHeight: submenuMaxHeightPx,
          }}
          onMouseEnter={(e) => {
            e.stopPropagation();
            onEnter();
          }}
        >
          {loading ? (
            <div className="selector-option" style={LOADING_OPTION_STYLE}>
              <span className="codicon codicon-loading codicon-modifier-spin" />
              <span>{t('chat.loadingDropdown')}</span>
            </div>
          ) : (
            agents.map((agent) => {
              const isInfo = agent.id === EMPTY_STATE_ID;
              const isCreate = agent.id === CREATE_NEW_AGENT_ID;
              const isSelected = !!selectedAgent && selectedAgent.id === agent.id;

              return (
                <div
                  key={agent.id}
                  className={`selector-option ${isSelected ? 'selected' : ''} ${isInfo ? 'disabled' : ''}`}
                  style={getAgentOptionStyle(isInfo)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isInfo) return;

                    if (isCreate) {
                      onCreateAgent();
                      return;
                    }

                    onSelectAgent({ id: agent.id, name: agent.name, prompt: agent.prompt });
                  }}
                >
                  <span className={`codicon ${isCreate ? 'codicon-add' : isInfo ? 'codicon-info' : 'codicon-robot'}`} />
                  <div style={AGENT_BODY_STYLE}>
                    <span style={AGENT_NAME_STYLE}>{agent.name}</span>
                    {agent.prompt ? (
                      <span className="model-description" style={AGENT_DESC_STYLE}>
                        {agent.prompt.length > 60 ? agent.prompt.substring(0, 60) + '...' : agent.prompt}
                      </span>
                    ) : isCreate ? (
                      <span className="model-description" style={AGENT_DESC_PLAIN_STYLE}>{t('settings.agent.createAgentHint')}</span>
                    ) : null}
                  </div>
                  {isSelected && <span className="codicon codicon-check check-mark" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default AgentMenuItem;
