import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodoItem } from '../../types';
import './TodoPanel.less';

interface TodoPanelProps {
  todos: TodoItem[];
  isStreaming?: boolean;
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
 * Considers task count, content text, and status.
 */
const getTodosFingerprint = (todos: TodoItem[]): string => {
  return todos.map((t) => `${t.content}|${t.status}`).join('|');
};

const TodoPanel = ({ todos, isStreaming = false }: TodoPanelProps) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const prevFingerprintRef = useRef<string>('');

  const { completedCount, totalCount, isAllCompleted, currentTask } = useMemo(() => {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    // Find the current task: first in_progress, or first pending
    const current = todos.find((todo) => todo.status === 'in_progress') || 
                   todos.find((todo) => todo.status === 'pending');

    return {
      completedCount: completed,
      totalCount: todos.length,
      isAllCompleted: todos.length > 0 && completed === todos.length,
      currentTask: current,
    };
  }, [todos]);

  // Reset dismissed state when todos content or status changes
  useEffect(() => {
    const currentFingerprint = getTodosFingerprint(todos);
    if (prevFingerprintRef.current !== currentFingerprint) {
      if (prevFingerprintRef.current !== '') {
        // Reset if we had a previous list (not initial mount with same dismissed list)
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

  const renderHeaderContent = () => {
    if (isAllCompleted) {
      return t('todo.allCompleted', { completed: completedCount, total: totalCount });
    }

    const countInfo = `${completedCount}/${totalCount}`;
    let title = '';
    
    if (currentTask?.content) {
      title = currentTask.content;
      if (title.length > 20) {
        title = title.substring(0, 20) + '...';
      }
    }

    // If we have a title, show it. Otherwise fall back to generic "In Progress" text
    if (title) {
      if (isStreaming) {
        return `${countInfo} ${title}`;
      } else {
        return `${t('todo.stopped')} - ${countInfo} ${title}`;
      }
    } else {
      // Fallback
      if (isStreaming) {
        return t('todo.inProgress', { completed: completedCount, total: totalCount });
      } else {
        return `${t('todo.stopped')} - ${t('todo.inProgress', { completed: completedCount, total: totalCount })}`;
      }
    }
  };

  return (
    <div className="todo-panel">
      <div className="todo-panel-header" onClick={toggleExpanded}>
        <span
          className={`codicon ${isExpanded ? 'codicon-chevron-up' : 'codicon-chevron-down'} todo-panel-toggle`}
        />
        <span className="todo-panel-progress">
          {!isAllCompleted && isStreaming && (
            <span className="codicon codicon-loading todo-panel-loading" />
          )}
          {renderHeaderContent()}
        </span>
        <div className="todo-panel-close" onClick={handleClose} title={t('common.close')}>
          <span className="codicon codicon-close" />
        </div>
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
