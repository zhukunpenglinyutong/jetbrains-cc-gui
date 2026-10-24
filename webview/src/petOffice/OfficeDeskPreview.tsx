import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSource } from './officeLiveModel';
import type { OfficeDeskHover } from './useOfficeDeskHover';
import { phaseColor } from './officeModel';

interface OfficeDeskPreviewProps { source: LiveSource; anchor: OfficeDeskHover }

/** Read-only desk metadata; selection and navigation remain explicit actions. */
export function OfficeDeskPreview({ source, anchor }: OfficeDeskPreviewProps) {
  const { t } = useTranslation('petOffice');
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current; if (!node) return;
    const bounds = node.getBoundingClientRect();
    const left = Math.max(10, Math.min(anchor.x + 16, window.innerWidth - bounds.width - 10));
    const top = anchor.y + 16 + bounds.height <= window.innerHeight - 10 ? anchor.y + 16 : Math.max(10, anchor.y - bounds.height - 16);
    node.style.left = `${left}px`; node.style.top = `${top}px`;
  }, [anchor.x, anchor.y, source]);
  return <div ref={element} className="office-desk-preview" role="tooltip" aria-label={t('deskPreview')}>
    <strong>{source.projectLabel} / {source.tabLabel}</strong>
    <span>{source.product} · {source.provider} · {source.modelLabel || '—'}</span>
    <span className="office-session-phase"><i style={{ background: phaseColor(source.phase) }} />{t(`phase.${source.phase}`)}</span>
    {source.phase === 'WAITING_USER' ? <span>{t(`waitReason.${source.waitReason}`)} · {source.pendingInteractionCount}</span> : null}
    {source.routeStatus !== 'AVAILABLE' ? <small>{t(`route.${source.routeStatus}`)}</small> : null}
    <small>{t('deskPreviewHint')}</small>
  </div>;
}
