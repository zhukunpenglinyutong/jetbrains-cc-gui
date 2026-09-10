import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../ConfirmDialog';
import { NodeProcessList } from './NodeProcessList';
import { getAppViewport } from '../../../utils/viewport';
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
  top: 0,
  left: '100%',
  marginLeft: 0,
  zIndex: 10001,
  minWidth: '260px',
  width: 'max-content',
  maxWidth: '360px',
  maxHeight: '380px',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '6px 0',
};

const DROPDOWN_SIDE_OVERLAP_PX = 30;
const DROPDOWN_VIEWPORT_PADDING_PX = 8;
const DROPDOWN_MIN_WIDTH_PX = 260;
const DROPDOWN_MIN_FLUSH_WIDTH_PX = 180;
const DROPDOWN_MAX_WIDTH_PX = 360;
const DROPDOWN_MAX_HEIGHT_PX = 380;
const DROPDOWN_BOTTOM_CLEARANCE_PX = 72;

// Pending PIDs are per-component-instance state. Each ConfigSelect (one per tab)
// owns its own pending set — sharing across instances would surface
// "still working..." spinners in tabs that never issued the kill.

type PendingConfirm =
  | { kind: 'kill'; proc: NodeProcessInfo }
  | { kind: 'restart'; proc: NodeProcessInfo }
  | { kind: 'killAll'; orphans: NodeProcessInfo[] };

export interface EmbeddedNodeProcessDropdownLayout {
  flipToLeft: boolean;
  maxWidth: number;
  maxHeight: number;
  topOffset: number;
  horizontalOverlap: number;
}

export interface EmbeddedNodeProcessDropdownLayoutInput {
  parentRect: { left: number; right: number; top: number };
  viewportWidth: number;
  viewportHeight: number;
  dropdownHeight: number;
}

export function getEmbeddedNodeProcessDropdownLayout({
  parentRect,
  viewportWidth,
  viewportHeight,
  dropdownHeight,
}: EmbeddedNodeProcessDropdownLayoutInput): EmbeddedNodeProcessDropdownLayout {
  const normalAvailableWidth = Math.max(
    0,
    viewportWidth - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.right,
  );
  const flippedAvailableWidth = Math.max(
    0,
    parentRect.left - DROPDOWN_VIEWPORT_PADDING_PX,
  );
  const normalShortfall = Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - normalAvailableWidth);
  const flippedShortfall = Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - flippedAvailableWidth);
  const flipToLeft = normalShortfall > 0 && flippedShortfall < normalShortfall;
  const availableWidthWithoutOverlap = flipToLeft ? flippedAvailableWidth : normalAvailableWidth;
  const horizontalOverlap = Math.min(
    DROPDOWN_SIDE_OVERLAP_PX,
    Math.max(0, DROPDOWN_MIN_FLUSH_WIDTH_PX - availableWidthWithoutOverlap),
  );
  const availableWidth = availableWidthWithoutOverlap + horizontalOverlap;
  const desiredHeight = Math.min(DROPDOWN_MAX_HEIGHT_PX, Math.max(1, Math.ceil(dropdownHeight)));
  const availableBelow = viewportHeight - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top;
  const minTopOffset = DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top;
  const topOffset = Math.max(
    minTopOffset,
    Math.min(0, availableBelow - desiredHeight - DROPDOWN_BOTTOM_CLEARANCE_PX),
  );
  const availableHeight = viewportHeight - DROPDOWN_VIEWPORT_PADDING_PX - parentRect.top - topOffset;

  return {
    flipToLeft,
    maxWidth: Math.max(1, Math.min(DROPDOWN_MAX_WIDTH_PX, Math.floor(availableWidth))),
    maxHeight: Math.max(1, Math.min(DROPDOWN_MAX_HEIGHT_PX, Math.floor(availableHeight))),
    topOffset,
    horizontalOverlap,
  };
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
  const [embeddedLayout, setEmbeddedLayout] = useState<EmbeddedNodeProcessDropdownLayout>(() => ({
    flipToLeft: false,
    maxWidth: DROPDOWN_MAX_WIDTH_PX,
    maxHeight: DROPDOWN_MAX_HEIGHT_PX,
    topOffset: 0,
    horizontalOverlap: 0,
  }));
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
    const parent = node.parentElement;
    if (!parent) return;

    const viewport = getAppViewport();
    const parentRect = parent.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextLayout = getEmbeddedNodeProcessDropdownLayout({
      parentRect: {
        left: parentRect.left - viewport.left,
        right: parentRect.right - viewport.left,
        top: parentRect.top - viewport.top,
      },
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      dropdownHeight: Math.max(nodeRect.height, node.scrollHeight),
    });

    setEmbeddedLayout((current) => (
      current.flipToLeft === nextLayout.flipToLeft
      && current.maxWidth === nextLayout.maxWidth
      && current.maxHeight === nextLayout.maxHeight
      && current.topOffset === nextLayout.topOffset
      && current.horizontalOverlap === nextLayout.horizontalOverlap
        ? current
        : nextLayout
    ));
  }, [embedded, snapshot]);

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

  const embeddedWidthStyle: React.CSSProperties = embedded
    ? {
        minWidth: `${Math.min(DROPDOWN_MIN_WIDTH_PX, embeddedLayout.maxWidth)}px`,
        maxWidth: `${embeddedLayout.maxWidth}px`,
        maxHeight: `${embeddedLayout.maxHeight}px`,
        top: `${embeddedLayout.topOffset}px`,
      }
    : {};

  const dropdownStyle: React.CSSProperties = embeddedLayout.flipToLeft
    ? {
        ...DROPDOWN_STYLE_EMBEDDED,
        ...embeddedWidthStyle,
        left: 'auto',
        right: '100%',
        marginLeft: 0,
        marginRight: `-${embeddedLayout.horizontalOverlap}px`,
        ['--selector-enter-x' as string]: '8px',
        ['--selector-enter-y' as string]: '0px',
      }
    : {
        ...DROPDOWN_STYLE_EMBEDDED,
        ...embeddedWidthStyle,
        marginLeft: `-${embeddedLayout.horizontalOverlap}px`,
        ['--selector-enter-x' as string]: '-8px',
        ['--selector-enter-y' as string]: '0px',
      };

  const renderDropdown = () => (
    <div
      ref={dropdownRef}
      className="selector-dropdown node-process-dropdown"
      style={dropdownStyle}
      onMouseEnter={(e) => e.stopPropagation()}
    >
      <NodeProcessList
        loading={loading}
        snapshot={snapshot}
        grouped={grouped}
        orphanCount={orphanCount}
        totalCount={totalCount}
        pendingPids={pendingPids}
        onRefresh={requestRefresh}
        onKill={handleKill}
        onRestart={handleRestart}
        onKillAllOrphans={handleKillAllOrphans}
      />
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
