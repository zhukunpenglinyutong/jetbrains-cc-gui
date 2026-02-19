import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig } from '../types/prompt';

interface PromptDialogProps {
  isOpen: boolean;
  prompt?: PromptConfig | null; // null indicates add mode
  onClose: () => void;
  onSave: (data: { name: string; content: string }) => void;
}

export default function PromptDialog({
  isOpen,
  prompt,
  onClose,
  onSave,
}: PromptDialogProps) {
  const { t } = useTranslation();
  const isAdding = !prompt;

  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [nameError, setNameError] = useState('');

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (prompt) {
        // Edit mode
        setName(prompt.name || '');
        setContent(prompt.content || '');
      } else {
        // Add mode
        setName('');
        setContent('');
      }
      setNameError('');
    }
  }, [isOpen, prompt]);

  // Close on ESC key
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Limit to 30 characters max
    if (value.length <= 30) {
      setName(value);
      setNameError('');
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // Limit to 100000 characters max
    if (value.length <= 100000) {
      setContent(value);
    }
  };

  const handleSave = () => {
    // Validate name
    if (!name.trim()) {
      setNameError(t('settings.prompt.dialog.nameRequired'));
      return;
    }

    onSave({
      name: name.trim(),
      content: content.trim(),
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog prompt-dialog">
        <div className="dialog-header">
          <h3>{isAdding ? t('settings.prompt.dialog.addTitle') : t('settings.prompt.dialog.editTitle')}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <div className="form-group">
            <label htmlFor="promptName">
              {t('settings.prompt.dialog.name')}
              <span className="required">*</span>
            </label>
            <div className="input-with-counter">
              <input
                id="promptName"
                type="text"
                className={`form-input ${nameError ? 'has-error' : ''}`}
                placeholder={t('settings.prompt.dialog.namePlaceholder')}
                value={name}
                onChange={handleNameChange}
                maxLength={30}
              />
              <span className="char-counter">{name.length}/30</span>
            </div>
            {nameError && (
              <p className="form-error">
                <span className="codicon codicon-error" />
                {nameError}
              </p>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="promptContent">
              {t('settings.prompt.dialog.content')}
            </label>
            <div className="textarea-with-counter">
              <textarea
                id="promptContent"
                className="form-textarea"
                placeholder={t('settings.prompt.dialog.contentPlaceholder')}
                value={content}
                onChange={handleContentChange}
                maxLength={100000}
                rows={10}
              />
              <span className="char-counter">{content.length}/100000</span>
            </div>
            <small className="form-hint">{t('settings.prompt.dialog.contentHint')}</small>
          </div>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.prompt.dialog.confirmAdd') : t('settings.prompt.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
