import { useTranslation } from 'react-i18next';
import type { SubagentHistoryResponse, ToolInput } from '../../types';
import type { SpawnAgentMeta } from '../../utils/subagentResult';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';

interface TaskExecutionDetailsProps {
  spawnMeta: SpawnAgentMeta;
  isSpawnAgent: boolean;
  isAgentTool: boolean;
  detailAgentId?: string;
  detailDurationMs?: number;
  detailTokens?: number;
  detailToolUseCount?: number;
  detailResultText?: string;
  promptText?: string;
  rest: ToolInput;
  history?: SubagentHistoryResponse;
  canLoad: boolean;
}

export default function TaskExecutionDetails({
  spawnMeta,
  isSpawnAgent,
  isAgentTool,
  detailAgentId,
  detailDurationMs,
  detailTokens,
  detailToolUseCount,
  detailResultText,
  promptText,
  rest,
  history,
  canLoad,
}: TaskExecutionDetailsProps) {
  const { t } = useTranslation();

  return (
    <div className="task-details">
      <div className="task-content-wrapper">
        {spawnMeta.nickname && (
          <div className="task-field">
            <div className="task-field-label">nickname</div>
            <div className="task-field-content">{spawnMeta.nickname}</div>
          </div>
        )}

        {spawnMeta.model && (
          <div className="task-field">
            <div className="task-field-label">model</div>
            <div className="task-field-content">{spawnMeta.model}</div>
          </div>
        )}

        {spawnMeta.reasoningEffort && (
          <div className="task-field">
            <div className="task-field-label">reasoning_effort</div>
            <div className="task-field-content">{spawnMeta.reasoningEffort}</div>
          </div>
        )}

        {spawnMeta.agentId && (
          <div className="task-field">
            <div className="task-field-label">agent_id</div>
            <div className="task-field-content">{spawnMeta.agentId}</div>
          </div>
        )}

        {isAgentTool && (
          <SubagentProcessDetails
            agentId={detailAgentId}
            totalDurationMs={detailDurationMs}
            totalTokens={detailTokens}
            totalToolUseCount={detailToolUseCount}
            resultText={detailResultText}
            prompt={!isSpawnAgent ? promptText : undefined}
            history={history}
            canLoad={canLoad}
          />
        )}

        {!isSpawnAgent && promptText !== undefined && (
          <div className="task-field">
            <div className="task-field-label">
              <span className="codicon codicon-comment" />
              {t('tools.promptLabel')}
            </div>
            <div className="task-field-content">{promptText}</div>
          </div>
        )}

        {Object.entries(rest).flatMap(([key, value]) => {
          if (isSpawnAgent && ['message', 'items', 'task_name', 'taskName'].includes(key)) {
            return [];
          }
          return [
          <div key={key} className="task-field">
            <div className="task-field-label">{key}</div>
            <div className="task-field-content">
              {typeof value === 'object' && value !== null
                ? JSON.stringify(value, null, 2)
                : String(value)}
            </div>
          </div>,
          ];
        })}
      </div>
    </div>
  );
}
