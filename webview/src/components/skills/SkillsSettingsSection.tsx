import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Skill, SkillsConfig, SkillScope, SkillFilter, SkillEnabledFilter } from '../../types/skill';
import { sendToJava } from '../../utils/bridge';
import { SkillHelpDialog } from './SkillHelpDialog';
import { SkillConfirmDialog } from './SkillConfirmDialog';
import { ToastContainer, type ToastMessage } from '../Toast';

/**
 * Skills 设置组件
 * 管理 Claude 的 Skills（全局和本地）
 * 支持启用/停用 Skills（通过在使用中目录和管理目录之间移动文件）
 */
export function SkillsSettingsSection() {
  const { t } = useTranslation();
  // Skills 数据
  const [skills, setSkills] = useState<SkillsConfig>({ global: {}, local: {} });
  const [loading, setLoading] = useState(true);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  // UI 状态
  const [showDropdown, setShowDropdown] = useState(false);
  const [currentFilter, setCurrentFilter] = useState<SkillFilter>('all');
  const [enabledFilter, setEnabledFilter] = useState<SkillEnabledFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 弹窗状态
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [deletingSkill, setDeletingSkill] = useState<Skill | null>(null);

  // 操作中的 Skills（用于禁用按钮防止重复点击）
  const [togglingSkills, setTogglingSkills] = useState<Set<string>>(new Set());

  // Toast 状态
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Toast 辅助函数
  const addToast = (message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  // 计算 Skills 列表
  const globalSkillList = useMemo(() => Object.values(skills.global), [skills.global]);
  const localSkillList = useMemo(() => Object.values(skills.local), [skills.local]);
  const allSkillList = useMemo(() => [...globalSkillList, ...localSkillList], [globalSkillList, localSkillList]);

  // 过滤后的 Skills 列表
  const filteredSkills = useMemo(() => {
    let list: Skill[] = [];
    if (currentFilter === 'all') {
      list = allSkillList;
    } else if (currentFilter === 'global') {
      list = globalSkillList;
    } else {
      list = localSkillList;
    }

    // 启用状态筛选
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

    // 按启用状态排序：启用的在前
    return list.sort((a, b) => {
      if (a.enabled === b.enabled) return 0;
      return a.enabled ? -1 : 1;
    });
  }, [currentFilter, enabledFilter, searchQuery, allSkillList, globalSkillList, localSkillList]);

  // 计数
  const totalCount = allSkillList.length;
  const globalCount = globalSkillList.length;
  const localCount = localSkillList.length;
  const enabledCount = allSkillList.filter(s => s.enabled).length;
  const disabledCount = allSkillList.filter(s => !s.enabled).length;

  // 图标颜色
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

  // 初始化
  useEffect(() => {
    // 注册回调：Java 端返回 Skills 列表
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

    // 注册回调：导入结果
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
          // 重新加载
          loadSkills();
        } else {
          addToast(result.error || t('skills.importFailed'), 'error');
        }
      } catch (error) {
        console.error('[SkillsSettings] Failed to parse import result:', error);
      }
    };

    // 注册回调：删除结果
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

    // 注册回调：启用/停用结果
    window.skillToggleResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        // 移除操作中状态
        setTogglingSkills(prev => {
          const newSet = new Set(prev);
          if (result.name) {
            // 尝试移除可能的 ID 变体
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
        setTogglingSkills(new Set()); // 出错时清空
      }
    };

    // 加载 Skills
    loadSkills();

    // 点击外部关闭下拉菜单
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

  // 切换展开状态（手风琴效果）
  const toggleExpand = (skillId: string) => {
    const newExpanded = new Set<string>();
    if (!expandedSkills.has(skillId)) {
      newExpanded.add(skillId);
    }
    setExpandedSkills(newExpanded);
  };

  // 刷新
  const handleRefresh = () => {
    loadSkills();
    addToast('已刷新 Skills 列表', 'success');
  };

  // 导入 Skill
  const handleImport = (scope: SkillScope) => {
    setShowDropdown(false);
    // 发送导入请求，Java 端会显示文件选择对话框
    sendToJava('import_skill', { scope });
  };

  // 在编辑器中打开
  const handleOpen = (skill: Skill) => {
    sendToJava('open_skill', { path: skill.path });
  };

  // 删除 Skill
  const handleDelete = (skill: Skill) => {
    setDeletingSkill(skill);
    setShowConfirmDialog(true);
  };

  // 确认删除
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

  // 取消删除
  const cancelDelete = () => {
    setShowConfirmDialog(false);
    setDeletingSkill(null);
  };

  // 启用/停用 Skill
  const handleToggle = (skill: Skill, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止触发卡片展开
    if (togglingSkills.has(skill.id)) return; // 防止重复点击

    setTogglingSkills(prev => new Set(prev).add(skill.id));
    sendToJava('toggle_skill', {
      name: skill.name,
      scope: skill.scope,
      enabled: skill.enabled
    });
  };

  return (
    <div className="skills-settings-section">
      {/* 工具栏 */}
      <div className="skills-toolbar">
        {/* 筛选标签 */}
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
          {/* 启用状态筛选 */}
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

        {/* 右侧工具 */}
        <div className="toolbar-right">
          {/* 搜索框 */}
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

          {/* 帮助按钮 */}
          <button
            className="icon-btn"
            onClick={() => setShowHelpDialog(true)}
            title={t('skills.whatIsSkills')}
          >
            <span className="codicon codicon-question"></span>
          </button>

          {/* 导入按钮 */}
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
                  导入到全局
                </div>
                <div className="dropdown-item" onClick={() => handleImport('local')}>
                  <span className="codicon codicon-desktop-download"></span>
                  导入到本项目
                </div>
              </div>
            )}
          </div>

          {/* 刷新按钮 */}
          <button
            className="icon-btn"
            onClick={handleRefresh}
            disabled={loading}
            title="刷新"
          >
            <span className={`codicon codicon-refresh ${loading ? 'spinning' : ''}`}></span>
          </button>
        </div>
      </div>

      {/* Skills 列表 */}
      <div className="skill-list">
        {filteredSkills.map((skill) => (
          <div
            key={skill.id}
            className={`skill-card ${expandedSkills.has(skill.id) ? 'expanded' : ''} ${!skill.enabled ? 'disabled' : ''}`}
          >
            {/* 卡片头部 */}
            <div className="card-header" onClick={() => toggleExpand(skill.id)}>
              {/* 启用/停用开关 */}
              <button
                className={`toggle-switch ${skill.enabled ? 'enabled' : 'disabled'} ${togglingSkills.has(skill.id) ? 'loading' : ''}`}
                onClick={(e) => handleToggle(skill, e)}
                disabled={togglingSkills.has(skill.id)}
                title={skill.enabled ? '点击停用' : '点击启用'}
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
                    {skill.scope === 'global' ? '全局' : '本项目'}
                  </span>
                  {!skill.enabled && (
                    <span className="status-badge disabled">
                      已停用
                    </span>
                  )}
                </div>
                <div className="skill-path" title={skill.path}>{skill.path}</div>
              </div>

              <div className="expand-indicator">
                <span className={`codicon ${expandedSkills.has(skill.id) ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
              </div>
            </div>

            {/* 展开内容 */}
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

        {/* 空状态 */}
        {filteredSkills.length === 0 && !loading && (
          <div className="empty-state">
            <span className="codicon codicon-extensions"></span>
            <p>未找到匹配的 Skills</p>
            <p className="hint">{t('skills.importHint')}</p>
          </div>
        )}

        {/* 加载状态 */}
        {loading && filteredSkills.length === 0 && (
          <div className="loading-state">
            <span className="codicon codicon-loading codicon-modifier-spin"></span>
            <p>{t('common.loading')}</p>
          </div>
        )}
      </div>

      {/* 弹窗 */}
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

      {/* Toast 通知 */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
