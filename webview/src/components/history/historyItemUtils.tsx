// Shared pure helpers for history list rows and dialogs.

const HIGHLIGHT_MARK_STYLE: React.CSSProperties = {
  backgroundColor: '#ffd700',
  color: '#000',
  padding: '0 2px',
};

export const formatTimeAgo = (timestamp: string | undefined, t: (key: string) => string) => {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, t('history.timeAgo.yearsAgo')],
    [2592000, t('history.timeAgo.monthsAgo')],
    [86400, t('history.timeAgo.daysAgo')],
    [3600, t('history.timeAgo.hoursAgo')],
    [60, t('history.timeAgo.minutesAgo')],
  ];

  for (const [unitSeconds, label] of units) {
    const interval = Math.floor(seconds / unitSeconds);
    if (interval >= 1) {
      return `${interval} ${label}`;
    }
  }
  return `${Math.max(seconds, 1)} ${t('history.timeAgo.secondsAgo')}`;
};

export const formatFileSize = (bytes: number | undefined): { text: string; isMB: boolean } => {
  if (!bytes || bytes === 0) {
    return { text: '0 KB', isMB: false };
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return { text: `${kb.toFixed(1)} KB`, isMB: false };
  }
  const mb = kb / 1024;
  return { text: `${mb.toFixed(1)} MB`, isMB: true };
};

// Highlight matching text within a label
export const highlightText = (text: string, query: string) => {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) {
    return <span>{text}</span>;
  }

  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);

  return (
    <span>
      {before}
      <mark style={HIGHLIGHT_MARK_STYLE}>{match}</mark>
      {after}
    </span>
  );
};

export const stopPropagationHandler = (e: React.MouseEvent) => {
  e.stopPropagation();
};
