import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Switch } from 'antd';
import { Claude, OpenAI, Gemini } from '@lobehub/icons';
import { AVAILABLE_PROVIDERS } from '../types';
import { agentProvider, CREATE_NEW_AGENT_ID, EMPTY_STATE_ID, type AgentItem } from '../providers/agentProvider';
import type { SelectedAgent } from '../types';

interface ConfigSelectProps {
  currentProvider: string;
  onProviderChange: (providerId: string) => void;
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  selectedAgent?: SelectedAgent | null;
  onAgentSelect?: (agent: SelectedAgent) => void;
  onOpenAgentSettings?: () => void;
}

/**
 * Provider Icon Component
 */
const ProviderIcon = ({ providerId, size = 16, colored = false }: { providerId: string; size?: number; colored?: boolean }) => {
  switch (providerId) {
    case 'claude':
      return colored ? <Claude.Color size={size} /> : <Claude size={size} />;
    case 'codex':
      return <OpenAI.Avatar size={size} />;
    case 'gemini':
      return colored ? <Gemini.Color size={size} /> : <Gemini.Avatar size={size} />;
    default:
      return colored ? <Claude.Color size={size} /> : <Claude size={size} />;
  }
};

/**
 * ConfigSelect - Combined Configuration Selector
 * Contains CLI Tool Selection and Thinking Switch
 */
export const ConfigSelect = ({
  currentProvider: providerId,
  onProviderChange,
  alwaysThinkingEnabled,
  onToggleThinking,
  streamingEnabled,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
}: ConfigSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'none' | 'provider' | 'agent'>('none');
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const agentAbortControllerRef = useRef<AbortController | null>(null);

  const currentProviderInfo = AVAILABLE_PROVIDERS.find(p => p.id === providerId) || AVAILABLE_PROVIDERS[0];

  const showToastMessage = useCallback((message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, []);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
    if (!isOpen) {
      setActiveSubmenu('none');
    }
  }, [isOpen]);

  const handleProviderSelect = useCallback((pId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === pId);
    if (!provider) return;

    if (!provider.enabled) {
      showToastMessage(t('settings.provider.featureComingSoon'));
      return;
    }

    onProviderChange(pId);
    setIsOpen(false);
    setActiveSubmenu('none');
  }, [onProviderChange, showToastMessage, t]);

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
    };
  }, []);

  const renderProviderSubmenu = () => (
    <div
      className="selector-dropdown"
      style={{
        position: 'absolute',
        left: '100%',
        bottom: 0,
        marginLeft: '-30px',
        zIndex: 10001,
        minWidth: '180px'
      }}
    >
      {AVAILABLE_PROVIDERS.map((provider) => (
        <div
          key={provider.id}
          className={`selector-option ${provider.id === providerId ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            handleProviderSelect(provider.id);
          }}
        >
          <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ProviderIcon providerId={provider.id} size={14} colored={true} />
          </div>
          <span>{provider.label}</span>
          {provider.id === providerId && <span className="codicon codicon-check check-mark" />}
        </div>
      ))}
    </div>
  );

  const renderAgentSubmenu = () => (
    <div
      className="selector-dropdown"
      style={{
        position: 'absolute',
        left: '100%',
        bottom: 0,
        marginLeft: '-30px',
        zIndex: 10001,
        minWidth: '320px',
        maxWidth: '360px',
      }}
      onMouseEnter={(e) => {
        e.stopPropagation();
        setActiveSubmenu('agent');
      }}
    >
      {agentsLoading ? (
        <div className="selector-option" style={{ cursor: 'default' }}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('chat.loadingDropdown')}</span>
        </div>
      ) : (
        agentItems.map((agent) => {
          const isInfo = agent.id === EMPTY_STATE_ID;
          const isCreate = agent.id === CREATE_NEW_AGENT_ID;
          const isSelected = !!selectedAgent && selectedAgent.id === agent.id;

          return (
            <div
              key={agent.id}
              className={`selector-option ${isSelected ? 'selected' : ''} ${isInfo ? 'disabled' : ''}`}
              style={{
                alignItems: 'flex-start',
                cursor: isInfo ? 'default' : 'pointer',
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (isInfo) return;

                if (isCreate) {
                  setIsOpen(false);
                  setActiveSubmenu('none');
                  onOpenAgentSettings?.();
                  return;
                }

                onAgentSelect?.({ id: agent.id, name: agent.name, prompt: agent.prompt });
                setIsOpen(false);
                setActiveSubmenu('none');
              }}
            >
              <span className={`codicon ${isCreate ? 'codicon-add' : isInfo ? 'codicon-info' : 'codicon-robot'}`} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</span>
                {agent.prompt ? (
                  <span className="model-description" style={{ fontStyle: 'normal', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {agent.prompt.length > 60 ? agent.prompt.substring(0, 60) + '...' : agent.prompt}
                  </span>
                ) : isCreate ? (
                  <span className="model-description" style={{ fontStyle: 'normal' }}>{t('settings.agent.createAgentHint')}</span>
                ) : null}
              </div>
              {isSelected && <span className="codicon codicon-check check-mark" />}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        style={{ marginLeft: '5px', marginRight: '-2px' }}
        title={t('settings.configure', 'Configure')}
      >
        <span className="codicon codicon-settings" />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: '4px',
            zIndex: 10000,
            minWidth: '200px'
          }}
        >
          {/* CLI Tool Item */}
          <div 
            className="selector-option" 
            onMouseEnter={() => setActiveSubmenu('provider')}
            onMouseLeave={() => setActiveSubmenu('none')}
            style={{ position: 'relative' }}
          >
            <div style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ProviderIcon providerId={currentProviderInfo.id} size={14} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>{currentProviderInfo.label}</span>
            </div>
            <div 
              style={{ 
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'stretch',
                paddingLeft: '12px',
                cursor: 'pointer'
              }}
            >
              <span className="codicon codicon-chevron-right" style={{ fontSize: '12px' }} />
            </div>
            
            {activeSubmenu === 'provider' && renderProviderSubmenu()}
          </div>


          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Agent Item (Disabled) */}
          <div
            className="selector-option"
            onMouseEnter={() => setActiveSubmenu('agent')}
            onMouseLeave={() => setActiveSubmenu('none')}
            style={{ position: 'relative' }}
          >
            <span className="codicon codicon-robot" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span>{t('settings.agent.title')}</span>
              {selectedAgent?.name ? (
                <span className="model-description" style={{ fontStyle: 'normal' }}>
                  {selectedAgent.name}
                </span>
              ) : null}
            </div>
            <div 
              style={{ 
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                alignSelf: 'stretch',
                paddingLeft: '12px',
                cursor: 'pointer'
              }}
            >
              <span className="codicon codicon-chevron-right" style={{ fontSize: '12px' }} />
            </div>

            {activeSubmenu === 'agent' && renderAgentSubmenu()}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Streaming Switch Item */}
          <div
            className="selector-option"
            onClick={(e) => {
              e.stopPropagation();
              onStreamingEnabledChange?.(!streamingEnabled);
            }}
            onMouseEnter={() => setActiveSubmenu('none')}
            style={{ justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          <div style={{ height: 1, background: 'var(--dropdown-border)', margin: '4px 0', opacity: 0.5 }} />

          {/* Thinking Switch Item */}
          <div
            className="selector-option"
            onClick={(e) => {
              e.stopPropagation();
              onToggleThinking?.(!alwaysThinkingEnabled);
            }}
            onMouseEnter={() => setActiveSubmenu('none')}
            style={{ justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
        <div className="selector-toast" style={{ zIndex: 20000 }}>
          {toastMessage}
        </div>,
        document.body
      )}
    </div>
  );
};
