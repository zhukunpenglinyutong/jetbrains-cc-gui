import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig, PromptScope } from '../../../types/prompt';
import styles from './style.module.less';

interface PromptScopeSectionProps {
  /** Section title (e.g., "Global Prompts" or "Project Prompts - ProjectName") */
  title: string;
  /** Prompt scope (global or project) */
  scope: PromptScope;
  /** Prompt list for this scope */
  prompts: PromptConfig[];
  /** Loading state */
  loading: boolean;
  /** Handler for add button */
  onAdd: () => void;
  /** Handler for edit */
  onEdit: (prompt: PromptConfig) => void;
  /** Handler for delete */
  onDelete: (prompt: PromptConfig) => void;
  /** Handler for export */
  onExport: () => void;
  /** Handler for import */
  onImport: () => void;
  /** Handler for toggling auto inject */
  onToggleAutoInject: (prompt: PromptConfig) => void;
}

export default function PromptScopeSection({
  title,
  // scope is kept for API consistency and may be used in future enhancements
  scope: _scope,
  prompts,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onExport,
  onImport,
  onToggleAutoInject,
}: PromptScopeSectionProps) {
  const { t } = useTranslation();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleMenuToggle = (promptId: string) => {
    setOpenMenuId(openMenuId === promptId ? null : promptId);
  };

  const handleEditClick = (prompt: PromptConfig) => {
    setOpenMenuId(null);
    onEdit(prompt);
  };

  const handleDeleteClick = (prompt: PromptConfig) => {
    setOpenMenuId(null);
    onDelete(prompt);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h4 className={styles.sectionTitle}>{title}</h4>
        <div className={styles.sectionActions}>
          <button
            className={styles.exportButton}
            onClick={onExport}
            title={t('settings.prompt.export')}
          >
            <span className="codicon codicon-export" />
            {t('settings.prompt.export')}
          </button>
          <button
            className={styles.importButton}
            onClick={onImport}
            title={t('settings.prompt.import')}
          >
            <span className="codicon codicon-cloud-download" />
            {t('settings.prompt.import')}
          </button>
          <button
            className={styles.addButton}
            onClick={onAdd}
            title={t('settings.prompt.create')}
          >
            <span className="codicon codicon-add" />
            {t('settings.prompt.create')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.loadingState}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.prompt.loading')}</span>
        </div>
      ) : prompts.length === 0 ? (
        <div className={styles.emptyState}>
          <span>{t('settings.prompt.noPrompts')}</span>
          <button className={styles.createLink} onClick={onAdd}>
            {t('settings.prompt.create')}
          </button>
        </div>
      ) : (
        <div className={styles.promptList}>
          {prompts.map((prompt) => (
            <div key={prompt.id} className={styles.promptCard}>
              <div className={styles.promptIcon}>
                <span className="codicon codicon-bookmark" />
              </div>
              <div className={styles.promptInfo}>
                <div className={styles.promptName}>{prompt.name}</div>
                {prompt.content && (
                  <div className={styles.promptContent} title={prompt.content}>
                    {prompt.content.length > 80
                      ? prompt.content.substring(0, 80) + '...'
                      : prompt.content}
                  </div>
                )}
              </div>
              <div
                className={styles.promptActions}
                ref={openMenuId === prompt.id ? menuRef : null}
              >
                <button
                  className={`${styles.autoInjectButton} ${prompt.autoInject ? styles.autoInjectEnabled : ''}`}
                  onClick={() => onToggleAutoInject(prompt)}
                  title={
                    prompt.autoInject
                      ? t('settings.prompt.disableAutoInject')
                      : t('settings.prompt.enableAutoInject')
                  }
                  aria-label={
                    prompt.autoInject
                      ? t('settings.prompt.disableAutoInject')
                      : t('settings.prompt.enableAutoInject')
                  }
                >
                  <span
                    className={`codicon ${
                      prompt.autoInject ? 'codicon-check' : 'codicon-circle-large-outline'
                    }`}
                  />
                </button>
                <button
                  className={styles.menuButton}
                  onClick={() => handleMenuToggle(prompt.id)}
                  title={t('settings.prompt.menu')}
                  aria-label={t('settings.prompt.menu')}
                  aria-expanded={openMenuId === prompt.id}
                  aria-haspopup="true"
                >
                  <span className="codicon codicon-kebab-vertical" />
                </button>
                {openMenuId === prompt.id && (
                  <div className={styles.dropdownMenu} role="menu">
                    <button
                      className={styles.menuItem}
                      onClick={() => handleEditClick(prompt)}
                      role="menuitem"
                    >
                      <span className="codicon codicon-edit" />
                      {t('common.edit')}
                    </button>
                    <button
                      className={`${styles.menuItem} ${styles.danger}`}
                      onClick={() => handleDeleteClick(prompt)}
                      role="menuitem"
                    >
                      <span className="codicon codicon-trash" />
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
