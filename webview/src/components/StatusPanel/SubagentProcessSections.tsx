import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentProcessModel } from './subagentProcess';

function PromptSection({ prompt }: { prompt?: string }) {
  const { t } = useTranslation();
  if (!prompt) return null;
  return (
    <section className="subagent-process-section">
      <div className="subagent-section-heading">
        <span className="codicon codicon-comment" />
        {t('subagent.process.prompt')}
      </div>
      <div className="subagent-prompt-card">{prompt}</div>
    </section>
  );
}

function ThoughtSection({ note }: { note?: string }) {
  const { t } = useTranslation();
  if (!note) return null;
  return (
    <section className="subagent-process-section">
      <div className="subagent-section-heading">
        <span className="codicon codicon-comment-discussion" />
        {t('subagent.process.thought')}
      </div>
      <div className="subagent-note-card">{note}</div>
    </section>
  );
}

function ReadFilesSection({ files }: { files: string[] }) {
  const { t } = useTranslation();
  if (files.length === 0) return null;
  return (
    <section className="subagent-process-section">
      <div className="subagent-section-heading">
        <span className="codicon codicon-files" />
        {t('subagent.process.filesRead', { count: files.length })}
      </div>
      <div className="subagent-file-grid">
        {files.map((file) => (
          <div key={file} className="subagent-file-chip" title={file}>
            <span className="codicon codicon-file-code" />
            <span>{file}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ToolCallsSection({ toolCalls }: { toolCalls: SubagentProcessModel['toolCalls'] }) {
  const { t } = useTranslation();
  if (toolCalls.length === 0) return null;
  return (
    <section className="subagent-process-section">
      <div className="subagent-section-heading">
        <span className="codicon codicon-tools" />
        {t('subagent.process.otherTools')}
      </div>
      <div className="subagent-tool-list">
        {toolCalls.map((tool) => (
          <div key={tool.id} className="subagent-tool-chip">
            <span>{tool.name}</span>
            {tool.detail && <small>{tool.detail}</small>}
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultSection({ finalSummary, resultText }: { finalSummary?: string; resultText?: string }) {
  const { t } = useTranslation();
  if (!finalSummary) return null;
  return (
    <section className="subagent-process-section">
      <div className="subagent-section-heading">
        <span className="codicon codicon-pass-filled" />
        {t('subagent.process.result')}
      </div>
      <div className="subagent-result-card">{finalSummary}</div>
      <details className="subagent-result">
        <summary>{t('subagent.process.showFullOutput')}</summary>
        <pre>{resultText}</pre>
      </details>
    </section>
  );
}

interface SubagentProcessSectionsProps {
  prompt?: string;
  process: SubagentProcessModel;
  finalSummary?: string;
  resultText?: string;
}

const SubagentProcessSections = memo(function SubagentProcessSections({
  prompt,
  process,
  finalSummary,
  resultText,
}: SubagentProcessSectionsProps) {
  return (
    <div className="subagent-process-sections">
      <PromptSection prompt={prompt} />
      <ThoughtSection note={process.notes[0]} />
      <ReadFilesSection files={process.readFiles} />
      <ToolCallsSection toolCalls={process.toolCalls} />
      <ResultSection finalSummary={finalSummary} resultText={resultText} />
    </div>
  );
});

export default SubagentProcessSections;
