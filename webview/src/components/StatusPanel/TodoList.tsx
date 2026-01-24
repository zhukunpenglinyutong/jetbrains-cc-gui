import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodoItem } from '../../types';
import { statusClassMap, statusIconMap } from './types';

interface TodoListProps {
  todos: TodoItem[];
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
        const iconClass = statusIconMap[status] ?? '';

        return (
          <div key={todo.id ?? index} className={`status-panel-todo-item ${statusClass}`}>
            <div className={`status-panel-todo-icon ${statusClass}`}>
              <span className={`codicon ${iconClass}`} />
            </div>
            <div className="status-panel-todo-content">{todo.content}</div>
          </div>
        );
      })}
    </div>
  );
});

TodoList.displayName = 'TodoList';

export default TodoList;
