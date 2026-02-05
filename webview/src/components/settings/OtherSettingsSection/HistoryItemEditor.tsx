import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export interface HistoryItemEditorProps {
  /** Whether the editor is open */
  isOpen: boolean;
  /** Close the editor */
  onClose: () => void;
  /** Save the item */
  onSave: (text: string, importance: number) => void;
  /** Mode: 'add' for new item, 'edit' for existing item */
  mode: 'add' | 'edit';
  /** Initial text (for edit mode) */
  initialText?: string;
  /** Initial importance (for edit mode) */
  initialImportance?: number;
}

/**
 * Dialog for adding or editing a history item
 */
export function HistoryItemEditor({
  isOpen,
  onClose,
  onSave,
  mode,
  initialText = '',
  initialImportance = 1,
}: HistoryItemEditorProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [importance, setImportance] = useState(initialImportance);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset form when opening
  useEffect(() => {
    if (isOpen) {
      setText(initialText);
      setImportance(initialImportance);
      // Focus textarea after a short delay (for animation)
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [isOpen, initialText, initialImportance]);

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSave(trimmed, importance);
    onClose();
  }, [text, importance, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleSave();
      }
    },
    [onClose, handleSave]
  );

  const handleImportanceChange = useCallback((delta: number) => {
    setImportance((prev) => Math.max(1, prev + delta));
  }, []);

  const handleImportanceInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value >= 1) {
        setImportance(value);
      }
    },
    []
  );

  if (!isOpen) return null;

  const title =
    mode === 'add'
      ? t('settings.other.historyCompletion.editor.addTitle')
      : t('settings.other.historyCompletion.editor.editTitle');

  return (
    <div className={styles.editorOverlay} onClick={onClose}>
      <div
        className={styles.editorDialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className={styles.editorHeader}>
          <h4 className={styles.editorTitle}>{title}</h4>
          <button
            type="button"
            className={styles.editorCloseButton}
            onClick={onClose}
            title={t('common.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className={styles.editorBody}>
          <div className={styles.editorField}>
            <label className={styles.editorLabel}>
              {t('settings.other.historyCompletion.editor.contentLabel')}
            </label>
            <textarea
              ref={textareaRef}
              className={styles.editorTextarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('settings.other.historyCompletion.editor.contentPlaceholder')}
              rows={3}
            />
          </div>

          <div className={styles.editorField}>
            <label className={styles.editorLabel}>
              {t('settings.other.historyCompletion.editor.importanceLabel')}
            </label>
            <div className={styles.importanceControl}>
              <button
                type="button"
                className={styles.importanceButton}
                onClick={() => handleImportanceChange(-1)}
                disabled={importance <= 1}
              >
                <span className="codicon codicon-remove" />
              </button>
              <input
                type="number"
                className={styles.importanceInput}
                value={importance}
                onChange={handleImportanceInput}
                min={1}
              />
              <button
                type="button"
                className={styles.importanceButton}
                onClick={() => handleImportanceChange(1)}
              >
                <span className="codicon codicon-add" />
              </button>
            </div>
            <small className={styles.editorHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.other.historyCompletion.editor.importanceHint')}</span>
            </small>
          </div>
        </div>

        <div className={styles.editorFooter}>
          <button type="button" className={styles.editorCancelButton} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.editorSaveButton}
            onClick={handleSave}
            disabled={!text.trim()}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default HistoryItemEditor;
