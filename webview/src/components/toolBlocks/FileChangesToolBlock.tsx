import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { readPatchFiles, readPatchOutcome, type PatchFile } from '../../utils/codexPatch';
import { resolveToolTarget } from '../../utils/toolPresentation';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { refreshFile } from '../../utils/bridge';
import EditFileCard from './EditFileCard';
import GenericToolBlock from './GenericToolBlock';
import EditToolGroupBlock from './EditToolGroupBlock';

const PatchFileCard = memo(function PatchFileCard({ file, isError, isCompleted, isUnknown, errorOutput }: {
  file: PatchFile; isError: boolean; isCompleted: boolean; isUnknown: boolean; errorOutput?: unknown;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem('diffExpandedByDefault') === 'true'; } catch { return false; }
  });
  const openPath = file.movePath ?? file.path;
  const target = resolveToolTarget({ file_path: openPath }, 'edit');
  const refreshed = useRef(false);
  useEffect(() => {
    if (isCompleted && !isError && !isUnknown && !refreshed.current) {
      refreshed.current = true;
      refreshFile(openPath);
    }
  }, [isCompleted, isError, isUnknown, openPath]);
  return <EditFileCard className="patch-file-card" filePath={openPath} target={target} diff={file.diff}
    isError={isError} isCompleted={isCompleted} isUnknown={isUnknown} errorOutput={errorOutput}
    expanded={expanded} onToggle={() => setExpanded((value) => !value)}
    description={`${t(`tools.patchKind.${file.movePath ? 'move' : file.kind}`)}: ${file.path}${file.movePath ? ` → ${file.movePath}` : ''}`} />;
});

export default memo(function FileChangesToolBlock({ name, input, result, toolId }: {
  name?: string; input?: ToolInput; result?: ToolResultBlock | null; toolId?: string;
}) {
  const files = useMemo(() => readPatchFiles(input), [input]);
  const denied = useIsToolDenied(toolId);
  const { isUnknown, isError, isCompleted } = readPatchOutcome(input, result, denied);
  const fallbackResult: ToolResultBlock | null | undefined = result ?? (isCompleted ? {
    type: 'tool_result', tool_use_id: toolId, content: '', is_error: isError,
  } : null);
  if (!files.length) return <GenericToolBlock name={name} input={input} result={fallbackResult} toolId={toolId} />;
  return <div className="file-changes-tool-block" data-tool-id={toolId}>
    {files.length > 1 ? <EditToolGroupBlock items={[{ name, input, result, toolId }]} />
      : <PatchFileCard file={files[0]} isError={isError} isCompleted={isCompleted} isUnknown={isUnknown} errorOutput={result?.content} />}
  </div>;
});
