import { memo } from 'react';

type MessageType = 'user' | 'assistant' | 'error' | 'notification' | 'task_notification' | string;

interface MessageAvatarProps {
  type: MessageType;
  className?: string;
}

/**
 * 用户头像 SVG
 */
const UserAvatarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

/**
 * AI 头像 SVG (Claude logo style)
 */
const AssistantAvatarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </svg>
);

/**
 * 消息头像组件
 * 用户消息显示紫色渐变头像，AI回复显示蓝紫渐变头像
 */
export const MessageAvatar = memo(function MessageAvatar({ type, className }: MessageAvatarProps) {
  // 只有 user 和 assistant 类型显示头像
  if (type !== 'user' && type !== 'assistant') {
    return null;
  }

  return (
    <div className={`message-avatar${className ? ` ${className}` : ''}`}>
      {type === 'user' ? <UserAvatarIcon /> : <AssistantAvatarIcon />}
      <span className="avatar-label">
        {type === 'user' ? '你' : 'Claude'}
      </span>
    </div>
  );
});
