import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillScope, RemoteSkillUpdateInterval } from '../../types/skill';

interface RemoteSkillDialogProps {
  scope: SkillScope;
  onClose: () => void;
  onConfirm: (url: string, updateInterval: RemoteSkillUpdateInterval, isBatch?: boolean) => void;
}

/**
 * Dialog for importing skills from remote URL
 */
export function RemoteSkillDialog({ scope, onClose, onConfirm }: RemoteSkillDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [updateInterval, setUpdateInterval] = useState<RemoteSkillUpdateInterval>('manual');
  const [error, setError] = useState('');
  const [isBatchMode, setIsBatchMode] = useState(false);

  const handleConfirm = () => {
    // Validate URL
    if (!url.trim()) {
      setError(t('skills.remote.urlRequired'));
      return;
    }

    // Basic URL validation
    try {
      const urlObj = new URL(url.trim());
      if (!urlObj.protocol.startsWith('http')) {
        setError(t('skills.remote.invalidUrl'));
        return;
      }
    } catch {
      setError(t('skills.remote.invalidUrl'));
      return;
    }

    onConfirm(url.trim(), updateInterval, isBatchMode);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-container remote-skill-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>{t('skills.remote.title')}</h2>
          <button className="close-btn" onClick={onClose} aria-label={t('common.close')}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-content">
          <div className="form-section">
            <label className="form-label">
              {t('skills.remote.scope')}
            </label>
            <div className="scope-badge-container">
              <span className={`scope-badge ${scope}`}>
                <span className={`codicon ${(scope === 'global' || scope === 'user') ? 'codicon-globe' : 'codicon-desktop-download'}`}></span>
                {scope === 'global' ? t('chat.global') : scope === 'local' ? t('chat.localProject') : scope === 'user' ? t('skills.user') : t('skills.repo')}
              </span>
            </div>
          </div>

          <div className="form-section">
            <label className="form-label">
              {t('skills.remote.importMode')}
            </label>
            <div className="import-mode-toggle">
              <label className="mode-option">
                <input
                  type="radio"
                  name="import-mode"
                  checked={!isBatchMode}
                  onChange={() => setIsBatchMode(false)}
                />
                <span>{t('skills.remote.singleSkill')}</span>
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="import-mode"
                  checked={isBatchMode}
                  onChange={() => setIsBatchMode(true)}
                />
                <span>{t('skills.remote.navigationDirectory')}</span>
              </label>
            </div>
          </div>

          <div className="form-section">
            <label htmlFor="remote-url" className="form-label">
              {isBatchMode ? t('skills.remote.navigationUrl') : t('skills.remote.url')} <span className="required">*</span>
            </label>
            <input
              id="remote-url"
              type="text"
              className="form-input"
              placeholder={isBatchMode ? t('skills.remote.navigationUrlPlaceholder') : t('skills.remote.urlPlaceholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError('');
              }}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            {error && <div className="form-error">{error}</div>}
            <div className="form-hint">
              {isBatchMode ? t('skills.remote.navigationUrlHint') : t('skills.remote.urlHint')}
            </div>
          </div>

          <div className="form-section">
            <label htmlFor="update-interval" className="form-label">
              {t('skills.remote.updateInterval')}
            </label>
            <select
              id="update-interval"
              className="form-select"
              value={updateInterval}
              onChange={(e) => setUpdateInterval(e.target.value as RemoteSkillUpdateInterval)}
            >
              <option value="manual">{t('skills.remote.manual')}</option>
              <option value="hourly">{t('skills.remote.hourly')}</option>
              <option value="daily">{t('skills.remote.daily')}</option>
              <option value="weekly">{t('skills.remote.weekly')}</option>
            </select>
            <div className="form-hint">{t('skills.remote.updateIntervalHint')}</div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleConfirm}>
            {t('skills.remote.import')}
          </button>
        </div>
      </div>
    </div>
  );
}
