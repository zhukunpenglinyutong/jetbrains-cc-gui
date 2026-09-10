import { useTranslation } from 'react-i18next';
import {
  petBridge,
  type CatalogColumnCount,
  type CatalogPageSize,
  type CatalogSort,
  type CodexPetConfig,
} from '../../codexPet/petBridge';
import { RemoteSpritePreview } from './previews';
import type { PendingPetOperation } from './types';
import type { CatalogState } from './useCatalog';
import { MAX_CATALOG_QUERY_LENGTH, parseNumericInput } from './utils';
import styles from './style.module.less';

const CATALOG_COLUMN_OPTIONS: CatalogColumnCount[] = [3, 4, 5, 6];
const CATALOG_PAGE_SIZE_OPTIONS: CatalogPageSize[] = [12, 24, 36, 48];
const CATALOG_SORT_OPTIONS: CatalogSort[] = [
  'default',
  'name_asc',
  'name_desc',
  'author_asc',
  'kind_asc',
  'slug_asc',
];

interface PetDexTabProps {
  config: CodexPetConfig;
  updateConfig: (patch: Partial<CodexPetConfig>) => void;
  updateConfigDraft: (patch: Partial<CodexPetConfig>) => void;
  catalogState: CatalogState;
  pendingPetOperation: PendingPetOperation | null;
  installPet: (slug: string) => void;
  uninstallPet: (slug: string, name: string) => void;
}

export default function PetDexTab({
  config,
  updateConfig,
  updateConfigDraft,
  catalogState,
  pendingPetOperation,
  installPet,
  uninstallPet,
}: PetDexTabProps) {
  const { t } = useTranslation();
  const {
    catalog,
    catalogTotal,
    catalogLoading,
    catalogError,
    search,
    setSearch,
    currentPage,
    pageInput,
    setPageInput,
    totalPages,
    catalogErrorDescriptor,
    refreshCatalog,
    goToPage,
    commitPageInput,
  } = catalogState;

  return (
    <section className={styles.catalogSection}>
      <div className={styles.catalogHeader}>
        <div>
          <h4>{t('settings.pet.petdexTitle')}</h4>
          <p>{t('settings.pet.petdexDescription')}</p>
        </div>
        <div className={styles.catalogActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={refreshCatalog}
            disabled={catalogLoading}
            title={t('settings.pet.refreshCatalog')}
            aria-label={t('settings.pet.refreshCatalog')}
          >
            <span className={`codicon codicon-refresh${catalogLoading ? ` ${styles.spinning}` : ''}`} />
          </button>
          <button type="button" className={styles.secondaryButton} onClick={petBridge.openWebsite}>
            <span className="codicon codicon-link-external" aria-hidden="true" />
            Petdex
          </button>
        </div>
      </div>

      <div className={styles.repositorySettings}>
        <label className={styles.field}>
          <span>{t('settings.pet.connectTimeout')}</span>
          <input
            type="number"
            min="5"
            max="300"
            value={config.petdexConnectTimeoutSeconds}
            onChange={(event) => updateConfigDraft({
              petdexConnectTimeoutSeconds: parseNumericInput(event.target.value, config.petdexConnectTimeoutSeconds),
            })}
            onBlur={(event) => updateConfig({
              petdexConnectTimeoutSeconds: parseNumericInput(event.currentTarget.value, config.petdexConnectTimeoutSeconds),
            })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.requestTimeout')}</span>
          <input
            type="number"
            min="10"
            max="300"
            value={config.petdexRequestTimeoutSeconds}
            onChange={(event) => updateConfigDraft({
              petdexRequestTimeoutSeconds: parseNumericInput(event.target.value, config.petdexRequestTimeoutSeconds),
            })}
            onBlur={(event) => updateConfig({
              petdexRequestTimeoutSeconds: parseNumericInput(event.currentTarget.value, config.petdexRequestTimeoutSeconds),
            })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.retryAttempts')}</span>
          <input
            type="number"
            min="0"
            max="10"
            value={config.petdexRetryAttempts}
            onChange={(event) => updateConfigDraft({
              petdexRetryAttempts: parseNumericInput(event.target.value, config.petdexRetryAttempts),
            })}
            onBlur={(event) => updateConfig({
              petdexRetryAttempts: parseNumericInput(event.currentTarget.value, config.petdexRetryAttempts),
            })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.catalogColumns')}</span>
          <select
            value={config.catalogColumns}
            onChange={(event) => updateConfig({
              catalogColumns: Number(event.target.value) as CatalogColumnCount,
            })}
          >
            {CATALOG_COLUMN_OPTIONS.map((columns) => (
              <option key={columns} value={columns}>
                {t(`settings.pet.columns${columns}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.catalogPageSize')}</span>
          <select
            value={config.catalogPageSize}
            onChange={(event) => updateConfig({
              catalogPageSize: Number(event.target.value) as CatalogPageSize,
            })}
          >
            {CATALOG_PAGE_SIZE_OPTIONS.map((pageSize) => (
              <option key={pageSize} value={pageSize}>
                {t('settings.pet.pageSizeOption', { count: pageSize })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.catalogSort')}</span>
          <select
            value={config.catalogSort}
            onChange={(event) => updateConfig({ catalogSort: event.target.value as CatalogSort })}
          >
            {CATALOG_SORT_OPTIONS.map((sort) => (
              <option key={sort} value={sort}>
                {t(`settings.pet.sort.${sort}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={styles.searchBox}>
        <span className="codicon codicon-search" aria-hidden="true" />
        <input
          type="search"
          value={search}
          maxLength={MAX_CATALOG_QUERY_LENGTH}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('settings.pet.searchPlaceholder')}
        />
      </label>

      {catalogError && catalogErrorDescriptor && (
        <div className={styles.errorState}>
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('settings.pet.catalogError', {
            error: t(catalogErrorDescriptor.key, catalogErrorDescriptor.params),
          })}</span>
        </div>
      )}

      {catalogLoading && !catalogError && catalog.length === 0 && (
        <div className={styles.loadingState}>
          <span className={`codicon codicon-loading ${styles.spinning}`} aria-hidden="true" />
          <span>{t('settings.pet.loadingCatalog')}</span>
        </div>
      )}

      {!catalogLoading && !catalogError && catalog.length === 0 && (
        <div className={styles.emptyState}>{t('settings.pet.noPets')}</div>
      )}

      <div
        className={styles.catalogGrid}
        data-testid="pet-catalog-grid"
        style={{ gridTemplateColumns: `repeat(${config.catalogColumns}, minmax(0, 1fr))` }}
      >
        {catalog.map((pet) => {
          const pending = pendingPetOperation?.target === pet.slug;
          const displayName = pet.alias || pet.displayName;
          return (
            <article key={pet.slug} className={styles.petCard}>
              <RemoteSpritePreview
                slug={pet.slug}
                label={displayName}
                unavailableLabel={t('settings.pet.previewUnavailable')}
              />
              <div className={styles.petInfo}>
                <strong title={pet.alias ? `${pet.alias} (${pet.displayName})` : pet.displayName}>
                  {displayName}
                </strong>
                <span>{pet.submittedBy || pet.kind || pet.slug}</span>
              </div>
              {pet.managed ? (
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => uninstallPet(pet.slug, displayName)}
                  disabled={pendingPetOperation !== null}
                >
                  <span className="codicon codicon-trash" aria-hidden="true" />
                  {pending ? t('settings.pet.processing') : t('settings.pet.uninstall')}
                </button>
              ) : pet.installed ? (
                <span className={styles.installedLabel}>{t('settings.pet.installedExternally')}</span>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => installPet(pet.slug)}
                  disabled={pendingPetOperation !== null}
                >
                  <span className="codicon codicon-cloud-download" aria-hidden="true" />
                  {pending ? t('settings.pet.processing') : t('settings.pet.install')}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {!catalogError && catalogTotal > 0 && (
        <nav className={styles.pagination} aria-label={t('settings.pet.pagination')}>
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => goToPage(currentPage - 1)}
            disabled={catalogLoading || currentPage <= 1}
            title={t('settings.pet.previousPage')}
            aria-label={t('settings.pet.previousPage')}
          >
            <span className="codicon codicon-chevron-left" aria-hidden="true" />
          </button>
          <span>{t('settings.pet.pageStatus', { current: currentPage, total: totalPages })}</span>
          <label className={styles.pageJump}>
            <span>{t('settings.pet.pageJump')}</span>
            <input
              type="number"
              min="1"
              max={totalPages}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitPageInput();
                }
              }}
              onBlur={commitPageInput}
              aria-label={t('settings.pet.pageJump')}
            />
            <button
              type="button"
              className={styles.pageButton}
              onMouseDown={(event) => event.preventDefault()}
              onClick={commitPageInput}
              disabled={catalogLoading}
              title={t('settings.pet.goToPage')}
              aria-label={t('settings.pet.goToPage')}
            >
              <span className="codicon codicon-arrow-right" aria-hidden="true" />
            </button>
          </label>
          <button
            type="button"
            className={styles.pageButton}
            onClick={() => goToPage(currentPage + 1)}
            disabled={catalogLoading || currentPage >= totalPages}
            title={t('settings.pet.nextPage')}
            aria-label={t('settings.pet.nextPage')}
          >
            <span className="codicon codicon-chevron-right" aria-hidden="true" />
          </button>
        </nav>
      )}
    </section>
  );
}
