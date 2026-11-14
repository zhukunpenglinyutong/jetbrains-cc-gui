import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getClaudeBackgroundTasks, subscribeClaudeBackgroundTasks } from '../../utils/claudeBackgroundTasks';
import './ClaudeBackgroundTasksPanel.css';

interface Props {
  provider: string;
  sessionId: string | null;
  foregroundActive: boolean;
  onStop: () => void;
}

/** Workflows can keep running after the foreground answer. Sending stays available. */
export function ClaudeBackgroundTasksPanel({ provider, sessionId, foregroundActive, onStop }: Props) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribeClaudeBackgroundTasks, getClaudeBackgroundTasks);
  if (provider !== 'claude' || sessionId && snapshot.sessionId !== sessionId || !snapshot.tasks.length) return null;
  return (
    <div className="claude-background-tasks">
      <details>
        <summary>{t('chat.backgroundTasksRunning', { count: snapshot.tasks.length,
          defaultValue: '{{count}} background tasks running' })}</summary>
        <ul>
          {snapshot.tasks.map(task => <li key={JSON.stringify([task.taskId, task.runId])}>{task.description}</li>)}
        </ul>
      </details>
      {!foregroundActive && <button type="button" onClick={onStop}>
        <span className="codicon codicon-debug-stop" aria-hidden="true" />
        {t('chat.stopBackgroundTasks', { defaultValue: 'Stop background tasks' })}
      </button>}
    </div>
  );
}
