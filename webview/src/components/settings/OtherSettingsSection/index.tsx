import { useState, useEffect, useCallback } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import {
  loadHistory,
  deleteHistoryItem,
  clearAllHistory,
} from '../../ChatInputBox/hooks/useInputHistory.js';

interface OtherSettingsSectionProps {
  historyCompletionEnabled: boolean;
  onHistoryCompletionEnabledChange: (enabled: boolean) => void;
}

const OtherSettingsSection = ({
  historyCompletionEnabled,
  onHistoryCompletionEnabledChange,
}: OtherSettingsSectionProps) => {
  const { t } = useTranslation();
  const [historyItems, setHistoryItems] = useState<string[]>([]);
  const [showHistoryList, setShowHistoryList] = useState(false);

  // Load history items when expanding the list
  useEffect(() => {
    if (showHistoryList) {
      setHistoryItems(loadHistory());
    }
  }, [showHistoryList]);

  const handleDeleteItem = useCallback((item: string) => {
    deleteHistoryItem(item);
    setHistoryItems((prev) => prev.filter((i) => i !== item));
  }, []);

  const handleClearAll = useCallback(() => {
    clearAllHistory();
    setHistoryItems([]);
  }, []);

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
                      className={styles.clearAllButton}
                      onClick={handleClearAll}
                    >
                      <span className="codicon codicon-trash" />
                      <span>{t('settings.other.historyCompletion.clearAll')}</span>
                    </button>
                  </div>
                  <ul className={styles.historyList}>
                    {historyItems.slice().reverse().map((item, index) => (
                      <li key={index} className={styles.historyItem}>
                        <span className={styles.historyText} title={item}>
                          {item}
                        </span>
                        <button
                          type="button"
                          className={styles.deleteButton}
                          onClick={() => handleDeleteItem(item)}
                          title={t('settings.other.historyCompletion.delete')}
                        >
                          <span className="codicon codicon-close" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OtherSettingsSection;
