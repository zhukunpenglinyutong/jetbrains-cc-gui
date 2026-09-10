import { useEffect, useRef, useMemo, useCallback, useId, memo } from 'react';
import { useTranslation } from 'react-i18next';
import './ContextUsageDialog.css';
import { useTranslateCategoryName } from './contextUsageUtils';
import { ContextUsageSummary } from './ContextUsageSummary';
import { ContextUsageGrid } from './ContextUsageGrid';
import { ContextUsageLegend } from './ContextUsageLegend';
import { ContextUsageDetails } from './ContextUsageDetails';
import { ContextUsageLoading } from './ContextUsageLoading';

export interface ContextUsageData {
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  gridRows: Array<Array<{
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }>>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{ name: string; serverName: string; tokens: number }>;
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
}

interface ContextUsageDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  data: ContextUsageData | null;
  onClose: () => void;
}

const ContextUsageDialog = memo(function ContextUsageDialog({
  isOpen,
  isLoading,
  data,
  onClose,
}: ContextUsageDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const translateCategoryName = useTranslateCategoryName();

  const closeDialog = useCallback(() => {
    onClose();
  }, [onClose]);

  // Use mousedown instead of click for close buttons to ensure reliable
  // event handling in JCEF environments where React synthetic onClick
  // may not fire consistently.
  // Unified mousedown handler for closing - used by both the overlay
  // (click outside) and close button. Uses mousedown for reliability in JCEF.
  const handleCloseMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeDialog();
  }, [closeDialog]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeDialog();
  }, [closeDialog]);

  // Prevent overlay mousedown from reaching the dialog content
  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Compute derived values before any early returns to satisfy hooks rules
  const { visibleCategories, freeSpace, autoCompactBuffer } = useMemo(() => {
    if (!data?.categories) {
      return { visibleCategories: [], freeSpace: undefined, autoCompactBuffer: undefined };
    }
    const visible: typeof data.categories = [];
    let free: typeof data.categories[0] | undefined;
    let buffer: typeof data.categories[0] | undefined;

    for (const cat of data.categories) {
      if (cat.name === 'Free space') {
        free = cat;
      } else if (cat.name === 'Autocompact buffer') {
        buffer = cat;
      } else if (cat.tokens > 0) {
        visible.push(cat);
      }
    }

    return { visibleCategories: visible, freeSpace: free, autoCompactBuffer: buffer };
  }, [data?.categories]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeDialog]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const rafId = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      lastFocusedElementRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Loading state
  if (isLoading || !data) {
    return (
      <ContextUsageLoading
        dialogRef={dialogRef}
        closeButtonRef={closeButtonRef}
        titleId={titleId}
        descriptionId={descriptionId}
        onCloseMouseDown={handleCloseMouseDown}
        onCloseClick={handleCloseClick}
        onDialogMouseDown={handleDialogMouseDown}
      />
    );
  }

  const {
    gridRows = [],
    totalTokens = 0,
    rawMaxTokens = data.maxTokens ?? 0,
    percentage = 0,
    model = '',
    memoryFiles = [],
    mcpTools = [],
    agents = [],
    skills,
    isAutoCompactEnabled = false,
    autoCompactThreshold,
  } = data;

  return (
    <div className="context-usage-overlay" onMouseDown={handleCloseMouseDown}>
      <div
        className="context-usage-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onMouseDown={handleDialogMouseDown}
      >
        {/* Header */}
        <div className="context-usage-header">
          <h3 id={titleId} className="context-usage-title">
            {t('contextUsage.title', { defaultValue: 'Context Usage' })}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="context-usage-close"
            onMouseDown={handleCloseMouseDown}
            onClick={handleCloseClick}
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            ×
          </button>
        </div>

        {/* Summary */}
        <ContextUsageSummary
          descriptionId={descriptionId}
          model={model}
          totalTokens={totalTokens}
          rawMaxTokens={rawMaxTokens}
          percentage={percentage}
          isAutoCompactEnabled={isAutoCompactEnabled}
          autoCompactThreshold={autoCompactThreshold}
        />

        {/* Colored grid */}
        <ContextUsageGrid gridRows={gridRows} translateCategoryName={translateCategoryName} />

        {/* Legend */}
        <ContextUsageLegend
          visibleCategories={visibleCategories}
          autoCompactBuffer={autoCompactBuffer}
          freeSpace={freeSpace}
          translateCategoryName={translateCategoryName}
        />

        {/* Details tables */}
        <ContextUsageDetails
          memoryFiles={memoryFiles}
          mcpTools={mcpTools}
          agents={agents}
          skills={skills}
        />
      </div>
    </div>
  );
});

export default ContextUsageDialog;
