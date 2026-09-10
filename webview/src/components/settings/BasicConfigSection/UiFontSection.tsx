import { useState, useEffect } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { UiFontConfig } from '../hooks/useSettingsBasicActions';

const UI_FONT_SELECT_ID = 'settings-ui-font-select';
const UI_FONT_CUSTOM_PATH_ID = 'settings-ui-font-custom-path';

const NODE_PATH_SECTION_STYLE: React.CSSProperties = { marginTop: 12 };

interface UiFontSectionProps {
  uiFontConfig?: UiFontConfig;
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  onUiFontSelectionChange: (selection: string) => void;
  onSaveUiFontCustomPath: (path: string) => void;
  onBrowseUiFontFile: () => void;
}

const UiFontSection = ({
  uiFontConfig,
  editorFontConfig,
  onUiFontSelectionChange,
  onSaveUiFontCustomPath,
  onBrowseUiFontFile,
}: UiFontSectionProps) => {
  const { t } = useTranslation();
  const [selectedUiFontOption, setSelectedUiFontOption] = useState(() => {
    if (!uiFontConfig || uiFontConfig.mode === 'followEditor') return 'followEditor';
    return 'customFile';
  });
  const [customFontPathDraft, setCustomFontPathDraft] = useState(uiFontConfig?.customFontPath || '');

  useEffect(() => {
    if (!uiFontConfig || uiFontConfig.mode === 'followEditor') {
      setSelectedUiFontOption('followEditor');
    } else {
      setSelectedUiFontOption('customFile');
    }
    setCustomFontPathDraft(uiFontConfig?.customFontPath || '');
  }, [uiFontConfig]);

  const hasSavedCustomFont = Boolean(uiFontConfig?.customFontPath);
  const isCustomUiFontSelected = selectedUiFontOption === 'customFile';
  const isCustomPathEmpty = customFontPathDraft.trim().length === 0;
  const currentUiFontDisplayName = uiFontConfig?.displayName || editorFontConfig?.fontFamily || '-';
  const customFontFileName = uiFontConfig?.customFontPath
    ? uiFontConfig.customFontPath.split(/[\\/]/).pop()
    : '';
  const localizedUiFontWarning = uiFontConfig?.warningCode === 'fontUnavailable'
      ? t('settings.basic.editorFont.warningUnavailable')
      : uiFontConfig?.warning;
  const uiFontHint = localizedUiFontWarning
    || (uiFontConfig?.effectiveMode === 'customFile'
      ? t('settings.basic.editorFont.statusCustom', { font: currentUiFontDisplayName })
      : t('settings.basic.editorFont.statusFollowEditor', {
        font: uiFontConfig?.fontFamily || currentUiFontDisplayName,
      }));

  const handleUiFontSelectionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSelection = event.target.value;
    setSelectedUiFontOption(nextSelection);

    if (nextSelection === 'customFile') {
      // Only notify backend when a custom font path was previously saved;
      // otherwise the user must first enter/browse a path and click Save.
      if (hasSavedCustomFont) {
        onUiFontSelectionChange(nextSelection);
      }
      return;
    }

    onUiFontSelectionChange(nextSelection);
  };

  const handleSaveCustomUiFontPath = () => {
    onSaveUiFontCustomPath(customFontPathDraft.trim());
  };

  return (
    <div className={styles.editorFontSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-symbol-text" />
        <label className={styles.fieldLabel} htmlFor={UI_FONT_SELECT_ID}>
          {t('settings.basic.editorFont.label')}
        </label>
      </div>
      <select
        id={UI_FONT_SELECT_ID}
        aria-label={t('settings.basic.editorFont.label')}
        className={styles.languageSelect}
        value={selectedUiFontOption}
        onChange={handleUiFontSelectionChange}
      >
        <option value="followEditor">
          {t('settings.basic.editorFont.followOption', { font: uiFontConfig?.fontFamily || '-' })}
        </option>
        <option value="customFile">
          {customFontFileName
            ? `${t('settings.basic.editorFont.customOption')} / ${customFontFileName}`
            : t('settings.basic.editorFont.customOption')}
        </option>
      </select>

      {isCustomUiFontSelected && (
        <div className={styles.nodePathSection} style={NODE_PATH_SECTION_STYLE}>
          <div className={styles.fieldHeader}>
            <span className="codicon codicon-file-media" />
            <label className={styles.fieldLabel} htmlFor={UI_FONT_CUSTOM_PATH_ID}>
              {t('settings.basic.editorFont.customPathLabel')}
            </label>
          </div>
          <div className={styles.nodePathInputWrapper}>
            <input
              id={UI_FONT_CUSTOM_PATH_ID}
              type="text"
              className={styles.nodePathInput}
              placeholder={t('settings.basic.editorFont.customPathPlaceholder')}
              value={customFontPathDraft}
              onChange={(event) => setCustomFontPathDraft(event.target.value)}
            />
            <button
              type="button"
              className={styles.saveBtn}
              onClick={onBrowseUiFontFile}
              aria-label={t('settings.basic.editorFont.browse')}
              title={t('settings.basic.editorFont.browse')}
            >
              <span className="codicon codicon-folder-opened" />
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSaveCustomUiFontPath}
              disabled={isCustomPathEmpty}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      )}

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{uiFontHint}</span>
      </small>
    </div>
  );
};

export default UiFontSection;
