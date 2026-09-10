import type { ToolTargetInfo } from '../../utils/toolPresentation';
import {
  FileLinkSpan,
  ImageCountHint,
  LineRangeInfo,
  type FileLinkTooltipHandlers,
} from './ReadFileHeaderParts';

interface ReadFileHeaderProps {
  target: ToolTargetInfo | undefined;
  filePath: string | undefined;
  isDirectory: boolean;
  actionText: string;
  lineInfo: { start?: number; end?: number };
  imageCount: number;
  isError: boolean;
  isCompleted: boolean;
  expanded: boolean;
  onToggle: () => void;
  fileLinkTooltip: FileLinkTooltipHandlers;
}

const ReadFileHeader = function ReadFileHeader({
  target,
  filePath,
  isDirectory,
  actionText,
  lineInfo,
  imageCount,
  isError,
  isCompleted,
  expanded,
  onToggle,
  fileLinkTooltip,
}: ReadFileHeaderProps) {
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';

  const headerStyle: React.CSSProperties = {
    borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
  };

  return (
    <div
      className="task-header"
      onClick={onToggle}
      style={headerStyle}
    >
      <div className="task-title-section">
        <span className={`codicon ${iconClass} tool-title-icon`} />

        <span className="tool-title-text">
          {actionText}
        </span>
        <FileLinkSpan
          target={target}
          filePath={filePath}
          isDirectory={isDirectory}
          lineInfo={lineInfo}
          fileLinkTooltip={fileLinkTooltip}
        />
        <LineRangeInfo lineInfo={lineInfo} />
        <ImageCountHint imageCount={imageCount} />
      </div>

      <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
    </div>
  );
};

export default ReadFileHeader;
