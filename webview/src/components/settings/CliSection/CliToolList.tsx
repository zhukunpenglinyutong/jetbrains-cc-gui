import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import CliToolCard from './CliToolCard';
import DshConnectionCard from './DshConnectionCard';
import GeminiIdleReapCard from './GeminiIdleReapCard';
import {
  CLI_TOOL_DEFINITIONS,
  type CliStatusMap,
  type CliToolDefinition,
  type CliToolId,
} from '../../../types/cliTool';
import styles from './style.module.less';

interface CliToolListProps {
  loading: boolean;
  statusError: boolean;
  statusMap: CliStatusMap;
  onRefresh: () => void;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
  hiddenProviders: ReadonlySet<string>;
  onToggleSwitcherVisibility: (id: CliToolId, hidden: boolean) => void;
}

interface DshGroupProps {
  tool: CliToolDefinition;
  statusMap: CliStatusMap;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
  hiddenProviders: ReadonlySet<string>;
  onToggleSwitcherVisibility: (id: CliToolId, hidden: boolean) => void;
}

const DshGroup = ({
  tool,
  statusMap,
  onOpenInstall,
  onOpenDocs,
  hiddenProviders,
  onToggleSwitcherVisibility,
}: DshGroupProps) => {
  const { t } = useTranslation();
  const dshInstalled = statusMap.dsh?.installed === true;

  return (
    <div
      className={`${styles.dshGroup} ${dshInstalled ? styles.installed : ''}`}
      data-testid="dsh-group"
      role="group"
      aria-labelledby="dsh-group-title"
    >
      <div className={styles.dshGroupHeader}>
        <div className={styles.cliIcon}>
          <ProviderModelIcon providerId={tool.id} size={16} colored />
        </div>
        <span
          id="dsh-group-title"
          className={styles.dshGroupTitle}
          title={t('settings.cli.dsh.groupTitle')}
        >
          {t('settings.cli.dsh.groupTitle')}
        </span>
      </div>
      <CliToolCard
        tool={tool}
        status={statusMap[tool.id]}
        onOpenInstall={onOpenInstall}
        onOpenDocs={onOpenDocs}
        switcherHidden={hiddenProviders.has(tool.id)}
        onToggleSwitcherVisibility={onToggleSwitcherVisibility}
        nested
        displayName={t('settings.cli.dsh.cliRowTitle')}
      />
      {dshInstalled && <DshConnectionCard nested />}
    </div>
  );
};

const CliToolList = ({
  loading,
  statusError,
  statusMap,
  onRefresh,
  onOpenInstall,
  onOpenDocs,
  hiddenProviders,
  onToggleSwitcherVisibility,
}: CliToolListProps) => {
  const { t } = useTranslation();

  if (loading && Object.keys(statusMap).length === 0) {
    return (
      <div className={styles.cliList}>
        <div className={styles.loadingState}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('settings.cli.loading')}</span>
        </div>
      </div>
    );
  }

  if (statusError && Object.keys(statusMap).length === 0) {
    return (
      <div className={styles.cliList}>
        <div className={styles.errorState}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.cli.loadFailed')}</span>
          <button type="button" className={styles.refreshBtn} onClick={onRefresh}>
            <span className="codicon codicon-refresh" />
            {t('settings.cli.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cliList}>
      {CLI_TOOL_DEFINITIONS.map((tool) => {
        if (tool.id === 'gemini') {
          // Gemini carries the only provider-settings field in this list:
          // the idle-reap window card, shown once the CLI is installed.
          const geminiInstalled = statusMap.gemini?.installed === true;
          return (
            <div key={tool.id}>
              <CliToolCard
                tool={tool}
                status={statusMap[tool.id]}
                onOpenInstall={onOpenInstall}
                onOpenDocs={onOpenDocs}
                switcherHidden={hiddenProviders.has(tool.id)}
                onToggleSwitcherVisibility={onToggleSwitcherVisibility}
              />
              {geminiInstalled && <GeminiIdleReapCard />}
            </div>
          );
        }
        if (tool.id === 'dsh') {
          return (
            <DshGroup
              key={tool.id}
              tool={tool}
              statusMap={statusMap}
              onOpenInstall={onOpenInstall}
              onOpenDocs={onOpenDocs}
              hiddenProviders={hiddenProviders}
              onToggleSwitcherVisibility={onToggleSwitcherVisibility}
            />
          );
        }
        return (
          <CliToolCard
            key={tool.id}
            tool={tool}
            status={statusMap[tool.id]}
            onOpenInstall={onOpenInstall}
            onOpenDocs={onOpenDocs}
            switcherHidden={hiddenProviders.has(tool.id)}
            onToggleSwitcherVisibility={onToggleSwitcherVisibility}
          />
        );
      })}
    </div>
  );
};

export default CliToolList;
