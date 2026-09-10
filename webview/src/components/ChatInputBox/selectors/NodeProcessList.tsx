import { useTranslation } from 'react-i18next';
import type {
  NodeProcessInfo,
  NodeProcessSnapshot,
} from '../../../utils/nodeProcessCapabilities';
import { NodeProcessRow } from './NodeProcessRow';

const GROUP_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 12px 4px',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const GROUP_HEADER_ORPHAN_STYLE: React.CSSProperties = {
  ...GROUP_HEADER_STYLE,
  color: 'var(--error-color, #d9534f)',
};

const EMPTY_STATE_STYLE: React.CSSProperties = {
  padding: '20px 12px',
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: '12px',
};

const FOOTER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '6px 12px 2px',
  borderTop: '1px solid var(--dropdown-border)',
  marginTop: '4px',
};

const FOOTER_BUTTON_STYLE: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--error-color, #d9534f)',
  fontSize: '11px',
  cursor: 'pointer',
  padding: '4px 8px',
  borderRadius: '4px',
};

const REFRESH_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 12px 6px',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--dropdown-border)',
};

const REFRESH_BUTTON_STYLE: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '2px 6px',
};

export interface NodeProcessGroups {
  daemon: NodeProcessInfo[];
  channel: NodeProcessInfo[];
  orphan: NodeProcessInfo[];
}

interface NodeProcessListProps {
  loading: boolean;
  snapshot: NodeProcessSnapshot | null;
  grouped: NodeProcessGroups;
  orphanCount: number;
  totalCount: number;
  pendingPids: Set<number>;
  onRefresh: () => void;
  onKill: (proc: NodeProcessInfo) => void;
  onRestart: (proc: NodeProcessInfo) => void;
  onKillAllOrphans: () => void;
}

export const NodeProcessList = ({
  loading,
  snapshot,
  grouped,
  orphanCount,
  totalCount,
  pendingPids,
  onRefresh,
  onKill,
  onRestart,
  onKillAllOrphans,
}: NodeProcessListProps) => {
  const { t } = useTranslation();

  const renderGroup = (
    label: string,
    items: NodeProcessInfo[],
    headerStyle: React.CSSProperties = GROUP_HEADER_STYLE,
    icon?: string,
  ) => {
    if (items.length === 0) return null;
    return (
      <div>
        <div style={headerStyle}>
          {icon ? <span className={`codicon ${icon}`} /> : null}
          <span>{label} ({items.length})</span>
        </div>
        {items.map((proc) => (
          <NodeProcessRow
            key={proc.id}
            proc={proc}
            isPending={pendingPids.has(proc.pid)}
            onKill={onKill}
            onRestart={onRestart}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      <div style={REFRESH_ROW_STYLE}>
        <span>
          {t('config.nodeProcesses.summary', {
            total: totalCount,
            orphan: orphanCount,
            defaultValue: 'Total: {{total}} · Orphans: {{orphan}}',
          })}
        </span>
        <button
          type="button"
          style={REFRESH_BUTTON_STYLE}
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          title={t('config.nodeProcesses.refresh')}
        >
          <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} />
        </button>
      </div>

      {loading && !snapshot ? (
        <div style={EMPTY_STATE_STYLE}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span style={{ marginLeft: 6 }}>{t('config.nodeProcesses.loading')}</span>
        </div>
      ) : totalCount === 0 ? (
        <div style={EMPTY_STATE_STYLE}>
          <span className="codicon codicon-info" />
          <span style={{ marginLeft: 6 }}>{t('config.nodeProcesses.empty')}</span>
        </div>
      ) : (
        <>
          {renderGroup(
            t('config.nodeProcesses.groups.daemon'),
            grouped.daemon,
            GROUP_HEADER_STYLE,
            'codicon-server-process',
          )}
          {renderGroup(
            t('config.nodeProcesses.groups.channel'),
            grouped.channel,
            GROUP_HEADER_STYLE,
            'codicon-comment-discussion',
          )}
          {renderGroup(
            t('config.nodeProcesses.groups.orphan'),
            grouped.orphan,
            GROUP_HEADER_ORPHAN_STYLE,
            'codicon-warning',
          )}
        </>
      )}

      {orphanCount > 0 ? (
        <div style={FOOTER_STYLE}>
          <button
            type="button"
            style={FOOTER_BUTTON_STYLE}
            onClick={(e) => { e.stopPropagation(); onKillAllOrphans(); }}
            title={t('config.nodeProcesses.killAllHint')}
          >
            <span className="codicon codicon-trash" style={{ marginRight: 4 }} />
            {t('config.nodeProcesses.killAll', { count: orphanCount })}
          </button>
        </div>
      ) : null}
    </>
  );
};
