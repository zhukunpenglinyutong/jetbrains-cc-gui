import Button from 'antd/es/button';
import Select from 'antd/es/select';
import { useTranslation } from 'react-i18next';

interface OfficeZoomControlProps { zoom: number; onChange: (zoom: number) => void; compact?: boolean }
const ZOOM_OPTIONS = [75, 90, 100, 110, 125, 150].map(value => ({ value, label: `${value}%` }));

export function OfficeZoomControl({ zoom, onChange, compact }: OfficeZoomControlProps) {
  const { t } = useTranslation('petOffice');
  return <div className="office-zoom-control" role="group" aria-label={t('sceneZoom')}>
    {!compact ? <span>{t('sceneZoom')}</span> : null}
    <Select<number> size={compact ? 'small' : undefined} virtual={false} listHeight={240} popupMatchSelectWidth={120}
      aria-label={t('sceneZoom')} value={zoom} options={ZOOM_OPTIONS} onChange={onChange} />
    <Button size={compact ? 'small' : undefined} aria-label={t('fitScene')} title={t('fitScene')} disabled={zoom === 100} onClick={() => onChange(100)}>{compact ? <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" /><rect x="6.5" y="6.5" width="7" height="7" rx="1" /></svg> : t('fitScene')}</Button>
  </div>;
}
