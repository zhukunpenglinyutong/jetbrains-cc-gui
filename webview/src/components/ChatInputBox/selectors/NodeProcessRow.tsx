import { useTranslation } from 'react-i18next';
import type { NodeProcessInfo } from '../../../utils/nodeProcessCapabilities';

const PROCESS_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 12px',
  cursor: 'default',
};

const PROCESS_LEADING_ICON_STYLE: React.CSSProperties = {
  fontSize: '14px',
  flexShrink: 0,
};

const PROCESS_BODY_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
};

const PROCESS_TITLE_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const PROCESS_META_STYLE: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const PROCESS_ACTIONS_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  gap: '2px',
  alignItems: 'center',
  flexShrink: 0,
};

const ICON_BUTTON_STYLE: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: '4px',
  width: '24px',
  height: '24px',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.15s, color 0.15s',
};

const ICON_BUTTON_DANGER_STYLE: React.CSSProperties = {
  ...ICON_BUTTON_STYLE,
  color: 'var(--error-color, #d9534f)',
};

function formatUptime(ms: number): string {
  if (ms <= 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function providerIcon(provider?: string, kind?: string): string {
  if (kind === 'ORPHAN') return 'codicon-warning';
  if (provider === 'claude') return 'codicon-server-process';
  if (provider === 'codex') return 'codicon-comment-discussion';
  return 'codicon-debug-disconnect';
}

function kindColor(kind: string): string {
  if (kind === 'DAEMON') return '#3fb950';
  if (kind === 'CHANNEL') return '#d29922';
  if (kind === 'ORPHAN') return '#d9534f';
  return 'var(--text-secondary)';
}

interface NodeProcessRowProps {
  proc: NodeProcessInfo;
  isPending: boolean;
  onKill: (proc: NodeProcessInfo) => void;
  onRestart: (proc: NodeProcessInfo) => void;
}

export const NodeProcessRow = ({ proc, isPending, onKill, onRestart }: NodeProcessRowProps) => {
  const { t } = useTranslation();
  // The leading icon's color already encodes provider (claude=green, codex=yellow,
  // orphan=red), so the title only carries the parts that are not already implied
  // visually. Provider stays in the hover tooltip below for completeness.
  const titleParts: string[] = [];
  if (proc.kind === 'DAEMON') {
    titleParts.push(t(`config.nodeProcesses.kind.daemonShort`, { defaultValue: 'Daemon' }));
  } else if (proc.kind === 'CHANNEL') {
    titleParts.push(t(`config.nodeProcesses.kind.channelShort`, { defaultValue: 'Channel' }));
  } else {
    titleParts.push(t(`config.nodeProcesses.kind.orphanShort`, { defaultValue: 'Orphan' }));
  }
  if (proc.tabName) titleParts.push(proc.tabName);
  const titleText = titleParts.join(' · ');

  const metaParts: string[] = [`PID ${proc.pid}`, formatUptime(proc.uptimeMs)];
  if (typeof proc.heapUsed === 'number' && proc.heapUsed > 0) {
    metaParts.push(formatBytes(proc.heapUsed));
  }
  if (proc.activeRequestCount > 0) {
    metaParts.push(t('config.nodeProcesses.activeRequests', {
      count: proc.activeRequestCount,
      defaultValue: '{{count}} active',
    }));
  }
  const metaText = metaParts.join(' · ');

  // Show full command + provider on row hover so users can still inspect them
  const tooltipLines: string[] = [titleText];
  if (proc.provider) {
    tooltipLines.push(`Provider: ${proc.provider}`);
  }
  tooltipLines.push(metaText);
  if (proc.command) {
    tooltipLines.push(proc.command);
  }
  const rowTooltip = tooltipLines.join('\n');

  const killIconClass = proc.kind === 'CHANNEL' ? 'codicon-debug-stop' : 'codicon-close';
  const killHintKey = proc.kind === 'CHANNEL'
    ? 'config.nodeProcesses.interrupt'
    : 'config.nodeProcesses.kill';

  return (
    <div style={PROCESS_ROW_STYLE} title={rowTooltip}>
      <span
        className={`codicon ${providerIcon(proc.provider, proc.kind)}`}
        style={{ ...PROCESS_LEADING_ICON_STYLE, color: kindColor(proc.kind) }}
      />
      <div style={PROCESS_BODY_STYLE}>
        <span style={PROCESS_TITLE_STYLE}>{titleText}</span>
        <span style={PROCESS_META_STYLE}>{metaText}</span>
      </div>
      <div style={PROCESS_ACTIONS_STYLE}>
        {proc.kind === 'DAEMON' && (
          <button
            type="button"
            className="node-process-icon-button"
            style={ICON_BUTTON_STYLE}
            disabled={isPending}
            onClick={(e) => { e.stopPropagation(); onRestart(proc); }}
            title={t('config.nodeProcesses.restart')}
            aria-label={t('config.nodeProcesses.restart')}
          >
            <span className={`codicon ${isPending ? 'codicon-loading codicon-modifier-spin' : 'codicon-debug-restart'}`} />
          </button>
        )}
        <button
          type="button"
          className="node-process-icon-button node-process-icon-button--danger"
          style={ICON_BUTTON_DANGER_STYLE}
          disabled={isPending}
          onClick={(e) => { e.stopPropagation(); onKill(proc); }}
          title={t(killHintKey)}
          aria-label={t(killHintKey)}
        >
          <span className={`codicon ${isPending ? 'codicon-loading codicon-modifier-spin' : killIconClass}`} />
        </button>
      </div>
    </div>
  );
};
