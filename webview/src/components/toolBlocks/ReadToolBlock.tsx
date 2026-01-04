import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput } from '../../types';
import { openFile } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import { getFileIcon } from '../../utils/fileIcons';
import { icon_folder } from '../../utils/icons';

interface ReadToolBlockProps {
  input?: ToolInput;
}

const ReadToolBlock = ({ input }: ReadToolBlockProps) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  if (!input) {
    return null;
  }

  const filePath =
    (input.file_path as string | undefined) ??
    (input.target_file as string | undefined) ??
    (input.path as string | undefined);

  const fileName = getFileName(filePath);

  let lineInfo = '';
  if (typeof input.offset === 'number' && typeof input.limit === 'number') {
    const startLine = Number(input.offset) + 1;
    const endLine = Number(input.offset) + Number(input.limit);
    lineInfo = t('tools.lineRange', { start: startLine, end: endLine });
  }

  const isDirectory = filePath === '.' || filePath?.endsWith('/');
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';
  const actionText = isDirectory ? t('permission.tools.readDirectory') : t('permission.tools.Read');

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡，避免触发展开/折叠
    if (filePath && !isDirectory) {
      openFile(filePath);
    }
  };

  const getFileIconSvg = (path?: string) => {
    if (!path) return '';
    const name = getFileName(path);
    const extension = name.indexOf('.') !== -1 ? name.split('.').pop() : '';
    return getFileIcon(extension, name);
  };

  // Get all input parameters for the expanded view
  const params = Object.entries(input).filter(([key]) => key !== 'file_path' && key !== 'target_file' && key !== 'path');

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section">
          <span className={`codicon ${iconClass} tool-title-icon`} />

          <span className="tool-title-text">
            {actionText}
          </span>
          <span
            className={`tool-title-summary ${!isDirectory ? 'clickable-file' : ''}`}
            onClick={!isDirectory ? handleFileClick : undefined}
            title={!isDirectory ? t('tools.clickToOpen', { filePath }) : undefined}
            style={{ display: 'flex', alignItems: 'center' }}
          >
            {isDirectory ? (
               <span 
                  style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }} 
                  dangerouslySetInnerHTML={{ __html: icon_folder }} 
               />
            ) : (
               <span 
                  style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }} 
                  dangerouslySetInnerHTML={{ __html: getFileIconSvg(filePath) }} 
               />
            )}
            {fileName || filePath}
          </span>

          {lineInfo && (
            <span className="tool-title-summary" style={{ marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo}
            </span>
          )}
        </div>

        <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: 'var(--color-success)',
            marginRight: '4px'
        }} />
      </div>

      {expanded && params.length > 0 && (
        <div className="task-details" style={{ padding: '12px', border: 'none' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontFamily: 'var(--idea-editor-font-family, monospace)',
              fontSize: '12px',
            }}
          >
            <div style={{ color: '#858585' }}>
              <span style={{ color: '#90caf9', fontWeight: 600 }}>{t('tools.filePath')}</span>
              <span style={{ color: '#a5d6a7' }}>{filePath}</span>
            </div>
            {params.map(([key, value]) => (
              <div key={key} style={{ color: '#858585' }}>
                <span style={{ color: '#90caf9', fontWeight: 600 }}>{key}：</span>
                <span>{String(value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadToolBlock;

