export const getFileName = (filePath?: string | null) => {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] ?? filePath;
};

export const formatParamValue = (value: unknown) => {
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

export const truncate = (text: string, maxLength = 60) => {
  if (typeof text !== 'string' || text.length <= maxLength) {
    return text || '';
  }
  return `${text.substring(0, maxLength)}...`;
};
/**
 * Truncate a long path from the front, keeping whole trailing segments:
 * 'webview/src/components/ChatInputBox/selectors/index.ts' -> '…/ChatInputBox/selectors/index.ts'
 */
export const truncatePathFromStart = (path: string, maxLength = 36) => {
  if (typeof path !== 'string' || path.length <= maxLength) {
    return path || '';
  }
  const separator = path.includes('\\') ? '\\' : '/';
  const trailingSeparator = path.endsWith(separator) ? separator : '';
  const segments = path.split(separator).filter(Boolean);

  let tail = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = tail ? `${segments[i]}${separator}${tail}` : segments[i];
    // Reserve room for the '…/' prefix
    if (candidate.length + 2 > maxLength) {
      break;
    }
    tail = candidate;
  }

  if (!tail) {
    // Even the final segment overflows the budget: hard-truncate characters
    return `…${path.slice(-(maxLength - 1))}`;
  }
  return `…${separator}${tail}${trailingSeparator}`;
};

/**
 * Format timestamp to time string (HH:mm)
 * @param timestamp - ISO timestamp string
 * @returns Formatted time string or empty string if invalid
 */
export const formatTime = (timestamp?: string): string => {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch (e) {
    return '';
  }
};

/**
 * Format seconds to countdown string (mm:ss)
 * @param seconds - Total seconds to format
 * @returns Formatted countdown string (e.g., "4:59")
 */
export const formatCountdown = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

