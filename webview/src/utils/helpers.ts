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

