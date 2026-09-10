import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Skill, SkillsConfig, SkillScope, SkillFilter, SkillEnabledFilter } from '../../types/skill';
import { sendToJava } from '../../utils/bridge';
import { SkillHelpDialog } from './SkillHelpDialog';
import { SkillConfirmDialog } from './SkillConfirmDialog';
import { SkillToolbar } from './SkillToolbar';
import { SkillList } from './SkillList';
import { useSkillToggle } from './useSkillToggle';
import { useFilteredSkills } from './useFilteredSkills';
import { ToastContainer, type ToastMessage } from '../Toast';

interface SkillsSettingsSectionProps {
  currentProvider?: string;
}

/**
 * Skills settings component
 * Manages Claude/Codex Skills
 * Claude: global/local scopes, file-move enable/disable
 * Codex: user/repo scopes, config.toml enable/disable
 */
export function SkillsSettingsSection({ currentProvider = 'claude' }: SkillsSettingsSectionProps) {
  const { t } = useTranslation();
  // Skills data
  const [skills, setSkills] = useState<SkillsConfig>({ global: {}, local: {}, user: {}, repo: {} });
  const [loading, setLoading] = useState(true);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  // UI state
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentFilter, setCurrentFilter] = useState<SkillFilter>('all');
  const [enabledFilter, setEnabledFilter] = useState<SkillEnabledFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Dialog state
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [deletingSkill, setDeletingSkill] = useState<Skill | null>(null);

  // Toast state
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast helper functions
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const isCodex = currentProvider === 'codex';

  const loadSkills = useCallback(() => {
    setLoading(true);
    sendToJava('get_all_skills', {});
  }, []);

  // Enable/disable toggle state machine
  const { togglingSkills, handleToggle, handleToggleResult } = useSkillToggle(currentProvider, loadSkills, addToast);

  // Filtered/sorted skill lists and tab counts
  const {
    filteredSkills,
    totalCount,
    primaryCount,
    secondaryCount,
    enabledCount,
    disabledCount,
  } = useFilteredSkills(skills, isCodex, currentFilter, enabledFilter, searchQuery);

  // Initialization
  useEffect(() => {
    // Register callback: Java side returns Skills list
    window.updateSkills = (jsonStr: string) => {
      try {
        const data: SkillsConfig = JSON.parse(jsonStr);
        setSkills(data);
        setLoading(false);

      } catch (error) {
        console.error('[SkillsSettings] Failed to parse skills:', error);
        setLoading(false);
      }
    };

    // Register callback: import result
    window.skillImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        if (result.success) {
          const count = result.count || 0;
          const total = result.total || 0;
          if (result.errors && result.errors.length > 0) {
            addToast(t('skills.importPartialSuccess', { count, total }), 'warning');
          } else if (count === 1) {
            addToast(t('skills.importSuccessOne'), 'success');
          } else if (count > 1) {
            addToast(t('skills.importSuccess', { count }), 'success');
          }
          // Reload
          loadSkills();
        } else {
          addToast(result.error || t('skills.importFailed'), 'error');
        }
      } catch (error) {
        console.error('[SkillsSettings] Failed to parse import result:', error);
      }
    };

    // Register callback: delete result
    window.skillDeleteResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        if (result.success) {
          addToast(t('skills.deleteSuccess'), 'success');
          loadSkills();
        } else {
          addToast(result.error || t('skills.deleteFailed'), 'error');
        }
      } catch (error) {
        console.error('[SkillsSettings] Failed to parse delete result:', error);
      }
    };

    // Register callback: enable/disable result
    window.skillToggleResult = handleToggleResult;

    // Load Skills
    loadSkills();

    // Close dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);

    return () => {
      window.updateSkills = undefined;
      window.skillImportResult = undefined;
      window.skillDeleteResult = undefined;
      window.skillToggleResult = undefined;
      document.removeEventListener('click', handleClickOutside);
    };
  }, [loadSkills, addToast, handleToggleResult]);

  // Auto-refresh when provider changes (skip initial mount — handled by init useEffect above)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setCurrentFilter('all');
    loadSkills();
  }, [currentProvider, loadSkills]);

  // Toggle expand state (accordion behavior)
  const toggleExpand = (skillId: string) => {
    const newExpanded = new Set<string>();
    if (!expandedSkills.has(skillId)) {
      newExpanded.add(skillId);
    }
    setExpandedSkills(newExpanded);
  };

  // Refresh
  const handleRefresh = () => {
    loadSkills();
    addToast(t('skills.refreshed'), 'success');
  };

  // Import Skill
  const handleImport = (scope: SkillScope) => {
    setShowDropdown(false);
    sendToJava('import_skill', { scope });
  };

  // Get the primary/secondary scope values based on provider
  const primaryScope: SkillScope = isCodex ? 'user' : 'global';
  const secondaryScope: SkillScope = isCodex ? 'repo' : 'local';

  // Open in editor
  const handleOpen = (skill: Skill) => {
    sendToJava('open_skill', { path: skill.path });
  };

  // Delete Skill
  const handleDelete = (skill: Skill) => {
    setDeletingSkill(skill);
    setShowConfirmDialog(true);
  };

  // Confirm deletion
  const confirmDelete = () => {
    if (deletingSkill) {
      sendToJava('delete_skill', {
        name: deletingSkill.name,
        scope: deletingSkill.scope,
        enabled: deletingSkill.enabled,
        ...(isCodex && deletingSkill.skillPath ? { skillPath: deletingSkill.skillPath } : {}),
      });
      setExpandedSkills((prev) => {
        const newSet = new Set(prev);
        newSet.delete(deletingSkill.id);
        return newSet;
      });
    }
    setShowConfirmDialog(false);
    setDeletingSkill(null);
  };

  // Cancel deletion
  const cancelDelete = () => {
    setShowConfirmDialog(false);
    setDeletingSkill(null);
  };

  return (
    <div className="skills-settings-section">
      {/* Toolbar */}
      <SkillToolbar
        isCodex={isCodex}
        currentFilter={currentFilter}
        enabledFilter={enabledFilter}
        totalCount={totalCount}
        primaryCount={primaryCount}
        secondaryCount={secondaryCount}
        enabledCount={enabledCount}
        disabledCount={disabledCount}
        searchQuery={searchQuery}
        loading={loading}
        showDropdown={showDropdown}
        dropdownRef={dropdownRef}
        primaryScope={primaryScope}
        secondaryScope={secondaryScope}
        onFilterChange={setCurrentFilter}
        onEnabledFilterChange={setEnabledFilter}
        onSearchChange={setSearchQuery}
        onShowHelp={() => setShowHelpDialog(true)}
        onToggleDropdown={() => setShowDropdown(!showDropdown)}
        onImport={handleImport}
        onRefresh={handleRefresh}
      />

      {/* Skills list */}
      <SkillList
        skills={filteredSkills}
        loading={loading}
        expandedSkills={expandedSkills}
        togglingSkills={togglingSkills}
        onToggleExpand={toggleExpand}
        onToggle={handleToggle}
        onOpen={handleOpen}
        onDelete={handleDelete}
      />

      {/* Dialogs */}
      {showHelpDialog && (
        <SkillHelpDialog onClose={() => setShowHelpDialog(false)} currentProvider={currentProvider} />
      )}

      {showConfirmDialog && deletingSkill && (
        <SkillConfirmDialog
          title={t('skills.deleteTitle')}
          message={t('skills.deleteMessage', {
            scope: isCodex
              ? ((deletingSkill.scope === 'user') ? t('skills.deleteMessageUser') : t('skills.deleteMessageRepo'))
              : ((deletingSkill.scope === 'global') ? t('skills.deleteMessageGlobal') : t('skills.deleteMessageLocal')),
            name: deletingSkill.name
          })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
