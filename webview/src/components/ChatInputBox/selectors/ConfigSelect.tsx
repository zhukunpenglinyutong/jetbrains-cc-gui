import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';
import { agentProvider, CREATE_NEW_AGENT_ID, EMPTY_STATE_ID, type AgentItem } from '../providers/agentProvider';
import { openCodeAgentProvider } from '../providers/openCodeAgentProvider';
import type { SelectedAgent } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { RuntimeProviderSelect } from './RuntimeProviderSelect';
import { NodeProcessSelect } from './NodeProcessSelect';
import {
  fetchNodeProcesses,
  subscribeNodeProcesses,
  type NodeProcessSnapshot,
} from '../../../utils/nodeProcessCapabilities';

interface ConfigSelectProps {
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  selectedAgent?: SelectedAgent | null;
  onAgentSelect?: (agent: SelectedAgent) => void;
  onOpenAgentSettings?: () => void;
  currentProvider?: string;
}

const WRAPPER_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
};

const TOGGLE_BUTTON_STYLE: React.CSSProperties = {
  marginLeft: '5px',
  marginRight: '-2px',
};

const SUBMENU_BASE_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  zIndex: 10001,
  minWidth: '320px',
  maxWidth: '360px',
  maxHeight: '300px',
  overflowY: 'auto',
};

const LOADING_OPTION_STYLE: React.CSSProperties = { cursor: 'default' };
const SECTION_HEADER_STYLE: React.CSSProperties = {
  cursor: 'default',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0,
};

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

const AGENT_DESC_PLAIN_STYLE: React.CSSProperties = {
  fontStyle: 'normal',
};

const DROPDOWN_BASE_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  minWidth: '200px',
};

const SELECTOR_OPTION_RELATIVE_STYLE: React.CSSProperties = { position: 'relative' };

const ITEM_INFO_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
};

const ARROW_CONTAINER_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  alignSelf: 'stretch',
  paddingLeft: '12px',
  cursor: 'pointer',
};

const ARROW_ICON_STYLE: React.CSSProperties = { fontSize: '12px' };

const SWITCH_OPTION_STYLE: React.CSSProperties = {
  justifyContent: 'space-between',
  cursor: 'pointer',
};

const SWITCH_LABEL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const FAINT_DIVIDER_STYLE: React.CSSProperties = {
  height: 1,
  background: 'var(--dropdown-border)',
  margin: '4px 0',
  opacity: 0.5,
};

const TOAST_STYLE: React.CSSProperties = { zIndex: 20000 };

function getAgentOptionStyle(isInfo: boolean): React.CSSProperties {
  return {
    alignItems: 'flex-start',
    cursor: isInfo ? 'default' : 'pointer',
  };
}

/**
 * ConfigSelect - Configuration menu (Agent, Streaming, Thinking)
 * Provider selection has been moved to a standalone ProviderSelect icon button.
 */
export const ConfigSelect = ({
  alwaysThinkingEnabled,
  onToggleThinking,
  streamingEnabled,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  currentProvider = 'claude',
}: ConfigSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'none' | 'agent' | 'runtimeProvider' | 'nodeProcesses'>('none');
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [nodeProcessTotals, setNodeProcessTotals] = useState<{ all: number; orphan: number }>({ all: 0, orphan: 0 });
  const supportsRuntimeProviderSwitch = currentProvider === 'claude' || currentProvider === 'codex';
  const displayedSelectedAgent = selectedAgent;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const agentTriggerRef = useRef<HTMLDivElement>(null);
  const runtimeProviderTriggerRef = useRef<HTMLDivElement>(null);
  const agentAbortControllerRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const { positionedStyle: mainPositionedStyle, recalculate: mainRecalculate } = useDropdownPosition({
    buttonRef,
  });
  const { positionedStyle: submenuPositionedStyle, recalculate: submenuRecalculate } = useDropdownPosition({
    buttonRef: agentTriggerRef,
    submenu: true,
  });

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !isOpen;
    setIsOpen(next);
    if (next) {
      setActiveSubmenu('none');
      mainRecalculate();
    }
  }, [isOpen, mainRecalculate]);

  const loadAgents = useCallback(async () => {
    if (agentAbortControllerRef.current) {
      agentAbortControllerRef.current.abort();
    }

    const controller = new AbortController();
    agentAbortControllerRef.current = controller;

    setAgentsLoading(true);
    try {
      const provider = currentProvider === 'opencode' ? openCodeAgentProvider : agentProvider;
      const list = await provider('', controller.signal);
      if (controller.signal.aborted) return;
      setAgentItems(list);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      const failedItem: AgentItem = {
        id: EMPTY_STATE_ID,
        name: t('settings.agent.loadFailed'),
        prompt: '',
        provider: currentProvider === 'opencode' ? 'opencode' : 'custom',
      };
      setAgentItems(currentProvider === 'opencode'
        ? [failedItem]
        : [failedItem, {
          id: CREATE_NEW_AGENT_ID,
          name: t('settings.agent.createAgent'),
          prompt: '',
        }]);
    } finally {
      if (!controller.signal.aborted) {
        setAgentsLoading(false);
      }
    }
  }, [currentProvider, t]);

  const showProviderToast = useCallback((providerName: string) => {
    if (toastTimerRef.current !== undefined) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(t('config.runtimeProvider.switched', { provider: providerName }));
    setShowToast(true);
    toastTimerRef.current = window.setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, [t]);

  const showGenericToast = useCallback((message: string) => {
    if (!message) return;
    if (toastTimerRef.current !== undefined) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    setShowToast(true);
    toastTimerRef.current = window.setTimeout(() => {
      setShowToast(false);
    }, 1800);
  }, []);

  // Subscribe to node process snapshots so the badge counter stays in sync
  // with whatever the panel (or other consumers) see.
  useEffect(() => {
    const unsubscribe = subscribeNodeProcesses((snapshot: NodeProcessSnapshot) => {
      setNodeProcessTotals({ all: snapshot.totals.all, orphan: snapshot.totals.orphan });
    });
    return unsubscribe;
  }, []);

  // Refresh node process counts whenever the main menu opens, so the badge
  // is accurate before the user even hovers over the submenu.
  useEffect(() => {
    if (isOpen) {
      fetchNodeProcesses();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setActiveSubmenu('none');
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (activeSubmenu !== 'agent') return;
    loadAgents();
  }, [activeSubmenu, loadAgents]);

  useEffect(() => {
    return () => {
      if (agentAbortControllerRef.current) {
        agentAbortControllerRef.current.abort();
      }
      if (toastTimerRef.current !== undefined) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const renderAgentSubmenu = () => {
    const submenuStyle: React.CSSProperties = {
      ...SUBMENU_BASE_STYLE,
      ...submenuPositionedStyle,
    };
    if (submenuPositionedStyle.left === '100%') {
      submenuStyle.marginLeft = '-30px';
    }
    if (submenuPositionedStyle.right === '100%') {
      submenuStyle.marginRight = '-30px';
    }
    return (
    <div
      className="selector-dropdown"
      style={submenuStyle}
      onMouseEnter={(e) => {
        e.stopPropagation();
        setActiveSubmenu('agent');
      }}
    >
      {agentsLoading ? (
        <div className="selector-option" style={LOADING_OPTION_STYLE}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('chat.loadingDropdown')}</span>
        </div>
      ) : (
        agentItems.map((agent) => {
          if (agent.kind === 'section-header') {
            return (
              <div
                key={agent.id}
                className="selector-option disabled"
                style={SECTION_HEADER_STYLE}
                onClick={(e) => e.stopPropagation()}
              >
                <span>{agent.name}</span>
              </div>
            );
          }

          const isInfo = agent.id === EMPTY_STATE_ID;
          const isCreate = agent.id === CREATE_NEW_AGENT_ID;
          const isSelected = !!displayedSelectedAgent && displayedSelectedAgent.id === agent.id;
          const description = agent.description || agent.prompt;

          return (
            <div
              key={agent.id}
              className={`selector-option ${isSelected ? 'selected' : ''} ${isInfo ? 'disabled' : ''}`}
              style={getAgentOptionStyle(isInfo)}
              onClick={(e) => {
                e.stopPropagation();
                if (isInfo) return;

                if (isCreate) {
                  setIsOpen(false);
                  setActiveSubmenu('none');
                  onOpenAgentSettings?.();
                  return;
                }

                onAgentSelect?.({
                  id: agent.id,
                  name: agent.name,
                  prompt: agent.prompt,
                  description: agent.description,
                  provider: agent.provider,
                  mode: agent.mode,
                  agentID: agent.agentID,
                });
                setIsOpen(false);
                setActiveSubmenu('none');
              }}
            >
              <span className={`codicon ${isCreate ? 'codicon-add' : isInfo ? 'codicon-info' : 'codicon-robot'}`} />
              <div style={AGENT_BODY_STYLE}>
                <span style={AGENT_NAME_STYLE}>{agent.name}</span>
                {description ? (
                  <span className="model-description" style={AGENT_DESC_STYLE}>
                    {description.length > 60 ? description.substring(0, 60) + '...' : description}
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
  );
};

  return (
    <div style={WRAPPER_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        style={TOGGLE_BUTTON_STYLE}
        title={t('settings.configure', 'Configure')}
      >
        <span className="codicon codicon-settings" />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_BASE_STYLE, ...mainPositionedStyle }}
        >
          {/* Agent Item */}
          <div
            ref={agentTriggerRef}
            className="selector-option"
            onMouseEnter={() => {
              setActiveSubmenu('agent');
              submenuRecalculate();
            }}
            onMouseLeave={() => setActiveSubmenu('none')}
            style={SELECTOR_OPTION_RELATIVE_STYLE}
          >
            <span className="codicon codicon-robot" />
            <div style={ITEM_INFO_STYLE}>
              <span>{t('settings.agent.title')}</span>
              {displayedSelectedAgent?.name ? (
                <span className="model-description" style={AGENT_DESC_PLAIN_STYLE}>
                  {displayedSelectedAgent.name}
                </span>
              ) : null}
            </div>
            <div style={ARROW_CONTAINER_STYLE}>
              <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
            </div>

            {activeSubmenu === 'agent' && renderAgentSubmenu()}
          </div>

          {supportsRuntimeProviderSwitch && (
            <>
              <div className="selector-divider" />

              {/* Runtime Provider Item */}
              <div
                ref={runtimeProviderTriggerRef}
                className="selector-option"
                onMouseEnter={() => setActiveSubmenu('runtimeProvider')}
                onMouseLeave={() => setActiveSubmenu('none')}
                style={SELECTOR_OPTION_RELATIVE_STYLE}
              >
                <span className="codicon codicon-vm-connect" />
                <div style={ITEM_INFO_STYLE}>
                  <span>{t('config.runtimeProvider.title')}</span>
                </div>
                <div style={ARROW_CONTAINER_STYLE}>
                  <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
                </div>

                {activeSubmenu === 'runtimeProvider' && (
                  <RuntimeProviderSelect
                    currentProvider={currentProvider}
                    embedded
                    triggerRef={runtimeProviderTriggerRef}
                    onProviderSwitched={showProviderToast}
                    onClose={() => {
                      setIsOpen(false);
                      setActiveSubmenu('none');
                    }}
                  />
                )}
              </div>
            </>
          )}

          <div className="selector-divider" />

          {/* Node Process Management Item */}
          <div
            className="selector-option"
            onMouseEnter={() => setActiveSubmenu('nodeProcesses')}
            onMouseLeave={() => setActiveSubmenu('none')}
            style={SELECTOR_OPTION_RELATIVE_STYLE}
          >
            <span className="codicon codicon-server-process" />
            <div style={ITEM_INFO_STYLE}>
              <span>{t('config.nodeProcesses.title', { defaultValue: 'Node 进程管理' })}</span>
              {nodeProcessTotals.all > 0 ? (
                <span className="model-description" style={AGENT_DESC_PLAIN_STYLE}>
                  {nodeProcessTotals.orphan > 0
                    ? t('config.nodeProcesses.badgeWithOrphan', {
                        total: nodeProcessTotals.all,
                        orphan: nodeProcessTotals.orphan,
                        defaultValue: '{{total}} 个 · {{orphan}} 孤立 ⚠',
                      })
                    : t('config.nodeProcesses.badge', {
                        total: nodeProcessTotals.all,
                        defaultValue: '{{total}} 个进程',
                      })}
                </span>
              ) : null}
            </div>
            <div style={ARROW_CONTAINER_STYLE}>
              <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
            </div>

            {activeSubmenu === 'nodeProcesses' && (
              <NodeProcessSelect
                embedded
                onToast={showGenericToast}
                onClose={() => {
                  setIsOpen(false);
                  setActiveSubmenu('none');
                }}
              />
            )}
          </div>

          {/* Divider */}
          <div className="selector-divider" />

          {/* Streaming Switch Item */}
          <div
            className="selector-option"
            onClick={(e) => {
              e.stopPropagation();
              onStreamingEnabledChange?.(!streamingEnabled);
            }}
            onMouseEnter={() => setActiveSubmenu('none')}
            style={SWITCH_OPTION_STYLE}
          >
            <div style={SWITCH_LABEL_STYLE}>
              <span className="codicon codicon-sync" />
              <span>{t('settings.basic.streaming.label')}</span>
            </div>
            <Switch
              size="small"
              checked={streamingEnabled ?? true}
              onClick={(checked, e) => {
                 e.stopPropagation();
                 onStreamingEnabledChange?.(checked);
              }}
            />
          </div>

          {/* Divider */}
          <div style={FAINT_DIVIDER_STYLE} />

          {/* Thinking Switch Item */}
          <div
            className="selector-option"
            onClick={(e) => {
              e.stopPropagation();
              onToggleThinking?.(!alwaysThinkingEnabled);
            }}
            onMouseEnter={() => setActiveSubmenu('none')}
            style={SWITCH_OPTION_STYLE}
          >
            <div style={SWITCH_LABEL_STYLE}>
              <span className="codicon codicon-lightbulb" />
              <span>{t('common.thinking')}</span>
            </div>
            <Switch
              size="small"
              checked={alwaysThinkingEnabled ?? false}
              onClick={(checked, e) => {
                 e.stopPropagation();
                 onToggleThinking?.(checked);
              }}
            />
          </div>
        </div>
      )}

      {showToast && createPortal(
        <div className="selector-toast" style={TOAST_STYLE}>
          {toastMessage}
        </div>,
        document.body
      )}
    </div>
  );
};
