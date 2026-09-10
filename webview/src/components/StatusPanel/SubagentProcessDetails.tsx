import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse } from '../../types';
import { buildSubagentProcessModel, formatSubagentDuration } from './subagentProcess';
import SubagentProcessHeader from './SubagentProcessHeader';
import SubagentProcessError from './SubagentProcessError';
import SubagentProcessSections from './SubagentProcessSections';
import SubagentProcessEmptyCard from './SubagentProcessEmptyCard';

interface SubagentProcessDetailsProps {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  resultText?: string;
  /** The original prompt the user sent the agent off with (tool_use input.prompt). */
  prompt?: string;
  history?: SubagentHistoryResponse;
  canLoad: boolean;
}

function firstMeaningfulLine(text: string | undefined, t: TFunction): string | undefined {
  if (!text) return undefined;
  const codeFence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (codeFence) return t('subagent.process.reportGenerated');
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 180);
}

const SubagentProcessDetails = memo(function SubagentProcessDetails({
  agentId,
  totalDurationMs,
  totalTokens,
  totalToolUseCount,
  resultText,
  prompt,
  history,
  canLoad,
}: SubagentProcessDetailsProps) {
  const { t } = useTranslation();
  const duration = formatSubagentDuration(totalDurationMs, {
    ms: t('subagent.process.unitMs'),
    s: t('subagent.process.unitS'),
  });
  const stats = [
    duration,
    totalToolUseCount != null ? `${totalToolUseCount} ${t('subagent.process.unitTools')}` : null,
    totalTokens != null ? `${totalTokens.toLocaleString()} ${t('subagent.process.unitTokens')}` : null,
  ].filter(Boolean).join(' · ');
  const process = buildSubagentProcessModel(history);
  const finalSummary = firstMeaningfulLine(resultText, t);
  const hasPrompt = Boolean(prompt && prompt.trim());
  const hasContent = hasPrompt || process.notes.length > 0 || process.readFiles.length > 0 || process.toolCalls.length > 0 || Boolean(finalSummary);

  return (
    <div className="subagent-details subagent-process-card">
      <SubagentProcessHeader agentId={agentId} stats={stats} />
      <SubagentProcessError history={history} />
      {hasContent ? (
        <SubagentProcessSections
          prompt={hasPrompt ? prompt : undefined}
          process={process}
          finalSummary={finalSummary}
          resultText={resultText}
        />
      ) : (
        <SubagentProcessEmptyCard canLoad={canLoad} />
      )}
    </div>
  );
});

export default SubagentProcessDetails;
