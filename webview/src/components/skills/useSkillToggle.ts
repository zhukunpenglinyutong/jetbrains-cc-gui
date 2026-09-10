import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Skill } from '../../types/skill';
import { sendToJava } from '../../utils/bridge';
import type { ToastMessage } from '../Toast';

interface SkillToggleResult {
  success: boolean;
  enabled?: boolean;
  id?: string;
  requestId?: string;
  name?: string;
  error?: string;
  conflict?: boolean;
}

/**
 * Enable/disable toggle state machine for skills.
 * Tracks in-flight toggles, matches async Java-side results by requestId,
 * and times out stuck requests.
 */
export function useSkillToggle(
  currentProvider: string,
  loadSkills: () => void,
  addToast: (message: string, type?: ToastMessage['type']) => void
) {
  const { t } = useTranslation();
  const isCodex = currentProvider === 'codex';

  // Skills currently being toggled (used to disable buttons and prevent duplicate clicks)
  const [togglingSkills, setTogglingSkills] = useState<Set<string>>(new Set());
  const toggleTimeoutsRef = useRef<Map<string, number>>(new Map());
  const latestToggleRequestsRef = useRef<Map<string, string>>(new Map());
  const toggleRequestSequenceRef = useRef(0);

  useEffect(() => {
    setTogglingSkills(new Set());
  }, [currentProvider]);

  // Clear pending toggle bookkeeping on unmount
  useEffect(() => {
    return () => {
      toggleTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId));
      toggleTimeoutsRef.current.clear();
      latestToggleRequestsRef.current.clear();
    };
  }, []);

  // Enable/disable Skill
  const handleToggle = (skill: Skill, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering card expand
    if (togglingSkills.has(skill.id) || toggleTimeoutsRef.current.has(skill.id)) return;

    const requestId = `${Date.now()}-${++toggleRequestSequenceRef.current}`;
    latestToggleRequestsRef.current.set(skill.id, requestId);
    setTogglingSkills(prev => new Set(prev).add(skill.id));
    const timeoutId = window.setTimeout(() => {
      if (latestToggleRequestsRef.current.get(skill.id) !== requestId) {
        return;
      }
      latestToggleRequestsRef.current.delete(skill.id);
      toggleTimeoutsRef.current.delete(skill.id);
      setTogglingSkills(prev => {
        const next = new Set(prev);
        next.delete(skill.id);
        return next;
      });
      addToast(t('skills.operationError'), 'error');
    }, 15000);
    toggleTimeoutsRef.current.set(skill.id, timeoutId);
    sendToJava('toggle_skill', {
      id: skill.id,
      requestId,
      name: skill.name,
      scope: skill.scope,
      enabled: skill.enabled,
      ...(isCodex && skill.skillPath ? { skillPath: skill.skillPath } : {}),
    });
  };

  // Handle enable/disable result from the Java side
  const handleToggleResult = useCallback((jsonStr: string) => {
    try {
      const result = JSON.parse(jsonStr) as SkillToggleResult;
      if (!result.id || !result.requestId
          || latestToggleRequestsRef.current.get(result.id) !== result.requestId) {
        return;
      }

      latestToggleRequestsRef.current.delete(result.id);
      const timeoutId = toggleTimeoutsRef.current.get(result.id);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        toggleTimeoutsRef.current.delete(result.id);
      }
      setTogglingSkills(prev => {
        const next = new Set(prev);
        next.delete(result.id as string);
        return next;
      });

      if (result.success) {
        addToast(result.enabled ? t('skills.enableSuccess', { name: result.name }) : t('skills.disableSuccess', { name: result.name }), 'success');
        loadSkills();
      } else {
        if (result.conflict) {
          addToast(t('skills.operationFailed', { error: result.error }), 'warning');
        } else {
          addToast(result.error || t('skills.operationError'), 'error');
        }
      }
    } catch (error) {
      console.error('[SkillsSettings] Failed to parse toggle result:', error);
    }
  }, [addToast, loadSkills]);

  return { togglingSkills, handleToggle, handleToggleResult };
}
