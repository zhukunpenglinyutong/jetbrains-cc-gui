import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodoItem } from '../../types';
import './TodoPanel.less';

interface TodoPanelProps {
  todos: TodoItem[];
}

const statusClassMap: Record<TodoItem['status'], string> = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
};

const statusIconMap: Record<TodoItem['status'], string> = {
  pending: 'codicon-circle-outline',
  in_progress: 'codicon-loading',
  completed: 'codicon-check',
};

/**
 * Generate a fingerprint for todos to detect content changes.
 * Only considers task count and content text (not status changes).
 */
const getTodosFingerprint = (todos: TodoItem[]): string => {
  return todos.map((t) => t.content).join('|');
};

const TodoPanel = ({ todos }: TodoPanelProps) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const prevFingerprintRef = useRef<string>('');

  const { completedCount, totalCount, isAllCompleted } = useMemo(() => {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    return {
      completedCount: completed,
      totalCount: todos.length,
      isAllCompleted: todos.length > 0 && completed === todos.length,
    };
  }, [todos]);

  // Only reset dismissed state when todos content actually changes (new task list)
  // Status changes (pending -> completed) should NOT reset dismissed state
  useEffect(() => {
    const currentFingerprint = getTodosFingerprint(todos);
    if (prevFingerprintRef.current !== currentFingerprint) {
      // Content changed - this is a new task list
      if (prevFingerprintRef.current !== '') {
        // Only reset if we had a previous list (not initial mount with same dismissed list)
        setIsDismissed(false);
      }
      prevFingerprintRef.current = currentFingerprint;
    }
  }, [todos]);

  if (!todos.length || isDismissed) {
    return null;
  }

  const toggleExpanded = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDismissed(true);
  };

  return (
    <div className="todo-panel">
      <div className="todo-panel-header" onClick={toggleExpanded}>
        <span
          className={`codicon ${isExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'} todo-panel-toggle`}
        />
        <span className="todo-panel-progress">
          {!isAllCompleted && (
            <span className="codicon codicon-loading todo-panel-loading" />
          )}
          {isAllCompleted
            ? t('todo.allCompleted', { completed: completedCount, total: totalCount })
            : t('todo.inProgress', { completed: completedCount, total: totalCount })}
        </span>
        {isAllCompleted && (
          <div className="todo-panel-close" onClick={handleClose} title={t('common.close')}>
            <span className="codicon codicon-close" />
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="todo-panel-list">
          {todos.map((todo, index) => {
            const status = todo.status ?? 'pending';
            const statusClass = statusClassMap[status] ?? '';
            const iconClass = statusIconMap[status] ?? '';

            return (
              <div key={todo.id ?? index} className={`todo-panel-item ${statusClass}`}>
                <div className={`todo-panel-icon ${statusClass}`}>
                  <span className={`codicon ${iconClass}`} />
                </div>
                <div className="todo-panel-content">{todo.content}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TodoPanel;
