import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { openFile } from '../../utils/bridge';
import { getFileIcon } from '../../utils/fileIcons';
import { normalizeFileLinkHref } from '../../utils/linkify';
import { FILE_ICON_STYLE, PATCH_FILE_LINK_STYLE } from './genericToolStyles';

interface PatchFileLinkProps {
  path: string;
}

const PatchFileLink = ({ path }: PatchFileLinkProps) => {
  const fileName = path.split('/').pop() || path;
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const openPath = normalizeFileLinkHref(path) || path;
  const tooltip = useResolvedFileLinkTooltip(openPath, path);

  return (
    <span
      className="clickable-file"
      onClick={(e) => {
        e.stopPropagation();
        openFile(openPath);
      }}
      {...tooltip}
      style={PATCH_FILE_LINK_STYLE}
    >
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: getFileIcon(ext ?? '', fileName) }}
      />
      {fileName}
    </span>
  );
};

export default PatchFileLink;
