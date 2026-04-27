import { memo } from 'react';
import type { SubagentHistoryResponse } from '../../types';
import { buildSubagentProcessModel, formatSubagentDuration } from './subagentProcess';

interface SubagentProcessDetailsProps {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  resultText?: string;
  history?: SubagentHistoryResponse;
  canLoad: boolean;
}

function firstMeaningfulLine(text?: string): string | undefined {
  if (!text) return undefined;
  const codeFence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (codeFence) return 'Structured analysis report generated';
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 180);
}

const SubagentProcessDetails = memo(function SubagentProcessDetails({
  agentId,
  totalDurationMs,
  totalTokens,
  totalToolUseCount,
  resultText,
  history,
  canLoad,
}: SubagentProcessDetailsProps) {
  const duration = formatSubagentDuration(totalDurationMs);
  const stats = [
    duration,
    totalToolUseCount != null ? `${totalToolUseCount} tools` : null,
    totalTokens != null ? `${totalTokens.toLocaleString()} tokens` : null,
  ].filter(Boolean).join(' · ');
  const process = buildSubagentProcessModel(history);
  const finalSummary = firstMeaningfulLine(resultText);
  const hasContent = process.notes.length > 0 || process.readFiles.length > 0 || process.toolCalls.length > 0 || Boolean(finalSummary);

  return (
    <div className="subagent-details subagent-process-card">
      <div className="subagent-process-header">
        <div>
          <div className="subagent-process-title">Agent process</div>
          {agentId && <div className="subagent-process-subtitle">{agentId}</div>}
        </div>
        {stats && <div className="subagent-process-stats">{stats}</div>}
      </div>

      {history?.error && <div className="subagent-error">{history.error}</div>}

      {hasContent ? (
        <div className="subagent-process-sections">
          {process.notes.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-comment-discussion" />
                Thought
              </div>
              <div className="subagent-note-card">{process.notes[0]}</div>
            </section>
          )}

          {process.readFiles.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-files" />
                Read {process.readFiles.length} file{process.readFiles.length > 1 ? 's' : ''}
              </div>
              <div className="subagent-file-grid">
                {process.readFiles.map((file) => (
                  <div key={file} className="subagent-file-chip" title={file}>
                    <span className="codicon codicon-file-code" />
                    <span>{file}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {process.toolCalls.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-tools" />
                Other tools
              </div>
              <div className="subagent-tool-list">
                {process.toolCalls.map((tool) => (
                  <div key={tool.id} className="subagent-tool-chip">
                    <span>{tool.name}</span>
                    {tool.detail && <small>{tool.detail}</small>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {finalSummary && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-pass-filled" />
                Result
              </div>
              <div className="subagent-result-card">{finalSummary}</div>
              <details className="subagent-result">
                <summary>Show full output</summary>
                <pre>{resultText}</pre>
              </details>
            </section>
          )}
        </div>
      ) : (
        <div className="subagent-loading-card">
          <span className="codicon codicon-loading" />
          {canLoad ? 'Loading Agent process…' : 'Process log is unavailable until this session has an id.'}
        </div>
      )}
    </div>
  );
});

export default SubagentProcessDetails;
