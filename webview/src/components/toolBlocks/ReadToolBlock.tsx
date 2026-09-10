import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { resolveToolTarget } from '../../utils/toolPresentation';
import ReadFileHeader from './ReadFileHeader';
import ReadToolDetails from './ReadToolDetails';
import { deriveReadToolState } from './readToolDerivedState';

interface ReadToolBlockProps {
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

const ReadToolBlock = memo(function ReadToolBlock({ input, result, toolId }: ReadToolBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const isDenied = useIsToolDenied(toolId);

  // Hooks must run unconditionally; target/filePath/isDirectory are guarded so
  // the early return can live below the hook call.
  const target = input ? resolveToolTarget(input, 'read') : undefined;
  const filePath = target?.rawPath;
  const isDirectory = target?.isDirectory ?? false;

  const fileLinkTooltip = useResolvedFileLinkTooltip(
    !isDirectory ? filePath : undefined,
    !isDirectory ? (target?.displayPath || filePath || undefined) : undefined,
  );

  if (!input) {
    return null;
  }

  const { isCompleted, isError, lineInfo, actionText, params, resultImages } =
    deriveReadToolState(input, target, isDirectory, result, isDenied, t);

  return (
    <div className="task-container">
      <ReadFileHeader
        target={target}
        filePath={filePath}
        isDirectory={isDirectory}
        actionText={actionText}
        lineInfo={lineInfo}
        imageCount={resultImages.length}
        isError={isError}
        isCompleted={isCompleted}
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        fileLinkTooltip={fileLinkTooltip}
      />

      {expanded && (params.length > 0 || resultImages.length > 0) && (
        <ReadToolDetails params={params} resultImages={resultImages} />
      )}
    </div>
  );
});

export default ReadToolBlock;
