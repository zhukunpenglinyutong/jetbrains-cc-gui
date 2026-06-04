import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodoItem } from '../../types';
import { statusClassMap } from './types';
import { CircleIcon, LoadingIcon, CheckIcon } from '../Icons';

interface TodoListProps {
  todos: TodoItem[];
}

// Render status icon based on type
function renderStatusIcon(status: TodoItem['status']) {
  switch (status) {
    case 'pending':
      return <CircleIcon size={12} />;
    case 'in_progress':
      return <LoadingIcon size={12} spinning={true} />;
    case 'completed':
      return <CheckIcon size={12} />;
    default:
      return <CircleIcon size={12} />;
  }
}

// Get status tag text
function getStatusTagText(status: TodoItem['status'], t: ReturnType<typeof useTranslation>['t']) {
  switch (status) {
    case 'pending':
      return t('statusPanel.todoStatus.pending', '待办');
    case 'in_progress':
      return t('statusPanel.todoStatus.inProgress', '进行中');
    case 'completed':
      return t('statusPanel.todoStatus.completed', '已完成');
    default:
      return status;
  }
}

const TodoList = memo(({ todos }: TodoListProps) => {
  const { t } = useTranslation();

  if (todos.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noTodos')}</div>;
  }

  return (
    <div className="status-panel-todo-list">
      {todos.map((todo, index) => {
        const status = todo.status ?? 'pending';
        const statusClass = statusClassMap[status] ?? '';

        return (
          <div key={todo.id ?? index} className={`status-panel-todo-item ${statusClass}`}>
            <div className={`status-panel-todo-icon ${statusClass}`}>
              {renderStatusIcon(status)}
            </div>
            <div className="status-panel-todo-body">
              <div className="status-panel-todo-content">{todo.content}</div>
              <div className="status-panel-todo-meta">
                <span className={`status-panel-todo-tag ${statusClass}`}>
                  {getStatusTagText(status, t)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

TodoList.displayName = 'TodoList';

export default TodoList;
