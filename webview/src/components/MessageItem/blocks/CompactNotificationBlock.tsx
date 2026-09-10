import type { ClaudeContentBlock } from '../../../types';

interface CompactNotificationBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'compact_notification' }>;
}

/**
 * Compact notification block - renders as header + indented sub-items
 */
export function CompactNotificationBlock({ block }: CompactNotificationBlockProps) {
  return (
    <div className="compact-notification-block">
      <div className="compact-notification-header">
        {block.headerText}
      </div>
      {block.items.length > 0 && (
        <div className="compact-notification-items">
          {block.items.map((item, idx) => (
            <div key={idx} className="compact-notification-item">
              <span className="compact-notification-prefix">⎿</span>
              <span className="compact-notification-text">{item.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
