import { useTranslation } from 'react-i18next';
import {
  petBridge,
  type HatchPetStatus,
} from '../../codexPet/petBridge';
import type { HatchPetAction } from './types';
import styles from './style.module.less';

interface LocalPetTabProps {
  hatchStatus: HatchPetStatus | null;
  hatchName: string;
  setHatchName: (value: string) => void;
  hatchDescription: string;
  setHatchDescription: (value: string) => void;
  hatchStyle: string;
  setHatchStyle: (value: string) => void;
  hatchReference: string;
  prepareHatchCommand: (action: HatchPetAction) => void;
  refreshPetAssets: () => void;
}

export default function LocalPetTab({
  hatchStatus,
  hatchName,
  setHatchName,
  hatchDescription,
  setHatchDescription,
  hatchStyle,
  setHatchStyle,
  hatchReference,
  prepareHatchCommand,
  refreshPetAssets,
}: LocalPetTabProps) {
  const { t } = useTranslation();

  return (
    <section className={`${styles.controlSection} ${styles.hatchSection}`}>
      <div className={styles.hatchHeader}>
        <div>
          <h4>{t('settings.pet.hatchTitle')}</h4>
          <p>{t('settings.pet.hatchDescription')}</p>
        </div>
        <div className={styles.hatchHeaderActions}>
          <span className={`${styles.skillStatus} ${styles[`skillStatus_${hatchStatus?.status ?? 'loading'}`]}`}>
            {t(`settings.pet.hatchStatus.${hatchStatus?.status ?? 'loading'}`)}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => {
              refreshPetAssets();
              petBridge.getHatchStatus();
            }}
            title={t('settings.pet.refreshLocalPets')}
            aria-label={t('settings.pet.refreshLocalPets')}
          >
            <span className="codicon codicon-refresh" aria-hidden="true" />
          </button>
        </div>
      </div>
      {hatchStatus === null ? null : hatchStatus.status !== 'installed' ? (
        <div className={styles.hatchActions}>
          <span className={styles.pathText}>{hatchStatus.skillPath}</span>
          <button type="button" className={styles.primaryButton}
            onClick={() => prepareHatchCommand('install')}>
            <span className={`codicon ${hatchStatus.status === 'broken' ? 'codicon-tools' : 'codicon-extensions'}`} aria-hidden="true" />
            {t(hatchStatus.status === 'broken'
              ? 'settings.pet.prepareRepairSkill'
              : 'settings.pet.prepareInstallSkill')}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={petBridge.openHatchWebsite}>
            <span className="codicon codicon-link-external" aria-hidden="true" />
            {t('settings.pet.hatchOfficialSource')}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={petBridge.openPetDirectory}>
            <span className="codicon codicon-folder-opened" aria-hidden="true" />
            {t('settings.pet.openPetDirectory')}
          </button>
        </div>
      ) : (
        <div className={styles.hatchWorkspace}>
          <div className={styles.hatchFields}>
            <div className={styles.hatchFieldGrid}>
              <label className={styles.field}>
                <span>{t('settings.pet.hatchName')}</span>
                <input type="text" maxLength={80} value={hatchName}
                  onChange={(event) => setHatchName(event.target.value)} />
              </label>
              <label className={styles.field}>
                <span>{t('settings.pet.hatchStyle')}</span>
                <select value={hatchStyle} onChange={(event) => setHatchStyle(event.target.value)}>
                  {['auto', 'pixel', 'plush', 'clay', 'sticker', 'flat-vector', '3d-toy', 'painterly', 'brand-inspired']
                    .map((style) => <option key={style} value={style}>{style}</option>)}
                </select>
              </label>
            </div>
            <label className={`${styles.field} ${styles.hatchDescriptionField}`}>
              <span>{t('settings.pet.hatchPrompt')}</span>
              <textarea rows={7} maxLength={500} value={hatchDescription}
                onChange={(event) => setHatchDescription(event.target.value)} />
            </label>
          </div>
          <aside className={styles.referenceWorkspace}>
            <div className={styles.referencePicker}>
              <span>{t('settings.pet.referenceImage')}</span>
              <div className={styles.referenceDropzone}>
                <span className="codicon codicon-file-media" aria-hidden="true" />
                <p>{hatchReference || t('settings.pet.noReference')}</p>
              </div>
              <button type="button" className={`${styles.secondaryButton} ${styles.referenceChooseButton}`}
                onClick={petBridge.chooseHatchReference}>
                {t('settings.pet.chooseReference')}
              </button>
            </div>
          </aside>
        </div>
      )}
      {hatchStatus?.status === 'installed' && (
        <div className={styles.hatchFooter}>
          <span>{t('settings.pet.hatchCommandHint')}</span>
          <div className={styles.hatchActions}>
            <button type="button" className={styles.primaryButton}
              onClick={() => prepareHatchCommand('create')}>
              <span className="codicon codicon-sparkle" aria-hidden="true" />
              {t('settings.pet.prepareCreatePet')}
            </button>
            <button type="button" className={styles.secondaryButton}
              onClick={() => prepareHatchCommand('repair')}>
              <span className="codicon codicon-tools" aria-hidden="true" />
              {t('settings.pet.prepareRepairPet')}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={petBridge.openPetDirectory}>
              <span className="codicon codicon-folder-opened" aria-hidden="true" />
              {t('settings.pet.openPetDirectory')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
