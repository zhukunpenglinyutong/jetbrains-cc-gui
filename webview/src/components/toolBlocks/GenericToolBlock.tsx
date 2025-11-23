import { useState } from 'react';
import type { ToolInput } from '../../types';
import { formatParamValue, getFileName, truncate } from '../../utils/helpers';
import { openFile } from '../../utils/bridge';

const CODICON_MAP: Record<string, string> = {
  read: 'codicon-eye',
  edit: 'codicon-edit',
  write: 'codicon-pencil',
  bash: 'codicon-terminal',
  grep: 'codicon-search',
  glob: 'codicon-folder',
  task: 'codicon-tools',
  webfetch: 'codicon-globe',
  websearch: 'codicon-search',
  delete: 'codicon-trash',
};

const getToolDisplayName = (name?: string) => {
  if (!name) {
    return '工具调用';
  }
  const map: Record<string, string> = {
    Read: '读取',
    Edit: '编辑',
    Write: '写入',
    Bash: '执行命令',
    Grep: '搜索',
    Glob: '查找文件',
    Task: '执行任务',
    WebFetch: '获取网页',
    WebSearch: '网络搜索',
  };
  return map[name] ?? name;
};

const pickFilePath = (input: ToolInput) =>
  (input.file_path as string | undefined) ??
  (input.path as string | undefined) ??
  (input.target_file as string | undefined) ??
  (input.notebook_path as string | undefined);

const omitFields = new Set([
  'file_path',
  'path',
  'target_file',
  'notebook_path',
  'command',
  'search_term',
]);

interface GenericToolBlockProps {
  name?: string;
  input?: ToolInput;
}

const GenericToolBlock = ({ name, input }: GenericToolBlockProps) => {
  // Tools that should be collapsible (Grep and Glob)
  const isCollapsible = ['grep', 'glob'].includes((name ?? '').toLowerCase());
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const filePath = pickFilePath(input);
  const displayName = getToolDisplayName(name);
  const codicon = CODICON_MAP[(name ?? '').toLowerCase()] ?? 'codicon-tools';

  let summary: string | null = null;
  if (filePath) {
    summary = getFileName(filePath);
  } else if (typeof input.command === 'string') {
    summary = truncate(input.command);
  } else if (typeof input.search_term === 'string') {
    summary = truncate(input.search_term);
  } else if (typeof input.pattern === 'string') {
    summary = truncate(input.pattern);
  }

  const otherParams = Object.entries(input).filter(
    ([key]) => !omitFields.has(key) && key !== 'pattern',
  );

  const shouldShowDetails = otherParams.length > 0 && (!isCollapsible || expanded);

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={isCollapsible ? () => setExpanded((prev) => !prev) : undefined}
        style={{
          cursor: isCollapsible ? 'pointer' : 'default',
          borderBottom: expanded && isCollapsible ? '1px solid #333' : undefined
        }}
      >
        <div className="task-title-section">
          <div
            className="task-icon-wrapper"
            style={{ background: 'rgba(100, 181, 246, 0.15)' }}
          >
            <span className={`codicon ${codicon}`} style={{ color: '#64b5f6' }} />
          </div>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#90caf9' }}>
            {displayName}
          </span>
          {summary &&
            (filePath ? (
              <a
                className="tool-file-link"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openFile(filePath);
                }}
              >
                {summary}
              </a>
            ) : (
              <span className="task-summary-text" title={summary}>
                {summary}
              </span>
            ))}
        </div>
        {isCollapsible && (
          <span
            className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`}
            style={{ color: '#858585' }}
          />
        )}
      </div>
      {shouldShowDetails && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {otherParams.map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">{formatParamValue(value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default GenericToolBlock;

