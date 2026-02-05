import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import {
  loadHistoryWithImportance,
  deleteHistoryItem,
  clearAllHistory,
  addHistoryItem,
  updateHistoryItem,
  clearLowImportanceHistory,
  type HistoryItem,
} from '../../ChatInputBox/hooks/useInputHistory.js';
import { HistoryItemEditor } from './HistoryItemEditor.js';

/**
 * Error boundary for OtherSettingsSection
 * Catches localStorage and other errors to prevent crash
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class OtherSettingsErrorBoundary extends Component<
  { children: ReactNode; fallbackMessage: string },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; fallbackMessage: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[OtherSettingsSection] Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorFallback}>
          <span className="codicon codicon-warning" />
          <span>{this.props.fallbackMessage}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface OtherSettingsSectionProps {
  historyCompletionEnabled: boolean;
  onHistoryCompletionEnabledChange: (enabled: boolean) => void;
}

interface EditorState {
  isOpen: boolean;
  mode: 'add' | 'edit';
  item?: HistoryItem;
}

const OtherSettingsSection = ({
  historyCompletionEnabled,
  onHistoryCompletionEnabledChange,
}: OtherSettingsSectionProps) => {
  const { t } = useTranslation();
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [showHistoryList, setShowHistoryList] = useState(false);
  const [editorState, setEditorState] = useState<EditorState>({
    isOpen: false,
    mode: 'add',
  });

  // Reload history items
  const reloadHistory = useCallback(() => {
    try {
      setHistoryItems(loadHistoryWithImportance());
    } catch (e) {
      console.error('[OtherSettingsSection] Failed to load history:', e);
      setHistoryItems([]);
    }
  }, []);

  // Load history items when expanding the list
  useEffect(() => {
    if (showHistoryList) {
      reloadHistory();
    }
  }, [showHistoryList, reloadHistory]);

  const handleDeleteItem = useCallback((item: HistoryItem) => {
    try {
      deleteHistoryItem(item.text);
      setHistoryItems((prev) => prev.filter((i) => i.text !== item.text));
    } catch (e) {
      console.error('[OtherSettingsSection] Failed to delete history item:', e);
    }
  }, []);

  const handleClearAll = useCallback(() => {
    try {
      clearAllHistory();
      setHistoryItems([]);
    } catch (e) {
      console.error('[OtherSettingsSection] Failed to clear history:', e);
    }
  }, []);

  const handleClearLowImportance = useCallback(() => {
    try {
      const deleted = clearLowImportanceHistory(1);
      if (deleted > 0) {
        reloadHistory();
      }
    } catch (e) {
      console.error('[OtherSettingsSection] Failed to clear low importance history:', e);
    }
  }, [reloadHistory]);

  const handleOpenAddEditor = useCallback(() => {
    setEditorState({
      isOpen: true,
      mode: 'add',
    });
  }, []);

  const handleOpenEditEditor = useCallback((item: HistoryItem) => {
    setEditorState({
      isOpen: true,
      mode: 'edit',
      item,
    });
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleSaveEditor = useCallback(
    (text: string, importance: number) => {
      try {
        if (editorState.mode === 'add') {
          addHistoryItem(text, importance);
        } else if (editorState.item) {
          updateHistoryItem(editorState.item.text, text, importance);
        }
        reloadHistory();
      } catch (e) {
        console.error('[OtherSettingsSection] Failed to save history item:', e);
      }
    },
    [editorState.mode, editorState.item, reloadHistory]
  );

  // Count items with low importance for display
  const lowImportanceCount = historyItems.filter((item) => item.importance <= 1).length;

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.other.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.other.description')}</p>

      {/* 历史输入补全开关 */}
      <div className={styles.historyCompletionSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-history" />
          <span className={styles.fieldLabel}>{t('settings.other.historyCompletion.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={historyCompletionEnabled}
            onChange={(e) => onHistoryCompletionEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {historyCompletionEnabled
              ? t('settings.other.historyCompletion.enabled')
              : t('settings.other.historyCompletion.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.other.historyCompletion.hint')}</span>
        </small>

        {/* 历史记录管理 */}
        <div className={styles.historyManagement}>
          <button
            type="button"
            className={styles.expandButton}
            onClick={() => setShowHistoryList(!showHistoryList)}
          >
            <span className={`codicon codicon-chevron-${showHistoryList ? 'down' : 'right'}`} />
            <span>{t('settings.other.historyCompletion.manageHistory')}</span>
            {historyItems.length > 0 && showHistoryList && (
              <span className={styles.historyCount}>({historyItems.length})</span>
            )}
          </button>

          {showHistoryList && (
            <div className={styles.historyListContainer}>
              {historyItems.length === 0 ? (
                <div className={styles.emptyHistory}>
                  <span className="codicon codicon-inbox" />
                  <span>{t('settings.other.historyCompletion.empty')}</span>
                </div>
              ) : (
                <>
                  <div className={styles.historyActions}>
                    <button
                      type="button"
                      className={styles.addButton}
                      onClick={handleOpenAddEditor}
                    >
                      <span className="codicon codicon-add" />
                      <span>{t('settings.other.historyCompletion.add')}</span>
                    </button>
                    <div className={styles.actionsSpacer} />
                    {lowImportanceCount > 0 && (
                      <button
                        type="button"
                        className={styles.clearLowButton}
                        onClick={handleClearLowImportance}
                        title={t('settings.other.historyCompletion.clearLowHint')}
                      >
                        <span className="codicon codicon-filter" />
                        <span>
                          {t('settings.other.historyCompletion.clearLow')} ({lowImportanceCount})
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.clearAllButton}
                      onClick={handleClearAll}
                    >
                      <span className="codicon codicon-trash" />
                      <span>{t('settings.other.historyCompletion.clearAll')}</span>
                    </button>
                  </div>
                  <ul className={styles.historyList}>
                    {historyItems.map((item, index) => (
                      <li key={`${item.text}-${index}`} className={styles.historyItem}>
                        <span className={styles.importanceBadge} title={t('settings.other.historyCompletion.importance')}>
                          [{item.importance}]
                        </span>
                        <span className={styles.historyText} title={item.text}>
                          {item.text}
                        </span>
                        <div className={styles.itemActions}>
                          <button
                            type="button"
                            className={styles.editButton}
                            onClick={() => handleOpenEditEditor(item)}
                            title={t('settings.other.historyCompletion.edit')}
                          >
                            <span className="codicon codicon-edit" />
                          </button>
                          <button
                            type="button"
                            className={styles.deleteButton}
                            onClick={() => handleDeleteItem(item)}
                            title={t('settings.other.historyCompletion.delete')}
                          >
                            <span className="codicon codicon-close" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {/* Add button when list is empty */}
              {historyItems.length === 0 && (
                <div className={styles.emptyActions}>
                  <button
                    type="button"
                    className={styles.addButton}
                    onClick={handleOpenAddEditor}
                  >
                    <span className="codicon codicon-add" />
                    <span>{t('settings.other.historyCompletion.add')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Editor Dialog */}
      <HistoryItemEditor
        isOpen={editorState.isOpen}
        onClose={handleCloseEditor}
        onSave={handleSaveEditor}
        mode={editorState.mode}
        initialText={editorState.item?.text}
        initialImportance={editorState.item?.importance}
      />
    </div>
  );
};

/**
 * Wrapped component with error boundary
 */
const OtherSettingsSectionWithErrorBoundary = (props: OtherSettingsSectionProps) => {
  const { t } = useTranslation();
  return (
    <OtherSettingsErrorBoundary fallbackMessage={t('settings.other.loadError', 'Failed to load settings')}>
      <OtherSettingsSection {...props} />
    </OtherSettingsErrorBoundary>
  );
};

export default OtherSettingsSectionWithErrorBoundary;
export { OtherSettingsSection, OtherSettingsErrorBoundary };
