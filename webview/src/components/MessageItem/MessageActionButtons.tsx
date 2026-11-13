import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../../types';
import { formatTime } from '../../utils/helpers';

/** Shared copy icon SVG used by both user and assistant message copy buttons */
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fillOpacity="0.9"/>
    <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fillOpacity="0.6"/>
  </svg>
);

interface CopyButtonProps {
  className?: string;
  isCopied: boolean;
  onClick: () => void;
  copyLabel: string;
  copySuccessText: string;
}

const CopyButton = memo(function CopyButton({
  className,
  isCopied,
  onClick,
  copyLabel,
  copySuccessText,
}: CopyButtonProps) {
  return (
    <button
      type="button"
      className={`message-copy-btn${className ? ` ${className}` : ''} ${isCopied ? 'copied' : ''}`}
      onClick={onClick}
      title={copyLabel}
      aria-label={copyLabel}
    >
      <span className="copy-icon">
        <CopyIcon />
      </span>
      <span className="copy-tooltip">{copySuccessText}</span>
    </button>
  );
});

/** Quote icon (chat bubble with a right-arrow) used by the message quote button */
const QuoteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 3v-3H3a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity="0.6"/>
    <path d="M7.5 4.5l2.5 2.5-2.5 2.5M5 7h5" stroke="var(--bg-secondary)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

interface QuoteButtonProps {
  className?: string;
  isQuoted: boolean;
  onClick: () => void;
  quoteLabel: string;
  quoteSuccessText: string;
}

const QuoteButton = memo(function QuoteButton({
  className,
  isQuoted,
  onClick,
  quoteLabel,
  quoteSuccessText,
}: QuoteButtonProps) {
  return (
    <button
      type="button"
      className={`message-copy-btn message-quote-btn${className ? ` ${className}` : ''} ${isQuoted ? 'copied' : ''}`}
      onClick={onClick}
      title={quoteLabel}
      aria-label={quoteLabel}
    >
      <span className="copy-icon">
        <QuoteIcon />
      </span>
      <span className="copy-tooltip">{quoteSuccessText}</span>
    </button>
  );
});

/** Fork icon (git branch) used by the assistant message fork button */
const ForkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.3"/>
    <circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.3"/>
    <circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M4.5 5.2v5.6M11.5 7.2c0 2.2-2.6 2.4-5.6 2.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

interface ForkButtonProps {
  onClick: () => void;
  forkLabel: string;
}

const ForkButton = memo(function ForkButton({
  onClick,
  forkLabel,
}: ForkButtonProps) {
  return (
    <button
      type="button"
      className="message-copy-btn message-fork-btn"
      onClick={onClick}
      title={forkLabel}
      aria-label={forkLabel}
    >
      <span className="copy-icon">
        <ForkIcon />
      </span>
    </button>
  );
});

interface UserMessageHeaderProps {
  messageType: ClaudeMessage['type'];
  timestamp?: string;
  hasCopyableText: boolean;
  isQuoted: boolean;
  isCopied: boolean;
  onQuote: () => void;
  onCopy: () => void;
  t: TFunction;
}

/** Timestamp and copy button for user messages */
export const UserMessageHeader = memo(function UserMessageHeader({
  messageType,
  timestamp,
  hasCopyableText,
  isQuoted,
  isCopied,
  onQuote,
  onCopy,
  t,
}: UserMessageHeaderProps) {
  if (messageType !== 'user' || !timestamp) return null;
  return (
    <div className="message-header-row">
      <div className="message-timestamp-header">
        {formatTime(timestamp)}
      </div>
      {hasCopyableText && (
        <>
          <QuoteButton
            className="message-copy-btn-inline"
            isQuoted={isQuoted}
            onClick={onQuote}
            quoteLabel={t('markdown.quoteMessage', 'Quote message')}
            quoteSuccessText={t('markdown.quoteSuccess', 'Quoted!')}
          />
          <CopyButton
            className="message-copy-btn-inline"
            isCopied={isCopied}
            onClick={onCopy}
            copyLabel={t('markdown.copyMessage')}
            copySuccessText={t('markdown.copySuccess')}
          />
        </>
      )}
    </div>
  );
});

interface AssistantMessageActionsProps {
  messageType: ClaudeMessage['type'];
  isMessageStreaming: boolean;
  hasCopyableText: boolean;
  isQuoted: boolean;
  isCopied: boolean;
  onQuote: () => void;
  onCopy: () => void;
  /** Present only for claude-provider messages with a row uuid: forks from this reply. */
  onFork?: () => void;
  t: TFunction;
}

/** Copy, quote and fork buttons for assistant messages only */
export const AssistantMessageActions = memo(function AssistantMessageActions({
  messageType,
  isMessageStreaming,
  hasCopyableText,
  isQuoted,
  isCopied,
  onQuote,
  onCopy,
  onFork,
  t,
}: AssistantMessageActionsProps) {
  if (messageType !== 'assistant' || isMessageStreaming || !hasCopyableText) return null;
  return (
    <>
      {onFork && (
        <ForkButton
          onClick={onFork}
          forkLabel={t('history.forkFromHere', 'Fork from this reply')}
        />
      )}
      <QuoteButton
        isQuoted={isQuoted}
        onClick={onQuote}
        quoteLabel={t('markdown.quoteMessage', 'Quote message')}
        quoteSuccessText={t('markdown.quoteSuccess', 'Quoted!')}
      />
      <CopyButton
        isCopied={isCopied}
        onClick={onCopy}
        copyLabel={t('markdown.copyMessage')}
        copySuccessText={t('markdown.copySuccess')}
      />
    </>
  );
});

/** Role label for non-user/assistant messages — hidden for notification types */
export const MessageRoleLabel = memo(function MessageRoleLabel({
  messageType,
}: {
  messageType: ClaudeMessage['type'];
}) {
  if (
    messageType === 'assistant' || messageType === 'user'
    || messageType === 'notification' || messageType === 'task_notification'
  ) {
    return null;
  }
  return (
    <div className="message-role-label">
      {messageType}
    </div>
  );
});
