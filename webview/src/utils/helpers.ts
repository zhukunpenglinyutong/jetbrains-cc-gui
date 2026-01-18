export const getFileName = (filePath?: string | null) => {
  if (!filePath) {
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
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.substring(0, maxLength)}...`;
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

