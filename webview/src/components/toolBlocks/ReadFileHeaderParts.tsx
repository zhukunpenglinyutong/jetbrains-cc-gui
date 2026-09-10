import { useTranslation } from 'react-i18next';
import { openFile } from '../../utils/bridge';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
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

const IMAGE_HINT_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
};

export interface FileLinkTooltipHandlers {
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}

interface FileLinkSpanProps {
  target: ToolTargetInfo | undefined;
  filePath: string | undefined;
  isDirectory: boolean;
  lineInfo: { start?: number; end?: number };
  fileLinkTooltip: FileLinkTooltipHandlers;
}

export function FileLinkSpan({
  target,
  filePath,
  isDirectory,
  lineInfo,
  fileLinkTooltip,
}: FileLinkSpanProps) {
  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling to avoid triggering expand/collapse
    if (target?.isFile) {
      openFile(target.openPath, lineInfo.start, lineInfo.end);
    }
  };

  const fileIconSvg = !target
    ? ''
    : isDirectory
      ? getFolderIcon(target.cleanFileName)
      : getFileIcon(
          (target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '') ?? '',
          target.cleanFileName,
        );

  return (
    <span
      className={`tool-title-summary ${!isDirectory ? 'clickable-file' : ''}`}
      onClick={!isDirectory ? handleFileClick : undefined}
      {...(!isDirectory ? fileLinkTooltip : {})}
      style={FILE_LINK_STYLE}
    >
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: fileIconSvg }}
      />
      {target?.displayPath || filePath}
    </span>
  );
}

interface LineRangeInfoProps {
  lineInfo: { start?: number; end?: number };
}

export function LineRangeInfo({ lineInfo }: LineRangeInfoProps) {
  const { t } = useTranslation();

  if (!lineInfo.start) {
    return null;
  }

  return (
    <span className="tool-title-summary" style={LINE_INFO_STYLE}>
      {lineInfo.end && lineInfo.end !== lineInfo.start
        ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
        : t('tools.lineSingle', { line: lineInfo.start })}
    </span>
  );
}

export function ImageCountHint({ imageCount }: { imageCount: number }) {
  if (imageCount <= 0) {
    return null;
  }

  return (
    <span className="tool-title-summary" style={IMAGE_HINT_STYLE}>
      <span className="codicon codicon-file-media" />
      {imageCount}
    </span>
  );
}
