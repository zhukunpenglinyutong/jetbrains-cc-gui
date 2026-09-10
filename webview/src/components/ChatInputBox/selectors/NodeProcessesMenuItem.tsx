import { useTranslation } from 'react-i18next';
import { NodeProcessSelect } from './NodeProcessSelect';
import {
  AGENT_DESC_PLAIN_STYLE,
  ARROW_CONTAINER_STYLE,
  ARROW_ICON_STYLE,
  ITEM_INFO_STYLE,
  SELECTOR_OPTION_RELATIVE_STYLE,
} from './selectorStyles';

interface NodeProcessTotals {
  all: number;
  orphan: number;
}

interface NodeProcessesMenuItemProps {
  totals: NodeProcessTotals;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onToast: (message: string) => void;
  onClose: () => void;
}

/**
 * NodeProcessesMenuItem - Node process management trigger row (with the
 * process-count badge) plus its embedded NodeProcessSelect submenu.
 */
export const NodeProcessesMenuItem = ({
  totals,
  active,
  onEnter,
  onLeave,
  onToast,
  onClose,
}: NodeProcessesMenuItemProps) => {
  const { t } = useTranslation();

  return (
    <div
      className="selector-option"
      data-testid="config-option-node-processes"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={SELECTOR_OPTION_RELATIVE_STYLE}
    >
      <span className="codicon codicon-server-process" />
      <div style={ITEM_INFO_STYLE}>
        <span>{t('config.nodeProcesses.title', { defaultValue: 'Node 进程管理' })}</span>
        {totals.all > 0 ? (
          <span className="model-description" style={AGENT_DESC_PLAIN_STYLE}>
            {totals.orphan > 0
              ? t('config.nodeProcesses.badgeWithOrphan', {
                  total: totals.all,
                  orphan: totals.orphan,
                  defaultValue: '{{total}} 个 · {{orphan}} 孤立 ⚠',
                })
              : t('config.nodeProcesses.badge', {
                  total: totals.all,
                  defaultValue: '{{total}} 个进程',
                })}
          </span>
        ) : null}
      </div>
      <div style={ARROW_CONTAINER_STYLE}>
        <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
      </div>

      {active && (
        <NodeProcessSelect
          embedded
          onToast={onToast}
          onClose={onClose}
        />
      )}
    </div>
  );
};

export default NodeProcessesMenuItem;
