import { useState, useRef, useEffect } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

function getSwatchStyle(color: string): React.CSSProperties {
  return { backgroundColor: color };
}

interface ColorPreset {
  color: string;
  label: string;
}

interface ColorSettingSectionProps {
  iconClassName: string;
  i18nPrefix: string;
  resolvedTheme: 'light' | 'dark';
  darkPresets: ColorPreset[];
  lightPresets: ColorPreset[];
  darkDefault: string;
  lightDefault: string;
  color: string;
  onColorChange: (color: string) => void;
}

const ColorSettingSection = ({
  iconClassName,
  i18nPrefix,
  resolvedTheme,
  darkPresets,
  lightPresets,
  darkDefault,
  lightDefault,
  color,
  onColorChange,
}: ColorSettingSectionProps) => {
  const { t } = useTranslation();
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [hexInput, setHexInput] = useState(color || '');

  useEffect(() => {
    setHexInput(color || '');
  }, [color]);

  const defaultColor = resolvedTheme === 'light' ? lightDefault : darkDefault;
  const presets = resolvedTheme === 'light' ? lightPresets : darkPresets;

  const handlePresetClick = (presetColor: string) => {
    if (presetColor === defaultColor) {
      onColorChange('');
    } else {
      onColorChange(presetColor);
    }
  };

  const handleColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onColorChange(e.target.value);
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onColorChange(value);
    }
  };

  const handleResetColor = () => {
    onColorChange('');
  };

  const isPresetActive = (presetColor: string) => {
    if (presetColor === defaultColor && !color) return true;
    return color.toLowerCase() === presetColor.toLowerCase();
  };

  return (
    <div className={styles.bgColorSection}>
      <div className={styles.fieldHeader}>
        <span className={iconClassName} />
        <span className={styles.fieldLabel}>{t(`${i18nPrefix}.label`)}</span>
      </div>

      <div className={styles.colorPresets}>
        {presets.map((preset) => (
          <div
            key={preset.color}
            className={`${styles.colorSwatch} ${isPresetActive(preset.color) ? styles.active : ''}`}
            onClick={() => handlePresetClick(preset.color)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePresetClick(preset.color);
              }
            }}
            role="button"
            tabIndex={0}
            title={preset.label}
            aria-label={preset.label}
          >
            <div
              className={styles.colorSwatchInner}
              style={getSwatchStyle(preset.color)}
            />
          </div>
        ))}
      </div>

      <div className={styles.customColorRow}>
        <span className={styles.customColorLabel}>{t(`${i18nPrefix}.custom`)}</span>
        <div
          className={styles.colorPickerWrapper}
          onClick={() => colorInputRef.current?.click()}
        >
          <div
            className={styles.colorPickerPreview}
            style={getSwatchStyle(color || defaultColor)}
          />
          <input
            ref={colorInputRef}
            type="color"
            className={styles.colorPickerInput}
            value={color || defaultColor}
            onChange={handleColorInputChange}
          />
        </div>
        <input
          type="text"
          className={styles.hexInput}
          value={hexInput}
          onChange={handleHexInputChange}
          placeholder="#000000"
          maxLength={7}
        />
        {color && (
          <button
            className={styles.resetBtn}
            onClick={handleResetColor}
            title={t(`${i18nPrefix}.reset`)}
          >
            <span className="codicon codicon-discard" />
            {t(`${i18nPrefix}.reset`)}
          </button>
        )}
      </div>

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{t(`${i18nPrefix}.hint`)}</span>
      </small>
    </div>
  );
};

export default ColorSettingSection;
