import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { stripAnsi } from '../../utils/stripAnsi';
import { presentCommand } from '../../utils/commandPresentation';
import { bashGroupCollapsePreference } from '../../utils/bashGroupCollapsePreference';
import { usePreferredExpanded } from '../../hooks/usePreferredExpanded';
import BashGroupItemRow, { type BashItem } from './BashGroupItemRow';

interface BashToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
    toolId?: string;
  }>;
  /** Denied tool IDs set, passed from parent instead of global window */
  deniedToolIds?: Set<string>;
}

/** Max visible items before scroll (3.5 items) */
const MAX_VISIBLE_ITEMS = 3.5;
/** Height per item in pixels */
const ITEM_HEIGHT = 30;
/** Vertical padding of the list container */
const LIST_PADDING = 8;
/** Max height when an item is expanded */
const EXPANDED_MAX_HEIGHT = 400;
/** Words of each command shown in the collapsed header */
const PEEK_WORDS = 2;

/**
 * Parse item to BashItem
 */
function parseBashItem(
  item: {
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
    toolId?: string;
  },
  deniedToolIds: Set<string> | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): BashItem | null {
  const { input, result, toolId } = item;
  if (!input) return null;

  const { command, displayCommand, description, justification } = presentCommand(input, t);
  if (!command.trim() && !description.trim()) return null;

  let output = '';
  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
    output = stripAnsi(output);
  }

  const isDenied = toolId ? (deniedToolIds?.has(toolId) ?? false) : false;
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  const isError = isDenied || (isCompleted && result?.is_error === true);

  return {
    command: displayCommand,
    rawCommand: command,
    description,
    justification,
    output,
    isCompleted,
    isError,
    toolId,
  };
}

/**
 * First words of every command, e.g. "git status · npm run"
 */
function buildPeek(items: BashItem[]): string {
  return items
    .map((item) => (item.command || item.description).split(/\s+/).slice(0, PEEK_WORDS).join(' '))
    .join(' · ');
}

const BashToolGroupBlock = ({ items, deniedToolIds }: BashToolGroupBlockProps) => {
  const { expanded, toggleExpanded } = usePreferredExpanded(bashGroupCollapsePreference);
  // Track which item detail is expanded
  const [expandedItemIndex, setExpandedItemIndex] = useState<number | null>(null);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items
  const bashItems = useMemo(() => {
    return items
      .map((item) => parseBashItem(item, deniedToolIds, t))
      .filter((item): item is BashItem => item !== null);
  }, [items, deniedToolIds, t]);

  // Auto-scroll to bottom when new items are added
  useEffect(() => {
    if (listRef.current && bashItems.length > prevItemCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = bashItems.length;
  }, [bashItems.length]);

  if (bashItems.length === 0) {
    return null;
  }

  // Calculate progress
  const completedCount = bashItems.filter((item) => item.isCompleted).length;
  const errorCount = bashItems.filter((item) => item.isError).length;
  const totalCount = bashItems.length;

  // Show 3.5 rows before scrolling; an open detail gets more room
  const needsScroll = totalCount > MAX_VISIBLE_ITEMS;
  const baseHeight = (needsScroll ? MAX_VISIBLE_ITEMS : totalCount) * ITEM_HEIGHT;
  const listHeight = expandedItemIndex !== null ? EXPANDED_MAX_HEIGHT : baseHeight;
  const listStyle: React.CSSProperties = {
    maxHeight: `${listHeight + LIST_PADDING}px`,
    overflowY: needsScroll || expandedItemIndex !== null ? 'auto' : 'hidden',
  };

  const isRunning = completedCount < totalCount;
  const runningProgress = (
    <span className="bash-group-progress">
      <span className="tool-status-indicator pending" />
      {completedCount}/{totalCount}
    </span>
  );

  // Failures stay visible while the rest of the batch keeps running
  const renderProgress = () => {
    if (errorCount > 0) {
      return (
        <>
          <span className="bash-group-progress error">
            <span className="tool-status-indicator error" />
            {errorCount} {t('tools.bashGroupFailed')}
          </span>
          {isRunning && runningProgress}
        </>
      );
    }
    if (isRunning) return runningProgress;
    const label = t('tools.bashGroupAllCompleted');
    return (
      <span className="bash-group-progress completed" role="img" aria-label={label} title={label}>
        <span className="tool-status-indicator completed" />
      </span>
    );
  };

  return (
    <div className="task-container bash-group-container">
      {/* Header - always visible */}
      <div
        className={`task-header bash-group-header ${expanded ? 'expanded' : ''}`}
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggleExpanded();
          }
        }}
        aria-expanded={expanded}
      >
        <div className="task-title-section bash-group-title">
          <span className="codicon codicon-terminal bash-tool-icon" />
          <span className="tool-title-text">{t('tools.bashGroupBatchRun')}</span>
          <span className="bash-group-count">{totalCount}</span>
          {!expanded && <span className="bash-group-peek code-font-surface">{buildPeek(bashItems)}</span>}
        </div>
        <div className="bash-group-summary">{renderProgress()}</div>
      </div>

      {/* Command list - visible when expanded */}
      {expanded && (
        <div ref={listRef} className="bash-group-list" style={listStyle}>
          {bashItems.map((item, index) => (
            <BashGroupItemRow
              key={item.toolId || `bash-item-${index}`}
              item={item}
              expanded={expandedItemIndex === index}
              onToggle={() => setExpandedItemIndex((prev) => (prev === index ? null : index))}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default BashToolGroupBlock;
