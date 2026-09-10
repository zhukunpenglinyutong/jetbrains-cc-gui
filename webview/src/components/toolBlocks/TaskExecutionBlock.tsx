import { memo, useState } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';
import TaskExecutionHeader from './TaskExecutionHeader';
import TaskExecutionDetails from './TaskExecutionDetails';
import { useTaskExecutionState } from './useTaskExecutionState';

interface TaskExecutionBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  isStreaming?: boolean;
}

const TaskExecutionBlock = memo(function TaskExecutionBlock({ name, input, result, toolId }: TaskExecutionBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const state = useTaskExecutionState({ name, input, result, toolId, expanded });

  if (!input) {
    return null;
  }

  return (
    <div className="task-container">
      <TaskExecutionHeader
        name={name}
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        isSpawnAgent={state.isSpawnAgent}
        identityLabel={state.identityLabel}
        modelSummary={state.modelSummary}
        shortAgentId={state.shortAgentId}
        descriptionText={state.descriptionText}
        isError={state.isError}
        isCompleted={state.isCompleted}
      />

      {expanded && (
        <TaskExecutionDetails
          spawnMeta={state.spawnMeta}
          isSpawnAgent={state.isSpawnAgent}
          isAgentTool={state.isAgentTool}
          detailAgentId={state.detailAgentId}
          detailDurationMs={state.detailDurationMs}
          detailTokens={state.detailTokens}
          detailToolUseCount={state.detailToolUseCount}
          detailResultText={state.detailResultText}
          promptText={state.promptText}
          rest={state.rest}
          history={state.history}
          canLoad={state.canLoad}
        />
      )}
    </div>
  );
});

export default TaskExecutionBlock;
