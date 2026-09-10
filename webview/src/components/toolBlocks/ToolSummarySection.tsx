import { useTranslation } from 'react-i18next';
import type { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import PatchFileLink from './PatchFileLink';
import {
  FILE_ICON_STYLE,
  IMAGE_HINT_STYLE,
  LINE_INFO_STYLE,
  PATCH_FILES_CONTAINER_STYLE,
  SUMMARY_FILE_STYLE,
} from './genericToolStyles';

interface ToolSummarySectionProps {
  summary: string | null;
  patchFiles: string[];
  effectiveIsFile: boolean;
  isDirectoryPath: boolean;
  fileLinkTooltip: ReturnType<typeof useResolvedFileLinkTooltip>;
  onFileClick: (e: React.MouseEvent) => void;
  fileIconSvg: string;
  lineInfo: { start?: number; end?: number };
  resultImagesCount: number;
}

const ToolSummarySection = ({
  summary,
  patchFiles,
  effectiveIsFile,
  isDirectoryPath,
  fileLinkTooltip,
  onFileClick,
  fileIconSvg,
  lineInfo,
  resultImagesCount,
}: ToolSummarySectionProps) => {
  const { t } = useTranslation();

  return (
    <>
      {summary && patchFiles.length === 0 && (
        <span
          className={`task-summary-text tool-title-summary ${effectiveIsFile ? 'clickable-file' : ''}`}
          onClick={effectiveIsFile ? onFileClick : undefined}
          {...(effectiveIsFile ? fileLinkTooltip : {})}
          style={(effectiveIsFile || isDirectoryPath) ? SUMMARY_FILE_STYLE : undefined}
        >
          {(effectiveIsFile || isDirectoryPath) && (
            <span
              style={FILE_ICON_STYLE}
              dangerouslySetInnerHTML={{ __html: fileIconSvg }}
            />
          )}
          {summary}
        </span>
      )}
      {patchFiles.length > 0 && (
        <span className="tool-title-summary" style={PATCH_FILES_CONTAINER_STYLE}>
          {patchFiles.map((path, idx) => (
            <PatchFileLink
              key={idx}
              path={path}
            />
          ))}
        </span>
      )}
      {lineInfo.start && (
        <span className="tool-title-summary" style={LINE_INFO_STYLE}>
          {lineInfo.end && lineInfo.end !== lineInfo.start
            ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
            : t('tools.lineSingle', { line: lineInfo.start })}
        </span>
      )}
      {resultImagesCount > 0 && (
        <span className="tool-title-summary" style={IMAGE_HINT_STYLE}>
          <span className="codicon codicon-file-media" />
          {resultImagesCount}
        </span>
      )}
    </>
  );
};

export default ToolSummarySection;
