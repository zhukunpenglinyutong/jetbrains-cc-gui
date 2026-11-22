import { useTranslation } from 'react-i18next';
import BashGroupCopyButton from './BashGroupCopyButton';

export interface BashItem {
  command: string;
  rawCommand: string;
  description: string;
  justification: string;
  output: string;
  isCompleted: boolean;
  isError: boolean;
  toolId?: string;
}

interface BashGroupItemRowProps {
  item: BashItem;
  expanded: boolean;
  onToggle: () => void;
}

type ItemStatus = 'completed' | 'pending' | 'error';

const STATUS_ICON: Record<ItemStatus, string> = {
  completed: 'codicon codicon-check',
  error: 'codicon codicon-close',
  pending: 'bash-group-spinner',
};

function itemStatus(item: BashItem): ItemStatus {
  if (item.isError) return 'error';
  return item.isCompleted ? 'completed' : 'pending';
}

/** True when the description says something the command itself does not */
function hasOwnDescription(item: BashItem): boolean {
  const description = item.description.trim();
  return description !== '' && description !== item.command && description !== item.rawCommand;
}

function RowLabel({ item }: { item: BashItem }) {
  if (!item.command) {
    return <span className="bash-group-row-desc solo">{item.description}</span>;
  }
  const commandText = <span className="bash-group-row-command-text code-font-surface">{item.command}</span>;
  if (hasOwnDescription(item)) {
    return (
      <>
        <span className="bash-group-row-desc" title={item.description}>{item.description}</span>
        <span className="bash-group-row-command" title={item.rawCommand}>{commandText}</span>
      </>
    );
  }
  return (
    <span className="bash-group-row-command solo" title={item.rawCommand}>
      <span className="bash-group-prompt code-font-surface" aria-hidden="true">$</span>
      {commandText}
    </span>
  );
}

function ItemDetail({ item }: { item: BashItem }) {
  const { t } = useTranslation();
  const status = itemStatus(item);
  const label = status === 'error' ? t('tools.bashGroupOutputFailed')
    : status === 'completed' ? t('tools.bashGroupOutput') : t('tools.bashGroupRunning');

  return (
    <div className={`bash-group-detail ${status === 'error' ? 'error' : ''}`}>
      <div className="bash-group-detail-bar">
        <span className="bash-group-detail-label">{label}</span>
        {item.output && <BashGroupCopyButton text={item.output} label={t('tools.bashGroupCopyOutput')} />}
      </div>
      {item.justification && (
        <div className="bash-group-detail-reason">{t('tools.commandApprovalReason')}: {item.justification}</div>
      )}
      <div className="bash-group-detail-body">
        {item.rawCommand && (
          <div className="bash-group-detail-command">
            <span className="bash-group-prompt code-font-surface" aria-hidden="true">$</span>
            <span className="bash-group-detail-command-text code-font-surface">{item.rawCommand}</span>
          </div>
        )}
        {item.isCompleted && (
          <div className="bash-group-detail-output code-font-surface">
            {item.output || t('tools.bashGroupNoOutput')}
          </div>
        )}
      </div>
    </div>
  );
}

const BashGroupItemRow = ({ item, expanded, onToggle }: BashGroupItemRowProps) => {
  const { t } = useTranslation();
  const status = itemStatus(item);

  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onToggle();
  };

  // Keep Enter/Space on this row from also reaching window-level shortcuts
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };

  return (
    <div className={`bash-group-item ${status === 'error' ? 'error' : ''} ${expanded ? 'expanded' : ''}`}>
      <div className="bash-group-row">
        <button
          type="button"
          className="bash-group-row-toggle"
          aria-expanded={expanded}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          <span className={`bash-group-row-status ${status}`}>
            <span className={STATUS_ICON[status]} />
          </span>
          <span className="bash-group-row-main">
            <RowLabel item={item} />
          </span>
        </button>
        {item.rawCommand && <BashGroupCopyButton text={item.rawCommand} label={t('tools.bashGroupCopyCommand')} />}
      </div>
      {expanded && <ItemDetail item={item} />}
    </div>
  );
};

export default BashGroupItemRow;
