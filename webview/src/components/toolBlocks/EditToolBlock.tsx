import { memo } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';
import EditToolGroupBlock from './EditToolGroupBlock';
import EditDiffTopBar from './EditDiffTopBar';
import EditFileHeader from './EditFileHeader';
import EditDiffView from './EditDiffView';
import GenericToolBlock from './GenericToolBlock';
import { useEditToolState } from './useEditToolState';

/** A single edit tool call within a (possibly batched) edit group. */
export interface EditToolItem {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

interface EditToolBlockProps {
  /** One or more edit tool calls. A single item renders the inline-diff view;
      multiple items delegate to EditToolGroupBlock. Routing both cases through
      this one component keeps the instance (and its state) alive as edits
      stream in 1 -> 2 -> ..., so the transition no longer unmounts the block. */
  items: EditToolItem[];
}

const ROOT_STYLE: React.CSSProperties = { margin: '12px 0' };

const TASK_CONTAINER_STYLE: React.CSSProperties = { margin: 0 };

const EditToolBlock = memo(function EditToolBlock({ items }: EditToolBlockProps) {
  // All hooks live in useEditToolState (called unconditionally for any item
  // count), so the component instance - and its state - is preserved when the
  // item count crosses from 1 to many; React reuses this instance and only
  // swaps the rendered subtree instead of unmounting EditToolBlock.
  const {
    expanded,
    setExpanded,
    name,
    result,
    toolId,
    normalizedInput,
    target,
    filePath,
    oldString,
    newString,
    diff,
    isError,
    isCompleted,
    lineInfo,
    extraEditCount,
  } = useEditToolState(items);

  // Multiple edits: delegate to the grouped list view. This return sits after
  // the hook call above, so the component instance (and its state) survives
  // the 1 -> N transition.
  if (items.length > 1) {
    return <EditToolGroupBlock items={items} />;
  }

  if (!normalizedInput) {
    return null;
  }

  if (!oldString && !newString) {
    return <GenericToolBlock name={name} input={normalizedInput} result={result} toolId={toolId} />;
  }

  return (
    <div style={ROOT_STYLE}>
      {/* Top Row: Buttons (Right aligned) */}
      <EditDiffTopBar
        filePath={filePath}
        oldString={oldString}
        newString={newString}
        fileName={target?.cleanFileName ?? filePath}
      />

      <div className="task-container" style={TASK_CONTAINER_STYLE}>
        <EditFileHeader
          filePath={filePath}
          displayPath={target?.displayPath || filePath}
          target={target}
          lineInfo={lineInfo}
          extraEditCount={extraEditCount}
          additions={diff.additions}
          deletions={diff.deletions}
          isError={isError}
          isCompleted={isCompleted}
          onToggle={() => setExpanded((prev) => !prev)}
        />

        {expanded && <EditDiffView diff={diff} />}
      </div>
    </div>
  );
});

export default EditToolBlock;
