import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import ToolDetailsAccordion from './ToolDetailsAccordion';
import ToolSummarySection from './ToolSummarySection';
import { useGenericToolState } from './useGenericToolState';

interface GenericToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

const GenericToolBlock = memo(function GenericToolBlock({ name, input, result, toolId }: GenericToolBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Hook order is load-bearing (useTranslation → useState → useIsToolDenied →
  // useResolvedFileLinkTooltip): useGenericToolState wraps the latter two and
  // must stay above the early returns.
  const {
    lowerName,
    target,
    isCompleted,
    isError,
    displayName,
    codicon,
    summary,
    otherParams,
    patchFiles,
    resultImages,
    hasExpandableContent,
    isDirectoryPath,
    lineInfo,
    fileIconSvg,
    effectiveIsFile,
    fileLinkTooltip,
  } = useGenericToolState({ t, name, input, result, toolId });

  // Ignore write_stdin tool - it's waiting for previous command result
  if (lowerName === 'write_stdin') {
    return null;
  }

  if (!input) {
    return null;
  }

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (target) {
      openFile(target.openPath, lineInfo.start, lineInfo.end);
    }
  };

  const headerStyle: React.CSSProperties = {
    cursor: hasExpandableContent ? 'pointer' : 'default',
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={hasExpandableContent ? () => setExpanded((prev) => !prev) : undefined}
        style={headerStyle}
      >
        <div className="task-title-section">
          <span className={`codicon ${codicon} tool-title-icon`} />

          <span className="tool-title-text">
            {displayName}
          </span>
          <ToolSummarySection
            summary={summary}
            patchFiles={patchFiles}
            effectiveIsFile={!!effectiveIsFile}
            isDirectoryPath={isDirectoryPath}
            fileLinkTooltip={fileLinkTooltip}
            onFileClick={handleFileClick}
            fileIconSvg={fileIconSvg}
            lineInfo={lineInfo}
            resultImagesCount={resultImages.length}
          />
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>
      {hasExpandableContent && (
        <ToolDetailsAccordion
          expanded={expanded}
          otherParams={otherParams}
          resultImages={resultImages}
        />
      )}
    </div>
  );
});

export default GenericToolBlock;
