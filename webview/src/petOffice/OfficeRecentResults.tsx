import { useTranslation } from 'react-i18next';
import type { LiveSource, RecentOfficeResult } from './officeLiveModel';

export function OfficeRecentResults({ results, sources, product, search, stale, pending, onOpen }: {
  results: readonly RecentOfficeResult[]; sources: readonly LiveSource[]; product: string; search: string; stale: boolean; pending: boolean;
  onOpen: (source: LiveSource) => void;
}) {
  const { t, i18n } = useTranslation('petOffice');
  const query = search.trim().toLocaleLowerCase();
  const filtered = results.filter(result => (product === 'all' || result.product === product)
    && (!query || `${result.product} ${result.projectLabel} ${result.tabLabel} ${result.provider}`.toLocaleLowerCase().includes(query)))
    .slice().sort((a, b) => b.completedAt - a.completedAt);
  const formatter = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' });
  return <section className="office-recent" aria-label={t('recentResults')}>
    <div className="office-list-heading"><h3>{t('recentResults')}</h3><span>{filtered.length}</span></div>
    <p className="office-session-hint">{t('recentHint')}</p>
    <div className="office-recent-list" role="list" aria-label={t('recentResults')}>
      {filtered.length ? filtered.map(result => {
        // A result is informational. Only the currently admitted source supplies navigation authority.
        const source = sources.find(source => source.sourceKey === result.sourceKey && source.routeStatus === 'AVAILABLE');
        const time = new Date(result.completedAt);
        return <div role="listitem" className={`office-result is-${result.outcome.toLowerCase()}`} key={result.terminalEventId}>
          <div><strong>{result.projectLabel} / {result.tabLabel}</strong><span className="office-result-outcome">{t(`phase.${result.outcome}`)}</span></div>
          <span className="office-session-meta">{result.product} · {result.provider} · {result.modelLabel || '—'}<time dateTime={Number.isFinite(time.getTime()) ? time.toISOString() : undefined}>{Number.isFinite(time.getTime()) ? formatter.format(time) : '—'}</time></span>
          {source ? <button className="office-result-link" disabled={stale || pending} onClick={() => onOpen(source)}>{t('openResultTab')}</button> : <small>{t('resultUnavailable')}</small>}
        </div>;
      }) : <p className="office-recent-empty">{t('noRecentResults')}</p>}
    </div>
  </section>;
}
