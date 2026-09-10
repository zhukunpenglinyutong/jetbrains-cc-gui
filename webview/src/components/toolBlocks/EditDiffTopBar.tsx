import { useTranslation } from 'react-i18next';
import { showDiff, refreshFile } from '../../utils/bridge';

const TOP_BAR_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginBottom: '4px',
  paddingRight: '4px',
};

const TOP_BAR_INNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const ACTION_BUTTON_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2px 6px',
  fontSize: '11px',
  fontFamily: 'inherit',
  color: 'var(--text-secondary)',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-primary)',
  borderRadius: '4px',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  whiteSpace: 'nowrap',
};

const DIFF_BUTTON_ICON_STYLE: React.CSSProperties = {
  marginRight: '4px',
  fontSize: '12px',
};

const REFRESH_BUTTON_ICON_STYLE: React.CSSProperties = {
  fontSize: '12px',
};

interface EditDiffTopBarProps {
  filePath: string | undefined;
  oldString: string;
  newString: string;
  fileName: string | undefined;
}

const EditDiffTopBar = function EditDiffTopBar({ filePath, oldString, newString, fileName }: EditDiffTopBarProps) {
  const { t } = useTranslation();

  const handleShowDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      showDiff(filePath, oldString, newString, t('tools.editPrefix', { fileName }));
    }
  };

  const handleRefreshInIdea = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      refreshFile(filePath);
      window.addToast?.(t('tools.refreshFileInIdeaSuccess'), 'success');
    }
  };

  return (
    <div style={TOP_BAR_STYLE}>
      <div style={TOP_BAR_INNER_STYLE}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleShowDiff(e);
          }}
          title={t('tools.showDiffInIdea')}
          style={ACTION_BUTTON_STYLE}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--bg-tertiary)';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <span className="codicon codicon-diff" style={DIFF_BUTTON_ICON_STYLE} />
          {t('tools.diffButton')}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleRefreshInIdea(e);
          }}
          title={t('tools.refreshFileInIdea')}
          style={ACTION_BUTTON_STYLE}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--bg-tertiary)';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <span className="codicon codicon-refresh" style={REFRESH_BUTTON_ICON_STYLE} />
        </button>
      </div>
    </div>
  );
};

export default EditDiffTopBar;
