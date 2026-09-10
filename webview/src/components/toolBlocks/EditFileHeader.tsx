import { useTranslation } from 'react-i18next';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { openFile } from '../../utils/bridge';
import { getFileIcon } from '../../utils/fileIcons';
import type { ToolTargetInfo } from '../../utils/toolPresentation';

const FILE_LINK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
};

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: '4px',
  display: 'flex',
  alignItems: 'center',
  width: '16px',
  height: '16px',
};

const LINE_INFO_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '12px',
};

const STATS_STYLE: React.CSSProperties = {
  marginLeft: '12px',
  fontSize: '12px',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const ADDED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-added-accent)' };
const DELETED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-deleted-accent)' };
const STATS_SPACER_STYLE: React.CSSProperties = { margin: '0 4px' };

interface EditFileHeaderProps {
  filePath: string | undefined;
  displayPath: string | undefined;
  target: ToolTargetInfo | undefined;
  lineInfo: { start?: number; end?: number };
  extraEditCount: number;
  additions: number;
  deletions: number;
  isError: boolean;
  isCompleted: boolean;
  onToggle: () => void;
}

const EditFileHeader = function EditFileHeader({
  filePath,
  displayPath,
  target,
  lineInfo,
  extraEditCount,
  additions,
  deletions,
  isError,
  isCompleted,
  onToggle,
}: EditFileHeaderProps) {
  const { t } = useTranslation();
  const fileLinkTooltip = useResolvedFileLinkTooltip(filePath, displayPath);

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      openFile(filePath, lineInfo.start, lineInfo.end);
    }
  };

  const getFileIconSvg = () => {
    if (!target) return '';
    const extension = target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '';
    return getFileIcon(extension ?? '', target.cleanFileName);
  };

  return (
    <div className="task-header" onClick={onToggle}>
      <div className="task-title-section">
        <span className="codicon codicon-edit tool-title-icon" />

        <span className="tool-title-text">
          {t('tools.editFileTitle')}
        </span>
        <span
          className="tool-title-summary clickable-file"
          onClick={handleFileClick}
          {...fileLinkTooltip}
          style={FILE_LINK_STYLE}
        >
          <span
            style={FILE_ICON_STYLE}
            dangerouslySetInnerHTML={{ __html: getFileIconSvg() }}
          />
          {displayPath}
        </span>
        {lineInfo.start && (
          <span className="tool-title-summary code-font-surface" style={LINE_INFO_STYLE}>
            {lineInfo.end && lineInfo.end !== lineInfo.start
              ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
              : t('tools.lineSingle', { line: lineInfo.start })}
            {extraEditCount > 0 ? ` +${extraEditCount}${t('tools.editLocationsSuffix')}` : ''}
          </span>
        )}
        {!lineInfo.start && extraEditCount > 0 && (
          <span className="tool-title-summary code-font-surface" style={LINE_INFO_STYLE}>
            +{extraEditCount}{t('tools.editLocationsSuffix')}
          </span>
        )}

        {(additions > 0 || deletions > 0) && (
          <span className="code-font-surface" style={STATS_STYLE}>
            {additions > 0 && <span style={ADDED_TEXT_STYLE}>+{additions}</span>}
            {additions > 0 && deletions > 0 && <span style={STATS_SPACER_STYLE} />}
            {deletions > 0 && <span style={DELETED_TEXT_STYLE}>-{deletions}</span>}
          </span>
        )}
      </div>

      <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
    </div>
  );
};

export default EditFileHeader;
