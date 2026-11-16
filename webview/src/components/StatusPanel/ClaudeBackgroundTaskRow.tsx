import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeBackgroundTask } from '../../utils/claudeBackgroundTasks';
import { copyToClipboard } from '../../utils/copyUtils';

const TYPE_ICONS: Record<string, string> = {
  local_bash: 'codicon-terminal',
  local_agent: 'codicon-hubot',
  remote_agent: 'codicon-cloud',
  local_workflow: 'codicon-git-merge',
  in_process_teammate: 'codicon-organization',
  monitor_mcp: 'codicon-pulse',
};

export const backgroundTaskKey = (task: ClaudeBackgroundTask) => JSON.stringify([task.taskId, task.runId]);

/** Parents first, children right below; tasks whose parent is gone (or in a cycle) become roots. */
export function orderBackgroundTasks(tasks: readonly ClaudeBackgroundTask[]) {
  const ids = new Set(tasks.map(task => task.taskId));
  const placed = new Set<ClaudeBackgroundTask>();
  const ordered: { task: ClaudeBackgroundTask; depth: number }[] = [];
  const visit = (task: ClaudeBackgroundTask, depth: number) => {
    if (placed.has(task)) return;
    placed.add(task);
    ordered.push({ task, depth });
    tasks.filter(child => child.parentTaskId === task.taskId).forEach(child => visit(child, depth + 1));
  };
  tasks.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId)).forEach(task => visit(task, 0));
  tasks.forEach(task => visit(task, 0));
  return ordered;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function CopyableId({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <dd>
      <code title={value}>{value}</code>
      {copied
        ? <span className="claude-bg-copied">{t('markdown.copySuccess')}</span>
        : <button type="button" className="claude-bg-icon-btn" title={t('contextMenu.copy')} aria-label={t('contextMenu.copy')}
          onClick={async () => setCopied(await copyToClipboard(value))}>
          <span className="codicon codicon-copy" aria-hidden="true" />
        </button>}
    </dd>
  );
}

interface RowProps {
  task: ClaudeBackgroundTask;
  depth: number;
  parent?: ClaudeBackgroundTask;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  onJumpToParent: () => void;
}

export function ClaudeBackgroundTaskRow({ task, depth, parent, expanded, now, onToggle, onJumpToParent }: RowProps) {
  const { t } = useTranslation();
  const known = task.taskType in TYPE_ICONS;
  const typeLabel = t(`chat.backgroundTaskTypes.${known ? task.taskType : 'other'}`);
  const elapsed = formatElapsed(now - task.startedAt);
  const indent = { '--claude-bg-depth': depth } as CSSProperties;
  return (
    <li className={`claude-bg-task${expanded ? ' expanded' : ''}`} data-task-key={backgroundTaskKey(task)} style={indent}>
      <button type="button" className="claude-bg-row" aria-expanded={expanded} onClick={onToggle}>
        <span className="codicon codicon-chevron-right claude-bg-chevron" aria-hidden="true" />
        <span className={`codicon ${TYPE_ICONS[task.taskType] ?? 'codicon-symbol-event'} claude-bg-type-icon`} aria-hidden="true" />
        <span className="claude-bg-desc" title={task.description}>{task.description}</span>
        <span className="claude-bg-tag">{typeLabel}</span>
        <span className="claude-bg-elapsed">{elapsed}</span>
      </button>
      {expanded && (
        <div className="claude-bg-detail">
          <div className="claude-bg-full">{task.description}</div>
          <dl>
            <dt>{t('chat.backgroundTaskDetails.type')}</dt>
            <dd>{typeLabel} <code>({task.taskType})</code></dd>
            <dt>{t('chat.backgroundTaskDetails.taskId')}</dt>
            <CopyableId value={task.taskId} />
            {task.runId && <>
              <dt>{t('chat.backgroundTaskDetails.runId')}</dt>
              <CopyableId value={task.runId} />
            </>}
            {parent && <>
              <dt>{t('chat.backgroundTaskDetails.parent')}</dt>
              <dd><button type="button" className="claude-bg-link" onClick={onJumpToParent}>{parent.description}</button></dd>
            </>}
            <dt>{t('chat.backgroundTaskDetails.elapsed')}</dt>
            <dd>{elapsed}</dd>
          </dl>
        </div>
      )}
    </li>
  );
}
