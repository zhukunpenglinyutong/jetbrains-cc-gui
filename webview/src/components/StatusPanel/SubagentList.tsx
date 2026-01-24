import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentInfo } from '../../types';
import { subagentStatusIconMap } from './types';

interface SubagentListProps {
  subagents: SubagentInfo[];
}

const SubagentList = memo(({ subagents }: SubagentListProps) => {
  const { t } = useTranslation();

  if (subagents.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noSubagents')}</div>;
  }

  return (
    <div className="subagent-list">
      {subagents.map((subagent, index) => {
        const statusIcon = subagentStatusIconMap[subagent.status] ?? 'codicon-circle-outline';
        const statusClass = `status-${subagent.status}`;

        return (
          <div key={subagent.id ?? index} className={`subagent-item ${statusClass}`}>
            {/* Status icon */}
            <span className={`subagent-status-icon ${statusClass}`}>
              <span className={`codicon ${statusIcon}`} />
            </span>

            {/* Type badge */}
            <span className="subagent-type">{t('statusPanel.subagentTab')}</span>

            {/* Description */}
            <span className="subagent-description" title={subagent.prompt}>
              {subagent.description || subagent.prompt?.slice(0, 50)}
            </span>
          </div>
        );
      })}
    </div>
  );
});

SubagentList.displayName = 'SubagentList';

export default SubagentList;
