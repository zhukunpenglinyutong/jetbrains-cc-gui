import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { agentProvider, CREATE_NEW_AGENT_ID, EMPTY_STATE_ID, type AgentItem } from '../providers/agentProvider';
import type { SelectedAgent } from '../types';
import {
  fetchNodeProcesses,
  subscribeNodeProcesses,
  type NodeProcessSnapshot,
} from '../../../utils/nodeProcessCapabilities';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { AgentMenuItem } from './AgentMenuItem';
import { RuntimeProviderMenuItem } from './RuntimeProviderMenuItem';
import { NodeProcessesMenuItem } from './NodeProcessesMenuItem';
import { ConfigSwitchOption } from './ConfigSwitchOption';
import { OfficialDocsOption } from './OfficialDocsOption';

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

const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  minWidth: '200px',
  maxWidth: 'calc(100vw - 16px)',
  overflow: 'visible',
};

const FAINT_DIVIDER_STYLE: React.CSSProperties = {
  height: 1,
  background: 'var(--dropdown-border)',
  margin: '4px 0',
  opacity: 0.5,
};

const TOAST_STYLE: React.CSSProperties = { zIndex: 20000 };

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

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const agentAbortControllerRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const { positionedStyle: mainPositionedStyle, recalculate: mainRecalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
  });

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
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
      const list = await agentProvider('', controller.signal);
      if (controller.signal.aborted) return;
      setAgentItems(list);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setAgentItems([{
        id: EMPTY_STATE_ID,
        name: t('settings.agent.loadFailed'),
        prompt: '',
      }, {
        id: CREATE_NEW_AGENT_ID,
        name: t('settings.agent.createAgent'),
        prompt: '',
      }]);
    } finally {
      if (!controller.signal.aborted) {
        setAgentsLoading(false);
      }
    }
  }, []);

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

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setActiveSubmenu('none');
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
      // 当确认对话框打开时跳过外部点击处理：点击确认/取消按钮会先触发 mousedown，
      // 若此时关闭 ConfigSelect 会让确认框随之卸载，导致 onConfirm 永不执行（issue #1522）
      if (document.querySelector('.confirm-dialog-overlay')) {
        return;
      }
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

  useLayoutEffect(() => {
    if (isOpen) {
      mainRecalculate();
    }
  }, [isOpen, mainRecalculate]);

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
          style={{ ...DROPDOWN_STYLE, ...mainPositionedStyle }}
        >
          {/* Agent Item */}
          <AgentMenuItem
            selectedAgent={selectedAgent}
            agents={agentItems}
            loading={agentsLoading}
            active={activeSubmenu === 'agent'}
            onEnter={() => setActiveSubmenu('agent')}
            onLeave={() => setActiveSubmenu('none')}
            onSelectAgent={(agent) => {
              onAgentSelect?.(agent);
              closeMenu();
            }}
            onCreateAgent={() => {
              closeMenu();
              onOpenAgentSettings?.();
            }}
          />

          {/* Runtime Provider Item — only Claude/Codex support switching */}
          <RuntimeProviderMenuItem
            currentProvider={currentProvider}
            active={activeSubmenu === 'runtimeProvider'}
            onEnter={() => setActiveSubmenu('runtimeProvider')}
            onLeave={() => setActiveSubmenu('none')}
            onProviderSwitched={showProviderToast}
            onClose={closeMenu}
          />

          <div className="selector-divider" />

          {/* Node Process Management Item */}
          <NodeProcessesMenuItem
            totals={nodeProcessTotals}
            active={activeSubmenu === 'nodeProcesses'}
            onEnter={() => setActiveSubmenu('nodeProcesses')}
            onLeave={() => setActiveSubmenu('none')}
            onToast={showGenericToast}
            onClose={closeMenu}
          />

          {/* Divider */}
          <div className="selector-divider" />

          {/* Streaming Switch Item */}
          <ConfigSwitchOption
            icon="codicon-sync"
            label={t('settings.basic.streaming.label')}
            value={streamingEnabled}
            defaultChecked
            onChange={onStreamingEnabledChange}
            onMouseEnter={() => setActiveSubmenu('none')}
          />

          {/* Divider */}
          <div style={FAINT_DIVIDER_STYLE} />

          {/* Thinking Switch Item */}
          <ConfigSwitchOption
            icon="codicon-lightbulb"
            label={t('common.thinking')}
            value={alwaysThinkingEnabled}
            defaultChecked={false}
            onChange={onToggleThinking}
            onMouseEnter={() => setActiveSubmenu('none')}
          />

          {/* Divider */}
          <div style={FAINT_DIVIDER_STYLE} />

          {/* Official Docs Item */}
          <OfficialDocsOption
            onClose={closeMenu}
            onMouseEnter={() => setActiveSubmenu('none')}
          />
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
