import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { subagentStatusIconMap } from './types';
import SubagentProcessDetails from './SubagentProcessDetails';

interface SubagentListProps {
  subagents: SubagentInfo[];
  histories?: Record<string, SubagentHistoryResponse>;
  currentSessionId?: string | null;
  isStreaming?: boolean;
}

const SubagentList = memo(({ subagents, histories = {}, currentSessionId, isStreaming = false }: SubagentListProps) => {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Keep latest subagents/histories in refs so the polling effect can read fresh
  // values without re-running (and rebuilding the interval) on every change.
  const subagentsRef = useRef(subagents);
  const historiesRef = useRef(histories);
  useEffect(() => { subagentsRef.current = subagents; }, [subagents]);
  useEffect(() => { historiesRef.current = histories; }, [histories]);

  const requestHistory = useCallback((subagent: SubagentInfo) => {
    if (!currentSessionId) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      agentId: subagent.agentId,
      description: subagent.description,
      toolUseId: subagent.id,
    }));
  }, [currentSessionId]);

  useEffect(() => {
    if (!expandedId) return;
    const subagent = subagentsRef.current.find((item) => item.id === expandedId);
    if (!subagent || !currentSessionId) return;
    if (!historiesRef.current[expandedId]) {
      requestHistory(subagent);
    }
    if (!isStreaming || subagent.status !== 'running') return;
    const timer = window.setInterval(() => {
      const current = subagentsRef.current.find((item) => item.id === expandedId);
      if (!current || current.status !== 'running') return;
      requestHistory(current);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [currentSessionId, expandedId, isStreaming, requestHistory]);

  const historyById = useMemo(() => histories, [histories]);

  if (subagents.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noSubagents')}</div>;
  }

  return (
    <div className="subagent-list">
      {subagents.map((subagent, index) => {
        const statusIcon = subagentStatusIconMap[subagent.status] ?? 'codicon-circle-outline';
        const statusClass = `status-${subagent.status}`;
        const isExpanded = expandedId === subagent.id;
        const history = historyById[subagent.id] ?? (subagent.agentId ? historyById[subagent.agentId] : undefined);

        return (
          <div key={subagent.id ?? index} className={`subagent-item-wrapper ${statusClass}`}>
            <button
              type="button"
              className={`subagent-item ${statusClass}`}
              onClick={() => setExpandedId((prev) => (prev === subagent.id ? null : subagent.id))}
            >
              <span className={`subagent-status-icon ${statusClass}`}>
                <span className={`codicon ${statusIcon}`} />
              </span>
              <span className="subagent-type">{subagent.type || t('statusPanel.subagentTab')}</span>
              <span className="subagent-description" title={subagent.prompt}>
                {subagent.description || subagent.prompt?.slice(0, 50)}
              </span>
              <span className={`subagent-chevron codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
            </button>

            {isExpanded && (
              <SubagentProcessDetails
                agentId={subagent.agentId}
                totalDurationMs={subagent.totalDurationMs}
                totalTokens={subagent.totalTokens}
                totalToolUseCount={subagent.totalToolUseCount}
                resultText={subagent.resultText}
                history={history}
                canLoad={Boolean(currentSessionId)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

SubagentList.displayName = 'SubagentList';

export default SubagentList;
