import type { Skill } from '../../types/skill';
import { SkillCardHeader, SkillExpandedContent } from './SkillListItemParts';

interface SkillListItemProps {
  skill: Skill;
  expanded: boolean;
  toggling: boolean;
  onToggleExpand: (skillId: string) => void;
  onToggle: (skill: Skill, e: React.MouseEvent) => void;
  onOpen: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}

/**
 * Single skill card: header row (toggle, icon, name, scope badge)
 * and expandable detail panel with description and actions
 */
export function SkillListItem({
  skill,
  expanded,
  toggling,
  onToggleExpand,
  onToggle,
  onOpen,
  onDelete,
}: SkillListItemProps) {
  return (
    <div
      className={`skill-card ${expanded ? 'expanded' : ''} ${!skill.enabled ? 'disabled' : ''}`}
    >
      <SkillCardHeader
        skill={skill}
        expanded={expanded}
        toggling={toggling}
        onToggleExpand={onToggleExpand}
        onToggle={onToggle}
      />

      {expanded && (
        <SkillExpandedContent skill={skill} onOpen={onOpen} onDelete={onDelete} />
      )}
    </div>
  );
}
