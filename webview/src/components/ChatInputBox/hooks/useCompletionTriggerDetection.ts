import { useCallback, useMemo, type RefObject } from 'react';
import { useTriggerDetection } from './useTriggerDetection.js';
import { debounce } from '../utils/debounce.js';
import { perfTimer } from '../../../utils/debug.js';
import { TEXT_LENGTH_THRESHOLDS, DEBOUNCE_TIMING } from '../../../constants/performance.js';

/**
 * Completion dropdown state interface
 */
interface CompletionDropdownState {
  isOpen: boolean;
  open: (position: { top: number; left: number; width: number; height: number }, trigger: { trigger: string; query: string; start: number; end: number }) => void;
  close: () => void;
  updateQuery: (trigger: { trigger: string; query: string; start: number; end: number }) => void;
}

/**
 * Hook parameters
 */
interface UseCompletionTriggerDetectionParams {
  editableRef: RefObject<HTMLDivElement | null>;
  sharedComposingRef: RefObject<boolean>;
  justRenderedTagRef: RefObject<boolean>;
  getTextContent: () => string;
  fileCompletion: CompletionDropdownState;
  commandCompletion: CompletionDropdownState;
  agentCompletion: CompletionDropdownState;
}

/**
 * useCompletionTriggerDetection - Completion trigger detection hook
 * Handles detection and triggering of @ / / # completion menus
 */
export function useCompletionTriggerDetection({
  editableRef,
  sharedComposingRef,
  justRenderedTagRef,
  getTextContent,
  fileCompletion,
  commandCompletion,
  agentCompletion,
}: UseCompletionTriggerDetectionParams) {
  const { detectTrigger, getTriggerPosition, getCursorPosition } = useTriggerDetection();

  /**
   * Detect and handle completion triggers
   * Optimized: only start detection when @ or / or # is input
   */
  const detectAndTriggerCompletion = useCallback(() => {
    const timer = perfTimer('detectAndTriggerCompletion');

    if (!editableRef.current) return;

    // Don't detect completion during IME composition to avoid interfering with composition
    // Use sharedComposingRef for reliable, up-to-date composing state check
    if (sharedComposingRef.current) {
      return;
    }

    // If file tags were just rendered, skip this completion detection
    if (justRenderedTagRef.current) {
      justRenderedTagRef.current = false;
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();
      return;
    }

    const text = getTextContent();
    timer.mark('getText');

    // Performance optimization: Skip completion detection for very large text
    // This prevents expensive operations (cursor position calculation, trigger detection) on large inputs
    if (text.length > TEXT_LENGTH_THRESHOLDS.COMPLETION_DETECTION) {
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();
      timer.mark('skip-large-text');
      timer.end();
      return;
    }

    // Optimization: Quick check if text contains trigger characters, return immediately if not
    const hasAtSymbol = text.includes('@');
    const hasSlashSymbol = text.includes('/');
    const hasHashSymbol = text.includes('#');

    if (!hasAtSymbol && !hasSlashSymbol && !hasHashSymbol) {
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();
      timer.end();
      return;
    }
    timer.mark('quickCheck');

    const cursorPos = getCursorPosition(editableRef.current);
    timer.mark('getCursorPos');

    // Pass element parameter so detectTrigger can skip file tags
    const trigger = detectTrigger(text, cursorPos, editableRef.current);
    timer.mark('detectTrigger');

    // Close currently open completion
    if (!trigger) {
      fileCompletion.close();
      commandCompletion.close();
      agentCompletion.close();
      timer.end();
      return;
    }

    // Get trigger position
    const position = getTriggerPosition(editableRef.current, trigger.start);
    if (!position) {
      timer.end();
      return;
    }

    // Open corresponding completion based on trigger symbol
    if (trigger.trigger === '@') {
      commandCompletion.close();
      agentCompletion.close();
      if (!fileCompletion.isOpen) {
        fileCompletion.open(position, trigger);
        fileCompletion.updateQuery(trigger);
      } else {
        fileCompletion.updateQuery(trigger);
      }
    } else if (trigger.trigger === '/') {
      fileCompletion.close();
      agentCompletion.close();
      if (!commandCompletion.isOpen) {
        commandCompletion.open(position, trigger);
        commandCompletion.updateQuery(trigger);
      } else {
        commandCompletion.updateQuery(trigger);
      }
    } else if (trigger.trigger === '#') {
      fileCompletion.close();
      commandCompletion.close();
      if (!agentCompletion.isOpen) {
        agentCompletion.open(position, trigger);
        agentCompletion.updateQuery(trigger);
      } else {
        agentCompletion.updateQuery(trigger);
      }
    }

    timer.end();
  }, [
    editableRef,
    sharedComposingRef,
    justRenderedTagRef,
    getTextContent,
    getCursorPosition,
    detectTrigger,
    getTriggerPosition,
    fileCompletion,
    commandCompletion,
    agentCompletion,
  ]);

  // Create debounced version of detectAndTriggerCompletion
  // Reduced from 150ms to improve responsiveness for trigger detection
  const debouncedDetectCompletion = useMemo(
    () => debounce(detectAndTriggerCompletion, DEBOUNCE_TIMING.COMPLETION_DETECTION_MS),
    [detectAndTriggerCompletion]
  );

  return {
    detectAndTriggerCompletion,
    debouncedDetectCompletion,
  };
}

export default useCompletionTriggerDetection;
