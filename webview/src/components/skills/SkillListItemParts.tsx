import { useTranslation } from 'react-i18next';
import type { Skill } from '../../types/skill';

// Icon colors
const ICON_COLORS = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EF4444', '#EC4899', '#06B6D4', '#6366F1',
];

function getIconColor(skillId: string): string {
  let hash = 0;
  for (let i = 0; i < skillId.length; i++) {
    hash = skillId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

function getSkillIconStyle(skillId: string, enabled: boolean): React.CSSProperties {
  return { color: enabled ? getIconColor(skillId) : 'var(--text-tertiary)' };
}

/** Colored folder icon for a skill, tinted by id hash when enabled */
export function SkillIcon({ skill }: { skill: Skill }) {
  return (
    <div className="skill-icon-wrapper" style={getSkillIconStyle(skill.id, skill.enabled)}>
      <span className="codicon codicon-folder"></span>
    </div>
  );
}

interface SkillCardHeaderProps {
  skill: Skill;
  expanded: boolean;
  toggling: boolean;
  onToggleExpand: (skillId: string) => void;
  onToggle: (skill: Skill, e: React.MouseEvent) => void;
}

/** Card header row: enable toggle, icon, name, scope badge, expand indicator */
export function SkillCardHeader({
  skill,
  expanded,
  toggling,
  onToggleExpand,
  onToggle,
}: SkillCardHeaderProps) {
  const { t } = useTranslation();

  // Scope label mapping for readable badge text
  const scopeLabelMap: Record<string, string> = {
    user: t('skills.user'),
    repo: t('skills.repo'),
    global: t('chat.global'),
    local: t('chat.localProject'),
  };

  return (
    <div className="card-header" onClick={() => onToggleExpand(skill.id)}>
      {/* Enable/disable toggle */}
      <button
        className={`toggle-switch ${skill.enabled ? 'enabled' : 'disabled'} ${toggling ? 'loading' : ''}`}
        onClick={(e) => onToggle(skill, e)}
        disabled={toggling}
        title={skill.enabled ? t('chat.clickToDisable') : t('chat.clickToEnable')}
      >
        {toggling ? (
          <span className="codicon codicon-loading codicon-modifier-spin"></span>
        ) : skill.enabled ? (
          <span className="codicon codicon-check"></span>
        ) : (
          <span className="codicon codicon-circle-slash"></span>
        )}
      </button>

      <SkillIcon skill={skill} />

      <div className="skill-info">
        <div className="skill-header-row">
          <span className={`skill-name ${!skill.enabled ? 'muted' : ''}`}>{skill.name}</span>
          <span className={`scope-badge ${skill.scope}`}>
            <span className={`codicon ${(skill.scope === 'global' || skill.scope === 'user') ? 'codicon-globe' : 'codicon-desktop-download'}`}></span>
            {scopeLabelMap[skill.scope] || skill.scope}
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
        <span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
      </div>
    </div>
  );
}

interface SkillExpandedContentProps {
  skill: Skill;
  onOpen: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}

/** Expanded detail panel: description section and edit/delete actions */
export function SkillExpandedContent({ skill, onOpen, onDelete }: SkillExpandedContentProps) {
  const { t } = useTranslation();

  return (
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
        <button className="action-btn edit-btn" onClick={() => onOpen(skill)}>
          <span className="codicon codicon-edit"></span> {t('common.edit')}
        </button>
        <button className="action-btn delete-btn" onClick={() => onDelete(skill)}>
          <span className="codicon codicon-trash"></span> {t('common.delete')}
        </button>
      </div>
    </div>
  );
}
