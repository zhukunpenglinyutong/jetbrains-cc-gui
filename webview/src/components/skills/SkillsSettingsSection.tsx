import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Skill, SkillsConfig, SkillScope, SkillFilter, SkillEnabledFilter } from '../../types/skill';
import { sendToJava } from '../../utils/bridge';
import { SkillHelpDialog } from './SkillHelpDialog';
import { SkillConfirmDialog } from './SkillConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';

/**
 * Skills settings component
 * Manages Claude Skills (global and local)
 * Supports enabling/disabling Skills by moving files between active and managed directories
 */
export function SkillsSettingsSection() {
  const { t } = useTranslation();
  // Skills data
  const [skills, setSkills] = useState<SkillsConfig>({ global: {}, local: {} });
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

  // Skills currently being toggled (used to disable buttons and prevent duplicate clicks)
  const [togglingSkills, setTogglingSkills] = useState<Set<string>>(new Set());

  // Toast state
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast helper functions
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  // Compute Skills lists
  const globalSkillList = useMemo(() => Object.values(skills.global), [skills.global]);
  const localSkillList = useMemo(() => Object.values(skills.local), [skills.local]);
  const allSkillList = useMemo(() => [...globalSkillList, ...localSkillList], [globalSkillList, localSkillList]);

  // Filtered Skills list
  const filteredSkills = useMemo(() => {
    let list: Skill[] = [];
    if (currentFilter === 'all') {
      list = allSkillList;
    } else if (currentFilter === 'global') {
      list = globalSkillList;
    } else {
      list = localSkillList;
    }

    // Filter by enabled status
    if (enabledFilter === 'enabled') {
      list = list.filter(s => s.enabled);
    } else if (enabledFilter === 'disabled') {
      list = list.filter(s => !s.enabled);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.path.toLowerCase().includes(query) ||
        (s.description && s.description.toLowerCase().includes(query))
      );
    }

    // Sort by enabled status: enabled first
    return list.sort((a, b) => {
      if (a.enabled === b.enabled) return 0;
      return a.enabled ? -1 : 1;
    });
  }, [currentFilter, enabledFilter, searchQuery, allSkillList, globalSkillList, localSkillList]);

  // Counts
  const totalCount = allSkillList.length;
  const globalCount = globalSkillList.length;
  const localCount = localSkillList.length;
  const enabledCount = allSkillList.filter(s => s.enabled).length;
  const disabledCount = allSkillList.filter(s => !s.enabled).length;

  // Icon colors
  const iconColors = [
    '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
    '#EF4444', '#EC4899', '#06B6D4', '#6366F1',
  ];

  const getIconColor = (skillId: string): string => {
    let hash = 0;
    for (let i = 0; i < skillId.length; i++) {
      hash = skillId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return iconColors[Math.abs(hash) % iconColors.length];
  };

  // Initialization
  useEffect(() => {
    // Register callback: Java side returns Skills list
    window.updateSkills = (jsonStr: string) => {
      try {
        const data: SkillsConfig = JSON.parse(jsonStr);
        setSkills(data);
        setLoading(false);
        console.log('[SkillsSettings] Loaded skills:', data);
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
          addToast(result.error || '删除 Skill 失败', 'error');
        }
      } catch (error) {
        console.error('[SkillsSettings] Failed to parse delete result:', error);
      }
    };

    // Register callback: enable/disable result
    window.skillToggleResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        // Remove in-progress state
        setTogglingSkills(prev => {
          const newSet = new Set(prev);
          if (result.name) {
            // Try to remove possible ID variants
            newSet.forEach(id => {
              if (id.includes(result.name)) {
                newSet.delete(id);
              }
            });
          }
          return newSet;
        });

        if (result.success) {
          const action = result.enabled ? '启用' : '停用';
          addToast(`已成功${action} Skill: ${result.name}`, 'success');
          loadSkills();
        } else {
          if (result.conflict) {
            addToast(`操作失败: ${result.error}`, 'warning');
          } else {
            addToast(result.error || '操作 Skill 失败', 'error');
          }
        }
      } catch (error) {
        console.error('[SkillsSettings] Failed to parse toggle result:', error);
        setTogglingSkills(new Set()); // Clear on error
      }
    };

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
  }, []);

  const loadSkills = () => {
    setLoading(true);
    sendToJava('get_all_skills', {});
  };

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
    addToast('已刷新 Skills 列表', 'success');
  };

  // Import Skill
  const handleImport = (scope: SkillScope) => {
    setShowDropdown(false);
    // Send import request; Java side will show a file chooser dialog
    sendToJava('import_skill', { scope });
  };

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
        enabled: deletingSkill.enabled
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

  // Enable/disable Skill
  const handleToggle = (skill: Skill, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering card expand
    if (togglingSkills.has(skill.id)) return; // Prevent duplicate clicks

    setTogglingSkills(prev => new Set(prev).add(skill.id));
    sendToJava('toggle_skill', {
      name: skill.name,
      scope: skill.scope,
      enabled: skill.enabled
    });
  };

  return (
    <div className="skills-settings-section">
      {/* Toolbar */}
      <div className="skills-toolbar">
        {/* Filter tabs */}
        <div className="filter-tabs">
          <div
            className={`tab-item ${currentFilter === 'all' ? 'active' : ''}`}
            onClick={() => setCurrentFilter('all')}
          >
            {t('skills.all')} <span className="count-badge">{totalCount}</span>
          </div>
          <div
            className={`tab-item ${currentFilter === 'global' ? 'active' : ''}`}
            onClick={() => setCurrentFilter('global')}
          >
            {t('skills.global')} <span className="count-badge">{globalCount}</span>
          </div>
          <div
            className={`tab-item ${currentFilter === 'local' ? 'active' : ''}`}
            onClick={() => setCurrentFilter('local')}
          >
            {t('skills.local')} <span className="count-badge">{localCount}</span>
          </div>
          {/* Enabled status filter */}
          <div className="filter-separator"></div>
          <div
            className={`tab-item enabled-filter ${enabledFilter === 'enabled' ? 'active' : ''}`}
            onClick={() => setEnabledFilter(enabledFilter === 'enabled' ? 'all' : 'enabled')}
            title={t('skills.filterEnabled')}
          >
            <span className="codicon codicon-check"></span>
            {t('skills.enabled')} <span className="count-badge">{enabledCount}</span>
          </div>
          <div
            className={`tab-item enabled-filter ${enabledFilter === 'disabled' ? 'active' : ''}`}
            onClick={() => setEnabledFilter(enabledFilter === 'disabled' ? 'all' : 'disabled')}
            title={t('skills.filterDisabled')}
          >
            <span className="codicon codicon-circle-slash"></span>
            {t('skills.disabled')} <span className="count-badge">{disabledCount}</span>
          </div>
        </div>

        {/* Right-side tools */}
        <div className="toolbar-right">
          {/* Search box */}
          <div className="search-box">
            <span className="codicon codicon-search"></span>
            <input
              type="text"
              className="search-input"
              placeholder={t('skills.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Help button */}
          <button
            className="icon-btn"
            onClick={() => setShowHelpDialog(true)}
            title={t('skills.whatIsSkills')}
          >
            <span className="codicon codicon-question"></span>
          </button>

          {/* Import button */}
          <div className="add-dropdown" ref={dropdownRef}>
            <button
              className="icon-btn primary"
              onClick={() => setShowDropdown(!showDropdown)}
              title={t('skills.importSkill')}
            >
              <span className="codicon codicon-add"></span>
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={() => handleImport('global')}>
                  <span className="codicon codicon-globe"></span>
                  {t('skills.importGlobalSkill')}
                </div>
                <div className="dropdown-item" onClick={() => handleImport('local')}>
                  <span className="codicon codicon-desktop-download"></span>
                  {t('skills.importLocalSkill')}
                </div>
              </div>
            )}
          </div>

          {/* Refresh button */}
          <button
            className="icon-btn"
            onClick={handleRefresh}
            disabled={loading}
            title={t('chat.refresh')}
          >
            <span className={`codicon codicon-refresh ${loading ? 'spinning' : ''}`}></span>
          </button>
        </div>
      </div>

      {/* Skills list */}
      <div className="skill-list">
        {filteredSkills.map((skill) => (
          <div
            key={skill.id}
            className={`skill-card ${expandedSkills.has(skill.id) ? 'expanded' : ''} ${!skill.enabled ? 'disabled' : ''}`}
          >
            {/* Card header */}
            <div className="card-header" onClick={() => toggleExpand(skill.id)}>
              {/* Enable/disable toggle */}
              <button
                className={`toggle-switch ${skill.enabled ? 'enabled' : 'disabled'} ${togglingSkills.has(skill.id) ? 'loading' : ''}`}
                onClick={(e) => handleToggle(skill, e)}
                disabled={togglingSkills.has(skill.id)}
                title={skill.enabled ? t('chat.clickToDisable') : t('chat.clickToEnable')}
              >
                {togglingSkills.has(skill.id) ? (
                  <span className="codicon codicon-loading codicon-modifier-spin"></span>
                ) : skill.enabled ? (
                  <span className="codicon codicon-check"></span>
                ) : (
                  <span className="codicon codicon-circle-slash"></span>
                )}
              </button>

              <div className="skill-icon-wrapper" style={{ color: skill.enabled ? getIconColor(skill.id) : 'var(--text-tertiary)' }}>
                <span className="codicon codicon-folder"></span>
              </div>

              <div className="skill-info">
                <div className="skill-header-row">
                  <span className={`skill-name ${!skill.enabled ? 'muted' : ''}`}>{skill.name}</span>
                  <span className={`scope-badge ${skill.scope}`}>
                    <span className={`codicon ${skill.scope === 'global' ? 'codicon-globe' : 'codicon-desktop-download'}`}></span>
                    {skill.scope === 'global' ? t('chat.global') : t('chat.localProject')}
                  </span>
                  {!skill.enabled && (
                    <span className="status-badge disabled">
                      {t('chat.disabled')}
                    </span>
                  )}
                </div>
                <div className="skill-path" title={skill.path}>{skill.path}</div>
              </div>

              <div className="expand-indicator">
                <span className={`codicon ${expandedSkills.has(skill.id) ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
              </div>
            </div>

            {/* Expanded content */}
            {expandedSkills.has(skill.id) && (
              <div className="card-content">
                <div className="info-section">
                  {skill.description ? (
                    <div className="description-container">
                      <div className="description-label">{t('skills.description')}:</div>
                      <div className="description-content">{skill.description}</div>
                    </div>
                  ) : (
                    <div className="description-placeholder">{t('skills.noDescription')}</div>
                  )}
                </div>

                <div className="actions-section">
                  <button className="action-btn edit-btn" onClick={() => handleOpen(skill)}>
                    <span className="codicon codicon-edit"></span> {t('common.edit')}
                  </button>
                  <button className="action-btn delete-btn" onClick={() => handleDelete(skill)}>
                    <span className="codicon codicon-trash"></span> {t('common.delete')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Empty state */}
        {filteredSkills.length === 0 && !loading && (
          <div className="empty-state">
            <span className="codicon codicon-extensions"></span>
            <p>{t('skills.noMatchingSkills')}</p>
            <p className="hint">{t('skills.importHint')}</p>
          </div>
        )}

        {/* Loading state */}
        {loading && filteredSkills.length === 0 && (
          <div className="loading-state">
            <span className="codicon codicon-loading codicon-modifier-spin"></span>
            <p>{t('common.loading')}</p>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {showHelpDialog && (
        <SkillHelpDialog onClose={() => setShowHelpDialog(false)} />
      )}

      {showConfirmDialog && deletingSkill && (
        <SkillConfirmDialog
          title={t('skills.deleteTitle')}
          message={t('skills.deleteMessage', { scope: deletingSkill.scope === 'global' ? t('skills.deleteMessageGlobal') : t('skills.deleteMessageLocal'), name: deletingSkill.name })}
          confirmText="删除"
          cancelText="取消"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
