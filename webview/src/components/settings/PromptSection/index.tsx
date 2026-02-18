import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig } from '../../../types/prompt';
import styles from './style.module.less';

interface PromptSectionProps {
  prompts: PromptConfig[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (prompt: PromptConfig) => void;
  onDelete: (prompt: PromptConfig) => void;
}

export default function PromptSection({
  prompts,
  loading,
  onAdd,
  onEdit,
  onDelete,
}: PromptSectionProps) {
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
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleWrapper}>
          <h3 className={styles.title}>{t('settings.prompt.title')}</h3>
        </div>
        <button className={styles.addButton} onClick={onAdd}>
          <span className="codicon codicon-add" />
          {t('settings.prompt.create')}
        </button>
      </div>

      <div className={styles.description}>
        {t('settings.prompt.description')}
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('settings.prompt.customPrompts')}</h4>

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
                <div className={styles.promptActions} ref={openMenuId === prompt.id ? menuRef : null}>
                  <button
                    className={styles.menuButton}
                    onClick={() => handleMenuToggle(prompt.id)}
                    title={t('settings.prompt.menu')}
                  >
                    <span className="codicon codicon-kebab-vertical" />
                  </button>
                  {openMenuId === prompt.id && (
                    <div className={styles.dropdownMenu}>
                      <button
                        className={styles.menuItem}
                        onClick={() => handleEditClick(prompt)}
                      >
                        <span className="codicon codicon-edit" />
                        {t('common.edit')}
                      </button>
                      <button
                        className={`${styles.menuItem} ${styles.danger}`}
                        onClick={() => handleDeleteClick(prompt)}
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
    </div>
  );
}
