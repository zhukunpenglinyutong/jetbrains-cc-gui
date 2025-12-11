import { useTranslation } from 'react-i18next';
import type { TodoItem } from '../../types';

interface TodoListBlockProps {
  todos?: TodoItem[];
}

const statusClassMap: Record<TodoItem['status'], string> = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
};

const statusIconMap: Record<TodoItem['status'], string> = {
  pending: 'codicon-circle-outline',
  in_progress: 'codicon-arrow-right',
  completed: 'codicon-check',
};

const TodoListBlock = ({ todos }: TodoListBlockProps) => {
  const { t } = useTranslation();
  if (!todos?.length) {
    return null;
  }

  return (
    <div className="todo-container">
      <div className="todo-header">
        <span className="codicon codicon-list-unordered todo-header-icon" />
        <span>{t('tools.todoList')} {todos.length}</span>
      </div>
      <div className="todo-list">
        {todos.map((todo, index) => {
          const status = todo.status ?? 'pending';
          return (
            <div
              key={todo.id ?? index}
              className={`todo-item ${statusClassMap[status] ?? ''}`}
            >
              <div className={`todo-status-icon ${statusClassMap[status] ?? ''}`}>
                <span className={`codicon ${statusIconMap[status] ?? ''}`} />
              </div>
              <div className="todo-content">{todo.content}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TodoListBlock;

