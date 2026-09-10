import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SubagentProcessEmptyCardProps {
  canLoad: boolean;
}

const SubagentProcessEmptyCard = memo(function SubagentProcessEmptyCard({
  canLoad,
}: SubagentProcessEmptyCardProps) {
  const { t } = useTranslation();
  return (
    <div className="subagent-loading-card">
      <span className="codicon codicon-loading" />
      {canLoad ? t('subagent.process.loading') : t('subagent.process.unavailable')}
    </div>
  );
});

export default SubagentProcessEmptyCard;
