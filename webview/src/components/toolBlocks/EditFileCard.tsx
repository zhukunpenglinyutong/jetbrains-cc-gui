import { useTranslation } from 'react-i18next';
import type { ToolTargetInfo } from '../../utils/toolPresentation';
import EditDiffTopBar from './EditDiffTopBar';
import EditFileHeader from './EditFileHeader';
import EditDiffView, { type DiffResult } from './EditDiffView';
import ToolDetailsAccordion from './ToolDetailsAccordion';

interface EditFileCardProps {
  filePath?: string;
  target?: ToolTargetInfo;
  diff: DiffResult;
  expanded: boolean;
  onToggle: () => void;
  isError: boolean;
  isCompleted: boolean;
  isUnknown?: boolean;
  lineInfo?: { start?: number; end?: number };
  extraEditCount?: number;
  oldString?: string;
  newString?: string;
  errorOutput?: unknown;
  className?: string;
  description?: string;
}

/** Keep edit presentation shared while supplied hunks remain preview-only. */
export default function EditFileCard({ filePath, target, diff, expanded, onToggle, isError, isCompleted,
  isUnknown, lineInfo = {}, extraEditCount = 0, oldString, newString, errorOutput, className = '', description }: EditFileCardProps) {
  const { t } = useTranslation();
  return <div className={`edit-file-card ${className}`} title={description} style={{ margin: '12px 0' }}>
    <EditDiffTopBar filePath={filePath} fileName={target?.cleanFileName ?? filePath}
      oldString={oldString} newString={newString}
      onPreviewDiff={oldString === undefined || newString === undefined ? onToggle : undefined} />
    <div className="task-container" style={{ margin: 0 }}>
      <EditFileHeader filePath={filePath} displayPath={target?.displayPath ?? filePath} target={target}
        lineInfo={lineInfo} extraEditCount={extraEditCount} additions={diff.additions} deletions={diff.deletions}
        isError={isError} isCompleted={isCompleted} isUnknown={isUnknown} expanded={expanded} onToggle={onToggle} />
      {expanded && (diff.lines.length ? <EditDiffView diff={diff} />
        : <div className="edit-empty-diff">{t('tools.patchNoDiff')}</div>)}
      {expanded && isError && errorOutput != null && <ToolDetailsAccordion expanded
        otherParams={[[t('tools.errorOutput'), errorOutput]]} resultImages={[]} />}
    </div>
  </div>;
}
