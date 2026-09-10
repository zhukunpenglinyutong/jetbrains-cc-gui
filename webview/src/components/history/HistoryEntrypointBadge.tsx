import type { TFunction } from 'i18next';

export interface HistoryEntrypointBadgeProps {
  entrypoint: string;
  t: TFunction;
}

export const HistoryEntrypointBadge = ({ entrypoint, t }: HistoryEntrypointBadgeProps) => (
  <>
    <span className="history-meta-dot">•</span>
    <span
      className={`history-entrypoint-badge history-entrypoint-${entrypoint}`}
      title={t(`history.entrypointTooltip.${entrypoint}`, { defaultValue: entrypoint })}
    >
      <span className={`codicon ${
        entrypoint === 'sdk-cli' ? 'codicon-symbol-namespace' :
        entrypoint === 'claude-vscode' ? 'codicon-extensions' :
        'codicon-debug-alt'
      }`}></span>
      {t(`history.entrypointLabel.${entrypoint}`, { defaultValue: entrypoint })}
    </span>
  </>
);
