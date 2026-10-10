import { memo } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';
import EditToolGroupBlock from './EditToolGroupBlock';
import EditFileCard from './EditFileCard';
import GenericToolBlock from './GenericToolBlock';
import FileChangesToolBlock from './FileChangesToolBlock';
import { PATCH_TOOL_NAMES, isToolName } from '../../utils/toolConstants';
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

  if (isToolName(name, PATCH_TOOL_NAMES)) {
    return <FileChangesToolBlock name={name} input={normalizedInput} result={result} toolId={toolId} />;
  }

  if (!normalizedInput) {
    return null;
  }

  if (!oldString && !newString) {
    return <GenericToolBlock name={name} input={normalizedInput} result={result} toolId={toolId} />;
  }

  return <EditFileCard filePath={filePath} target={target} oldString={oldString} newString={newString}
    diff={diff} lineInfo={lineInfo} extraEditCount={extraEditCount} isError={isError} isCompleted={isCompleted}
    expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} errorOutput={result?.content} />;
});

export default EditToolBlock;
