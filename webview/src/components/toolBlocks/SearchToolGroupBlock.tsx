import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { truncate } from '../../utils/helpers';

interface SearchItem {
  toolName: string;
  pattern: string;
  path: string;
  isCompleted: boolean;
  isError: boolean;
}

interface SearchToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 28;

/**
 * Get codicon class for search tool type
 */
const getSearchToolIcon = (toolName: string): string => {
  const lower = toolName.toLowerCase();
  if (lower === 'glob') return 'codicon-folder';
  if (lower === 'find') return 'codicon-file-symlink-file';
  return 'codicon-search';
};

/**
 * Parse item to SearchItem
 */
const parseSearchItem = (item: { name?: string; input?: ToolInput; result?: ToolResultBlock | null }): SearchItem | null => {
  const { name, input, result } = item;
  if (!input) return null;

  const toolName = name ?? 'search';

  // Extract search pattern from various fields
  const pattern =
    (input.pattern as string | undefined) ??
    (input.search_term as string | undefined) ??
    (input.query as string | undefined) ??
    (input.regex as string | undefined) ??
    '';

  // Extract search path
  const path =
    (input.path as string | undefined) ??
    (input.directory as string | undefined) ??
    '';

  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;

  return { toolName, pattern, path, isCompleted, isError };
};

const SearchToolGroupBlock = ({ items }: SearchToolGroupBlockProps) => {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items
  const searchItems = useMemo(() => {
    return items
      .map(item => parseSearchItem(item))
      .filter((item): item is SearchItem => item !== null);
  }, [items]);

  // Auto-scroll to bottom when new items are added (streaming)
  useEffect(() => {
    if (listRef.current && searchItems.length > prevItemCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = searchItems.length;
  }, [searchItems.length]);

  if (searchItems.length === 0) {
    return null;
  }

  // Calculate list height
  const needsScroll = searchItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : searchItems.length * ITEM_HEIGHT;

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section" style={{ overflow: 'hidden' }}>
          <span className="codicon codicon-search tool-title-icon" />
          <span className="tool-title-text" style={{ flexShrink: 0 }}>
            {t('tools.searchBatchTitle')}
          </span>
          <span className="tool-title-summary" style={{
            color: 'var(--text-secondary)',
            marginLeft: '4px',
            flexShrink: 0,
          }}>
            ({searchItems.length})
          </span>
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={{
            padding: '6px 8px',
            border: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            maxHeight: `${listHeight + 12}px`,
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {searchItems.map((item, index) => (
            <div
              key={index}
              className="file-list-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                borderRadius: '4px',
                minHeight: `${ITEM_HEIGHT}px`,
                flexShrink: 0,
                gap: '6px',
              }}
              title={item.pattern ? `${item.pattern}${item.path ? ` → ${item.path}` : ''}` : item.path}
            >
              {/* Tool type icon */}
              <span
                className={`codicon ${getSearchToolIcon(item.toolName)}`}
                style={{
                  fontSize: '14px',
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                  width: '16px',
                  textAlign: 'center',
                }}
              />

              {/* Pattern */}
              {item.pattern && (
                <span
                  style={{
                    fontSize: '12px',
                    fontFamily: 'var(--idea-editor-font-family, monospace)',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {truncate(item.pattern)}
                </span>
              )}

              {/* Path */}
              {item.path && (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-tertiary, var(--text-secondary))',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flexShrink: 1,
                    minWidth: 0,
                    maxWidth: item.pattern ? '40%' : undefined,
                    opacity: 0.8,
                  }}
                >
                  {item.path}
                </span>
              )}

              {/* No pattern, show path as primary */}
              {!item.pattern && !item.path && (
                <span
                  style={{
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                    flex: 1,
                  }}
                >
                  {item.toolName}
                </span>
              )}

              {/* Status indicator */}
              <div
                className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
                style={{ marginLeft: 'auto', flexShrink: 0 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchToolGroupBlock;
