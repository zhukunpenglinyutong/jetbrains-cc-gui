import { useTranslation } from 'react-i18next';
import type { Skill } from '../../types/skill';
import { SkillListItem } from './SkillListItem';

interface SkillListProps {
  skills: Skill[];
  loading: boolean;
  expandedSkills: Set<string>;
  togglingSkills: Set<string>;
  onToggleExpand: (skillId: string) => void;
  onToggle: (skill: Skill, e: React.MouseEvent) => void;
  onOpen: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}

/**
 * Skills list: renders skill cards plus empty / loading states
 */
export function SkillList({
  skills,
  loading,
  expandedSkills,
  togglingSkills,
  onToggleExpand,
  onToggle,
  onOpen,
  onDelete,
}: SkillListProps) {
  const { t } = useTranslation();

  return (
    <div className="skill-list">
      {skills.map((skill) => (
        <SkillListItem
          key={skill.id}
          skill={skill}
          expanded={expandedSkills.has(skill.id)}
          toggling={togglingSkills.has(skill.id)}
          onToggleExpand={onToggleExpand}
          onToggle={onToggle}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}

      {/* Empty state */}
      {skills.length === 0 && !loading && (
        <div className="empty-state">
          <span className="codicon codicon-extensions"></span>
          <p>{t('skills.noMatchingSkills')}</p>
          <p className="hint">{t('skills.importHint')}</p>
        </div>
      )}

      {/* Loading state */}
      {loading && skills.length === 0 && (
        <div className="loading-state">
          <span className="codicon codicon-loading codicon-modifier-spin"></span>
          <p>{t('common.loading')}</p>
        </div>
      )}
    </div>
  );
}
