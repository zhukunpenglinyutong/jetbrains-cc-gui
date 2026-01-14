import { useState, useMemo, useEffect } from 'react';
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

const TodoPanel = ({ todos }: TodoPanelProps) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  const { completedCount, totalCount, isAllCompleted } = useMemo(() => {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    return {
      completedCount: completed,
      totalCount: todos.length,
      isAllCompleted: todos.length > 0 && completed === todos.length,
    };
  }, [todos]);

  // 当 todos 变化时（新任务列表），重置 dismissed 状态
  useEffect(() => {
    setIsDismissed(false);
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
