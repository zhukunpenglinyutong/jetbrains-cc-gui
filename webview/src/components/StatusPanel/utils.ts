import { getFileName } from '../../utils/helpers';
import { getFileIcon } from '../../utils/fileIcons';

/**
 * Get file icon SVG from file path
 */
export function getFileIconSvg(filePath: string): string {
  const name = getFileName(filePath);
  const extension = name.indexOf('.') !== -1 ? name.split('.').pop() : '';
  return getFileIcon(extension, name);
}
