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
 * 复制文本到剪贴板
 * @param text 要复制的文本内容
 * @returns Promise<boolean> 是否复制成功
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('[Clipboard] Failed to copy text:', error);
    // 降级方案：使用传统的 execCommand 方法
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    } catch (fallbackError) {
      console.error('[Clipboard] Fallback copy method also failed:', fallbackError);
      return false;
    }
  }
};

