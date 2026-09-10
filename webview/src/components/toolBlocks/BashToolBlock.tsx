import { memo, useState } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';
import BashToolHeader from './BashToolHeader';
import BashToolDetails from './BashToolDetails';
import { useBashToolState } from './useBashToolState';

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

const BashToolBlock = memo(function BashToolBlock({ input, result, toolId }: BashToolBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { command, description, isCompleted, isError, output } = useBashToolState({ input, result, toolId });

  if (!input) {
    return null;
  }

  if (!command.trim() && !description.trim()) return null;

  return (
    <div className="task-container">
      <BashToolHeader
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        description={description}
        isError={isError}
        isCompleted={isCompleted}
      />

      {expanded && (
        <BashToolDetails command={command} output={output} isError={isError} />
      )}
    </div>
  );
});

export default BashToolBlock;
