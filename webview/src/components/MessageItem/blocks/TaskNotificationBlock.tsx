import { TASK_STATUS_COLORS } from '../../../utils/messageUtils';
import type { ClaudeContentBlock } from '../../../types';

interface TaskNotificationBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'task_notification' }>;
}

/**
 * Task notification block - renders as "● summary" with status color
 */
export function TaskNotificationBlock({ block }: TaskNotificationBlockProps) {
  const statusColor = TASK_STATUS_COLORS[block.status] || 'text';
  const detail = block.detail;
  const truncatedDetail = detail && detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  return (
    <div className={`task-notification-block task-notification-${statusColor}`}>
      <span className="task-notification-icon">{block.icon}</span>
      <span className="task-notification-summary">
        {block.summary}
        {truncatedDetail && (
          <span className="task-notification-detail" title={detail}>{truncatedDetail}</span>
        )}
      </span>
    </div>
  );
}
