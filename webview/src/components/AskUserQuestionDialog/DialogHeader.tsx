import { useTranslation } from 'react-i18next';

interface DialogHeaderProps {
  title: string;
  isCollapsed: boolean;
  onToggle: () => void;
}

const DialogHeader = ({ title, isCollapsed, onToggle }: DialogHeaderProps) => {
  const { t } = useTranslation();
  const toggleLabel = isCollapsed
    ? t('askUserQuestion.expand', '展开')
    : t('askUserQuestion.collapse', '收起');

  return (
    <div className="ask-user-question-dialog-header">
      <h3 className="ask-user-question-dialog-title">
        {title}
      </h3>
      <button
        className="collapse-toggle-button"
        onClick={onToggle}
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={!isCollapsed}
      >
        <span className={`codicon codicon-chevron-${isCollapsed ? 'up' : 'down'}`} />
      </button>
    </div>
  );
};

export default DialogHeader;
