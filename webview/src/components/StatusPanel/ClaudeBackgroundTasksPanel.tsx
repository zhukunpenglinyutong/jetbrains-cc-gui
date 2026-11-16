import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { getClaudeBackgroundTasks, subscribeClaudeBackgroundTasks } from '../../utils/claudeBackgroundTasks';
import { ClaudeBackgroundTaskRow, backgroundTaskKey, orderBackgroundTasks } from './ClaudeBackgroundTaskRow';
import './ClaudeBackgroundTasksPanel.css';

interface Props {
  provider: string;
  sessionId: string | null;
  foregroundActive: boolean;
  onStop: () => void;
}

/** Ticks once a second, only while the details are on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Same rule as StatusPanel's popover: open above unless the space below is larger and above is short. */
function useFitToWindow(rootRef: RefObject<HTMLDivElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    const fitToWindow = () => {
      // The anchor has zero height; opening above, the popover clears the pill (38px), below it keeps 16px.
      const top = root.getBoundingClientRect().top;
      const headerBottom = document.querySelector('.header')?.getBoundingClientRect().bottom ?? 0;
      const above = Math.max(0, top - headerBottom - 46);
      const below = Math.max(0, window.innerHeight - top - 24);
      const opensAbove = above >= 240 || above >= below;
      root.style.setProperty('--claude-bg-available-height', `${opensAbove ? above : below}px`);
      root.style.setProperty('--claude-bg-popover-top', opensAbove ? 'auto' : '16px');
      root.style.setProperty('--claude-bg-popover-bottom', opensAbove ? '38px' : 'auto');
    };
    fitToWindow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitToWindow);
    if (root.parentElement) observer?.observe(root.parentElement);
    const input = root.parentElement?.querySelector('.input-area');
    if (input) observer?.observe(input);
    window.addEventListener('resize', fitToWindow);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fitToWindow); };
  }, [rootRef, active]);
}

/**
 * Workflows can keep running after the foreground answer. Sending stays available.
 * Rendered as a zero-height anchor right above the status tabs, so the pill rides
 * their top border (or the input area's when the tabs are collapsed).
 */
export function ClaudeBackgroundTasksPanel({ provider, sessionId, foregroundActive, onStop }: Props) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribeClaudeBackgroundTasks, getClaudeBackgroundTasks);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = provider === 'claude' && !(sessionId && snapshot.sessionId !== sessionId) && snapshot.tasks.length > 0;
  const isOpen = open && visible;
  const now = useNow(isOpen);
  useFitToWindow(rootRef, isOpen);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  if (!visible) return null;

  const count = snapshot.tasks.length;
  const toggle = (key: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const jumpTo = (key: string) => {
    setExpanded(previous => new Set(previous).add(key));
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-task-key]') ?? [];
    Array.from(rows).find(row => row.dataset.taskKey === key)?.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <div className="claude-background-tasks" ref={rootRef}>
      <button type="button" className={`claude-bg-pill${isOpen ? ' open' : ''}`} aria-expanded={isOpen}
        title={t('chat.backgroundTasksRunning', { count })} onClick={() => setOpen(value => !value)}>
        <span className="claude-bg-dot" aria-hidden="true" />
        {t('chat.backgroundTasksPill', { count })}
        <span className="codicon codicon-chevron-up" aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="claude-bg-popover" role="dialog" aria-label={t('chat.backgroundTasksTitle')}>
          <div className="claude-bg-head">
            <span className="claude-bg-title">
              {t('chat.backgroundTasksTitle')}
              <span className="claude-bg-sub">{t('chat.backgroundTasksActive', { count })}</span>
            </span>
            {foregroundActive
              ? <span className="claude-bg-hint">{t('chat.backgroundTasksStopAfterAnswer')}</span>
              : <button type="button" className="claude-bg-stop" onClick={onStop}>
                <span className="codicon codicon-debug-stop" aria-hidden="true" />
                {t('chat.stopBackgroundTasks')}
              </button>}
            <button type="button" className="claude-bg-icon-btn" title={t('common.close')} aria-label={t('common.close')}
              onClick={() => setOpen(false)}>
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
          <ul className="claude-bg-list">
            {orderBackgroundTasks(snapshot.tasks).map(({ task, depth }) => {
              const key = backgroundTaskKey(task);
              const parent = snapshot.tasks.find(candidate => candidate.taskId === task.parentTaskId);
              return (
                <ClaudeBackgroundTaskRow key={key} task={task} depth={depth} parent={parent} now={now}
                  expanded={expanded.has(key)} onToggle={() => toggle(key)}
                  onJumpToParent={() => parent && jumpTo(backgroundTaskKey(parent))} />
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
