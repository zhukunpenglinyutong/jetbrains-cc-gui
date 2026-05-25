import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../ConfirmDialog';
import {
  fetchNodeProcesses,
  killAllOrphanProcesses,
  killNodeProcess,
  restartNodeDaemon,
  subscribeNodeProcessKillResult,
  subscribeNodeProcesses,
  type NodeProcessInfo,
  type NodeProcessSnapshot,
} from '../../../utils/nodeProcessCapabilities';

interface NodeProcessSelectProps {
  embedded?: boolean;
  onClose?: () => void;
  onToast?: (message: string) => void;
}

const DROPDOWN_STYLE_EMBEDDED: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: '100%',
  marginLeft: '-30px',
  zIndex: 10001,
  minWidth: '260px',
  width: 'max-content',
  maxWidth: 'min(360px, calc(100vw - 60px))',
  maxHeight: 'min(380px, calc(100vh - 100px))',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '6px 0',
};

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

// Pending PIDs are per-component-instance state. Each ConfigSelect (one per tab)
// owns its own pending set — sharing across instances would surface
// "still working..." spinners in tabs that never issued the kill.

type PendingConfirm =
  | { kind: 'kill'; proc: NodeProcessInfo }
  | { kind: 'restart'; proc: NodeProcessInfo }
  | { kind: 'killAll'; orphans: NodeProcessInfo[] };

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

/**
 * NodeProcessSelect - secondary menu that lists all Node.js child processes
 * for the current project, grouped by kind (daemon / channel / orphan).
 *
 * Designed to mirror RuntimeProviderSelect's `embedded` pattern so it can be
 * dropped into ConfigSelect's submenu slot.
 */
export const NodeProcessSelect = ({ embedded = false, onClose, onToast }: NodeProcessSelectProps) => {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<NodeProcessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingPids, setPendingPids] = useState<Set<number>>(() => new Set());
  const [flipToLeft, setFlipToLeft] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Detect when the dropdown would overflow the viewport on the right side and
  // flip it to render on the left of the parent menu item instead. Runs after
  // every snapshot update because the dropdown height/width can change.
  useLayoutEffect(() => {
    if (!embedded) return;
    const node = dropdownRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const overflowsRight = rect.right > window.innerWidth - 8;
    if (overflowsRight !== flipToLeft) {
      setFlipToLeft(overflowsRight);
    }
  }, [embedded, snapshot, flipToLeft]);

  const requestRefresh = useCallback(() => {
    setLoading(true);
    fetchNodeProcesses();
  }, []);

  // Subscribe to backend pushes
  useEffect(() => {
    const unsubSnapshot = subscribeNodeProcesses((data) => {
      setSnapshot(data);
      setLoading(false);
      setPendingPids((prev) => {
        if (prev.size === 0) return prev;
        // Clear pending markers for PIDs that have already disappeared from the
        // snapshot — the OS reaped them, so the spinner should stop.
        const livingPids = new Set(data.processes.map((p) => p.pid));
        const next = new Set<number>();
        prev.forEach((pid) => {
          if (livingPids.has(pid)) next.add(pid);
        });
        return next;
      });
    });

    const unsubKill = subscribeNodeProcessKillResult((result) => {
      if (result.error) {
        onToast?.(t('config.nodeProcesses.killFailed', { error: result.error }));
        return;
      }
      if (typeof result.killed === 'number' && result.killed > 0) {
        onToast?.(t('config.nodeProcesses.killAllSuccess', { count: result.killed }));
      } else if (result.success && result.restart) {
        onToast?.(t('config.nodeProcesses.restartSuccess'));
      } else if (result.success) {
        onToast?.(t('config.nodeProcesses.killSuccess'));
      }
    });

    return () => {
      unsubSnapshot();
      unsubKill();
    };
  }, [onToast, t]);

  // Refresh on open (embedded mode)
  useEffect(() => {
    if (!embedded) return;
    requestRefresh();
    // Refresh once after 1.5 s in case the OS hasn't reaped a recently-killed process yet
    refreshTimerRef.current = window.setTimeout(() => {
      fetchNodeProcesses();
    }, 1500);
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [embedded, requestRefresh]);

  const grouped = useMemo(() => {
    const daemon: NodeProcessInfo[] = [];
    const channel: NodeProcessInfo[] = [];
    const orphan: NodeProcessInfo[] = [];
    if (!snapshot) return { daemon, channel, orphan };
    for (const proc of snapshot.processes) {
      if (proc.kind === 'DAEMON') daemon.push(proc);
      else if (proc.kind === 'CHANNEL') channel.push(proc);
      else if (proc.kind === 'ORPHAN') orphan.push(proc);
    }
    return { daemon, channel, orphan };
  }, [snapshot]);

  const orphanCount = grouped.orphan.length;
  const totalCount = snapshot?.totals.all ?? 0;

  const markPending = useCallback((pid: number) => {
    setPendingPids((prev) => {
      const next = new Set(prev);
      next.add(pid);
      return next;
    });
  }, []);

  const handleKill = useCallback((proc: NodeProcessInfo) => {
    if (pendingPids.has(proc.pid)) return;
    // Orphans skip confirmation — they're already known-bad processes the user
    // explicitly wants to nuke. Live daemon / channel processes carry running
    // conversations, so we always confirm those.
    if (proc.kind === 'ORPHAN') {
      markPending(proc.pid);
      killNodeProcess(proc.pid, proc.id);
      return;
    }
    setPendingConfirm({ kind: 'kill', proc });
  }, [markPending, pendingPids]);

  const handleRestart = useCallback((proc: NodeProcessInfo) => {
    if (pendingPids.has(proc.pid)) return;
    setPendingConfirm({ kind: 'restart', proc });
  }, [pendingPids]);

  const handleKillAllOrphans = useCallback(() => {
    if (orphanCount === 0) return;
    setPendingConfirm({ kind: 'killAll', orphans: grouped.orphan });
  }, [grouped.orphan, orphanCount]);

  // Confirmation handlers — pulled out so the JSX stays declarative and the
  // tests can target the side-effect path independently of dialog rendering.
  const confirmExecute = useCallback(() => {
    if (!pendingConfirm) return;
    if (pendingConfirm.kind === 'kill') {
      markPending(pendingConfirm.proc.pid);
      killNodeProcess(pendingConfirm.proc.pid, pendingConfirm.proc.id);
    } else if (pendingConfirm.kind === 'restart') {
      markPending(pendingConfirm.proc.pid);
      restartNodeDaemon(pendingConfirm.proc.pid);
    } else {
      pendingConfirm.orphans.forEach((p) => markPending(p.pid));
      killAllOrphanProcesses();
    }
    setPendingConfirm(null);
  }, [markPending, pendingConfirm]);

  const confirmCancel = useCallback(() => {
    setPendingConfirm(null);
  }, []);

  // Build the dialog props from the confirmation kind so the JSX stays flat.
  const confirmDialogProps = useMemo(() => {
    if (!pendingConfirm) return null;
    if (pendingConfirm.kind === 'kill') {
      return {
        title: t('config.nodeProcesses.killConfirmTitle', { defaultValue: 'Terminate process?' }),
        message: t('config.nodeProcesses.killConfirm', { pid: pendingConfirm.proc.pid }),
        confirmText: t('config.nodeProcesses.kill'),
      };
    }
    if (pendingConfirm.kind === 'restart') {
      return {
        title: t('config.nodeProcesses.restartConfirmTitle', { defaultValue: 'Restart daemon?' }),
        message: t('config.nodeProcesses.restartConfirm'),
        confirmText: t('config.nodeProcesses.restart'),
      };
    }
    return {
      title: t('config.nodeProcesses.killAllConfirmTitle', { defaultValue: 'Clean up all orphans?' }),
      message: t('config.nodeProcesses.killAllConfirm', { count: pendingConfirm.orphans.length }),
      confirmText: t('config.nodeProcesses.killAll', { count: pendingConfirm.orphans.length }),
    };
  }, [pendingConfirm, t]);

  const renderRow = (proc: NodeProcessInfo) => {
    const isPending = pendingPids.has(proc.pid);
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
      <div key={proc.id} style={PROCESS_ROW_STYLE} title={rowTooltip}>
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
              onClick={(e) => { e.stopPropagation(); handleRestart(proc); }}
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
            onClick={(e) => { e.stopPropagation(); handleKill(proc); }}
            title={t(killHintKey)}
            aria-label={t(killHintKey)}
          >
            <span className={`codicon ${isPending ? 'codicon-loading codicon-modifier-spin' : killIconClass}`} />
          </button>
        </div>
      </div>
    );
  };

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
        {items.map(renderRow)}
      </div>
    );
  };

  // When the right edge would overflow the viewport, anchor the dropdown to
  // the parent menu item's LEFT side instead so it grows leftward and stays
  // entirely visible on narrow IDE windows.
  const dropdownStyle: React.CSSProperties = flipToLeft
    ? {
        ...DROPDOWN_STYLE_EMBEDDED,
        left: 'auto',
        right: '100%',
        marginLeft: 0,
        marginRight: '-30px',
      }
    : DROPDOWN_STYLE_EMBEDDED;

  const renderDropdown = () => (
    <div
      ref={dropdownRef}
      className="selector-dropdown node-process-dropdown"
      style={dropdownStyle}
      onMouseEnter={(e) => e.stopPropagation()}
    >
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
          onClick={(e) => { e.stopPropagation(); requestRefresh(); }}
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
            onClick={(e) => { e.stopPropagation(); handleKillAllOrphans(); }}
            title={t('config.nodeProcesses.killAllHint')}
          >
            <span className="codicon codicon-trash" style={{ marginRight: 4 }} />
            {t('config.nodeProcesses.killAll', { count: orphanCount })}
          </button>
        </div>
      ) : null}
    </div>
  );

  // Click-outside to close when not embedded (parent ConfigSelect already handles close-on-outside
  // in embedded mode, so we only auto-close when used standalone).
  useEffect(() => {
    if (embedded) return;
    const handleClickOutside = () => {
      onClose?.();
    };
    const id = window.setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [embedded, onClose]);

  return (
    <>
      {renderDropdown()}
      {confirmDialogProps && createPortal(
        <ConfirmDialog
          isOpen
          title={confirmDialogProps.title}
          message={confirmDialogProps.message}
          confirmText={confirmDialogProps.confirmText}
          cancelText={t('common.cancel')}
          onConfirm={confirmExecute}
          onCancel={confirmCancel}
        />,
        document.body,
      )}
    </>
  );
};

export default NodeProcessSelect;
