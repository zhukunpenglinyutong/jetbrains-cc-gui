import { memo, useMemo } from 'react';
import { getFileIconSvg } from './utils';

interface FileIconProps {
  filePath: string;
  className?: string;
}

/**
 * File icon component that safely renders SVG icons.
 *
 * Security note: The SVG content comes from internal trusted source (getFileIconSvg)
 * which maps file extensions to pre-defined SVG strings. No user input is rendered.
 */
const FileIcon = memo(({ filePath, className = 'file-change-icon' }: FileIconProps) => {
  // Memoize SVG to prevent unnecessary recalculations
  const svgContent = useMemo(() => getFileIconSvg(filePath), [filePath]);

  // SVG comes from internal trusted source - no user input
  // eslint-disable-next-line react/no-danger
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: svgContent }}
      aria-hidden="true"
    />
  );
});

FileIcon.displayName = 'FileIcon';

export default FileIcon;
