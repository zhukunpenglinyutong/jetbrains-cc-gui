import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnvVarEntry } from '../../types/provider';
import {
  isValidEnvVarKey,
  isProtectedEnvVarKey,
  ENV_VAR_VALUE_MAX_LENGTH,
} from '../../types/provider';
import styles from './style.module.less';

interface EnvVarEditorProps {
  /** Current env var entries */
  entries: EnvVarEntry[];
  /** Callback when entries change */
  onChange: (entries: EnvVarEntry[]) => void;
  /** Whether this editor is disabled */
  disabled?: boolean;
}

interface ValidationErrors {
  [key: string]: string;
}

export default function EnvVarEditor({ entries, onChange, disabled }: EnvVarEditorProps) {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<ValidationErrors>({});

  // Stable ids for React keys, parallel to entries array.
  // Avoids using array index as key which causes focus loss on delete.
  const nextIdRef = useRef(0);
  const [rowIds, setRowIds] = useState<string[]>(() =>
    entries.map(() => `env-${nextIdRef.current++}`)
  );

  // Sync rowIds when entries length changes externally (e.g., dialog reset)
  useEffect(() => {
    setRowIds((prev) => {
      if (prev.length === entries.length) {
        return prev;
      }
      const next = [...prev];
      while (next.length < entries.length) {
        next.push(`env-${nextIdRef.current++}`);
      }
      if (next.length > entries.length) {
        next.length = entries.length;
      }
      return next;
    });
  }, [entries.length]);

  const validateEntries = useCallback((newEntries: EnvVarEntry[]): ValidationErrors => {
    const newErrors: ValidationErrors = {};
    const seenKeys = new Set<string>();

    newEntries.forEach((entry, index) => {
      const key = entry.key.trim();
      const upperKey = key.toUpperCase();

      // Value length check (run regardless of key state)
      if (entry.value.length > ENV_VAR_VALUE_MAX_LENGTH) {
        newErrors[`${index}-value-length`] = t(
          'settings.codexProvider.dialog.envValueTooLong',
          { max: ENV_VAR_VALUE_MAX_LENGTH },
        );
      }

      if (!key) {
        return; // Empty key is allowed, will be filtered on save
      }

      // Check format
      if (!isValidEnvVarKey(key)) {
        newErrors[`${index}-key-format`] = t('settings.codexProvider.dialog.envKeyInvalid');
        return;
      }

      // Check protected
      if (isProtectedEnvVarKey(key)) {
        newErrors[`${index}-key-protected`] = t('settings.codexProvider.dialog.envKeyProtected', { key });
        return;
      }

      // Check duplicate (case-insensitive)
      if (seenKeys.has(upperKey)) {
        newErrors[`${index}-key-duplicate`] = t('settings.codexProvider.dialog.envKeyDuplicate', { key });
        return;
      }
      seenKeys.add(upperKey);
    });

    return newErrors;
  }, [t]);

  const handleKeyChange = useCallback((index: number, newKey: string) => {
    const newEntries = [...entries];
    newEntries[index] = { ...newEntries[index], key: newKey };
    onChange(newEntries);
    setErrors(validateEntries(newEntries));
  }, [entries, onChange, validateEntries]);

  const handleValueChange = useCallback((index: number, newValue: string) => {
    const newEntries = [...entries];
    newEntries[index] = { ...newEntries[index], value: newValue };
    onChange(newEntries);
    setErrors(validateEntries(newEntries));
  }, [entries, onChange, validateEntries]);

  const handleDelete = useCallback((index: number) => {
    const newEntries = entries.filter((_, i) => i !== index);
    onChange(newEntries);
    setRowIds((prev) => prev.filter((_, i) => i !== index));
    setErrors(validateEntries(newEntries));
  }, [entries, onChange, validateEntries]);

  const handleAdd = useCallback(() => {
    const newEntries = [...entries, { key: '', value: '' }];
    onChange(newEntries);
    setRowIds((prev) => [...prev, `env-${nextIdRef.current++}`]);
  }, [entries, onChange]);

  const handleBlur = useCallback(() => {
    setErrors(validateEntries(entries));
  }, [entries, validateEntries]);

  return (
    <div>
      {entries.length === 0 ? (
        <div className={styles.emptyState}>
          {t('settings.codexProvider.dialog.noEnvVars', 'No environment variables set')}
        </div>
      ) : (
        <div className={styles.envVarList}>
          {entries.map((entry, index) => {
            const rowId = rowIds[index] ?? `env-fallback-${index}`;
            return (
              <div key={rowId} className={styles.envVarItem}>
                <input
                  type="text"
                  className={styles.keyInput}
                  value={entry.key}
                  onChange={(e) => handleKeyChange(index, e.target.value)}
                  onBlur={handleBlur}
                  placeholder={t('settings.codexProvider.dialog.envKeyPlaceholder')}
                  disabled={disabled}
                  maxLength={256}
                />
                <input
                  type="text"
                  className={styles.valueInput}
                  value={entry.value}
                  onChange={(e) => handleValueChange(index, e.target.value)}
                  placeholder={t('settings.codexProvider.dialog.envValuePlaceholder')}
                  disabled={disabled}
                  maxLength={ENV_VAR_VALUE_MAX_LENGTH}
                />
                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={() => handleDelete(index)}
                  disabled={disabled}
                  title={t('common.delete')}
                >
                  <span className="codicon codicon-trash" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {Object.keys(errors).length > 0 && (
        <div className={styles.validationError}>
          {Object.values(errors)[0]}
        </div>
      )}
      <button
        type="button"
        className={styles.addBtn}
        onClick={handleAdd}
        disabled={disabled}
      >
        <span className="codicon codicon-add" />
        {t('settings.codexProvider.dialog.addEnvVar')}
      </button>
    </div>
  );
}
