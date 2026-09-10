import { useTranslation } from 'react-i18next';
import type { ContextUsageData } from './ContextUsageDialog';
import { formatTokens } from './contextUsageUtils';

interface DetailsTableProps<T> {
  summary: string;
  headers: readonly [string, string, string];
  rows: readonly T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => readonly [React.ReactNode, React.ReactNode, React.ReactNode];
}

function DetailsTable<T>({ summary, headers, rows, rowKey, renderRow }: DetailsTableProps<T>) {
  return (
    <details className="context-usage-detail-section">
      <summary>{summary}</summary>
      <table className="context-usage-table">
        <thead>
          <tr>
            <th>{headers[0]}</th>
            <th>{headers[1]}</th>
            <th>{headers[2]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = renderRow(row);
            return (
              <tr key={rowKey(row)}>
                <td>{cells[0]}</td>
                <td>{cells[1]}</td>
                <td>{cells[2]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

interface ContextUsageDetailsProps {
  memoryFiles: ContextUsageData['memoryFiles'];
  mcpTools: ContextUsageData['mcpTools'];
  agents: ContextUsageData['agents'];
  skills?: ContextUsageData['skills'];
}

export function ContextUsageDetails({
  memoryFiles,
  mcpTools,
  agents,
  skills,
}: ContextUsageDetailsProps) {
  const { t } = useTranslation();

  return (
    <div className="context-usage-details">
      {mcpTools.length > 0 && (
        <DetailsTable
          summary={t('contextUsage.sections.mcpTools', { count: mcpTools.length, defaultValue: 'MCP Tools ({{count}})' })}
          headers={[
            t('contextUsage.table.tool', { defaultValue: 'Tool' }),
            t('contextUsage.table.server', { defaultValue: 'Server' }),
            t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
          ]}
          rows={mcpTools}
          rowKey={(tool) => `${tool.serverName}-${tool.name}`}
          renderRow={(tool) => [tool.name, tool.serverName, formatTokens(tool.tokens)]}
        />
      )}

      {agents.length > 0 && (
        <DetailsTable
          summary={t('contextUsage.sections.agents', { count: agents.length, defaultValue: 'Agents ({{count}})' })}
          headers={[
            t('contextUsage.table.agent', { defaultValue: 'Agent' }),
            t('contextUsage.table.source', { defaultValue: 'Source' }),
            t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
          ]}
          rows={agents}
          rowKey={(agent) => `${agent.source}-${agent.agentType}`}
          renderRow={(agent) => [agent.agentType, agent.source, formatTokens(agent.tokens)]}
        />
      )}

      {memoryFiles.length > 0 && (
        <DetailsTable
          summary={t('contextUsage.sections.memoryFiles', { count: memoryFiles.length, defaultValue: 'Memory Files ({{count}})' })}
          headers={[
            t('contextUsage.table.type', { defaultValue: 'Type' }),
            t('contextUsage.table.path', { defaultValue: 'Path' }),
            t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
          ]}
          rows={memoryFiles}
          rowKey={(file) => `${file.type}-${file.path}`}
          renderRow={(file) => {
            const shortPath = file.path.length > 60 ? '...' + file.path.slice(-57) : file.path;
            return [file.type, <span key="path" title={file.path}>{shortPath}</span>, formatTokens(file.tokens)];
          }}
        />
      )}

      {skills && skills.skillFrontmatter?.length > 0 && (
        <DetailsTable
          summary={t('contextUsage.sections.skills', {
            included: skills.includedSkills ?? 0,
            total: skills.totalSkills ?? 0,
            defaultValue: 'Skills ({{included}}/{{total}})',
          })}
          headers={[
            t('contextUsage.table.skill', { defaultValue: 'Skill' }),
            t('contextUsage.table.source', { defaultValue: 'Source' }),
            t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
          ]}
          rows={skills.skillFrontmatter}
          rowKey={(skill) => `${skill.source}-${skill.name}`}
          renderRow={(skill) => [skill.name, skill.source, formatTokens(skill.tokens)]}
        />
      )}
    </div>
  );
}
