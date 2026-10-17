import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SubagentProcessHeaderProps {
  agentId?: string;
  agentPath?: string;
  stats: string;
}

const SubagentProcessHeader = memo(function SubagentProcessHeader({
  agentId,
  agentPath,
  stats,
}: SubagentProcessHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="subagent-process-header">
      <div>
        <div className="subagent-process-title">{t('subagent.process.title')}</div>
        {agentId && <div className="subagent-process-subtitle">{agentId}</div>}
        {agentPath && <div className="subagent-process-subtitle">{agentPath}</div>}
      </div>
      {stats && <div className="subagent-process-stats">{stats}</div>}
    </div>
  );
});

export default SubagentProcessHeader;
