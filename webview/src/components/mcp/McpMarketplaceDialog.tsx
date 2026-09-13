import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpInstallOption, McpMarketplaceEntry, McpMarketplaceSearchResponse, McpMarketplaceSource, McpServer, McpServerSpec } from '../../types/mcp';
import { sendToJava, openBrowser } from '../../utils/bridge';

interface McpMarketplaceDialogProps {
  currentProvider?: 'claude' | 'codex' | string;
  existingIds?: string[];
  onClose: () => void;
  onSelect: (server: McpServer) => void;
}

const ALL_SOURCES_ID = 'all';
const DEFAULT_SOURCE_ID = 'built-in';
const SELECTED_SOURCE_STORAGE_KEY = 'codriver.mcp.marketplace.lastSourceId';

function readPreferredSourceId() {
  try {
    return window.localStorage.getItem(SELECTED_SOURCE_STORAGE_KEY) || DEFAULT_SOURCE_ID;
  } catch {
    return DEFAULT_SOURCE_ID;
  }
}

function rememberPreferredSourceId(sourceId: string) {
  try {
    window.localStorage.setItem(SELECTED_SOURCE_STORAGE_KEY, sourceId);
  } catch {
    // Ignore unavailable webview storage.
  }
}

/**
 * Marketplace URLs come from untrusted registry payloads. React does not sanitize the
 * `href` scheme, so a `javascript:` link would execute in the webview. Only allow http(s).
 */
function isSafeHttpUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Install options that launch a command/container locally warrant a prominent warning. */
function isRiskyInstallOption(option: McpInstallOption): boolean {
  return option.riskLevel === 'local-command'
    || option.riskLevel === 'container-command'
    || option.riskLevel === 'unverified-command';
}

/**
 * MCP Marketplace Browser adapted from the former Swing registry browser.
 */
export function McpMarketplaceDialog({ currentProvider = 'claude', existingIds = [], onClose, onSelect }: McpMarketplaceDialogProps) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';
  const [sources, setSources] = useState<McpMarketplaceSource[]>([]);
  const [entries, setEntries] = useState<McpMarketplaceEntry[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState(readPreferredSourceId);
  const [query, setQuery] = useState('');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEntry = useMemo(
    () => entries.find(entry => entry.id === selectedEntryId) || entries[0] || null,
    [entries, selectedEntryId]
  );

  const selectedInstallOption = useMemo(() => {
    if (!selectedEntry || selectedEntry.installOptions.length === 0) {
      return null;
    }
    return selectedEntry.installOptions[Math.min(selectedOptionIndex, selectedEntry.installOptions.length - 1)];
  }, [selectedEntry, selectedOptionIndex]);

  const loadEntries = useCallback((forceRefresh = false) => {
    setLoading(true);
    setError(null);
    sendToJava('search_mcp_marketplace', {
      query,
      sourceId: selectedSourceId,
      forceRefresh,
    });
  }, [query, selectedSourceId]);

  useEffect(() => {
    const handleSources = (json: string) => {
      try {
        const parsedSources = JSON.parse(json) as McpMarketplaceSource[];
        setSources(parsedSources);
        // Functional updater reads the CURRENT selection, not the value captured when this handler
        // was registered — the effect runs once ([] deps), so a plain read would be stale.
        setSelectedSourceId(current =>
          current !== ALL_SOURCES_ID && !parsedSources.some(source => source.id === current)
            ? DEFAULT_SOURCE_ID
            : current
        );
      } catch (parseError) {
        setError(String(parseError));
      }
    };

    const handleEntries = (json: string) => {
      try {
        const response = JSON.parse(json) as McpMarketplaceSearchResponse;
        setEntries(response.entries || []);
        setSelectedEntryId(response.entries?.[0]?.id || null);
        setSelectedOptionIndex(0);
        setError(response.error || null);
      } catch (parseError) {
        setError(String(parseError));
      } finally {
        setLoading(false);
      }
    };

    const previousSourcesHandler = window.updateMcpMarketplaceSources;
    const previousEntriesHandler = window.updateMcpMarketplaceEntries;
    window.updateMcpMarketplaceSources = handleSources;
    window.updateMcpMarketplaceEntries = handleEntries;

    // The debounced effect below performs the initial search (using the persisted
    // source), so only the source list needs to be requested here.
    sendToJava('get_mcp_marketplace_sources', {});

    return () => {
      window.updateMcpMarketplaceSources = previousSourcesHandler;
      window.updateMcpMarketplaceEntries = previousEntriesHandler;
    };
  }, []);

  useEffect(() => {
    rememberPreferredSourceId(selectedSourceId);
  }, [selectedSourceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => loadEntries(false), 350);
    return () => window.clearTimeout(timer);
  }, [loadEntries]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleSelectEntry = (entry: McpMarketplaceEntry) => {
    setSelectedEntryId(entry.id);
    setSelectedOptionIndex(0);
  };

  const handleInstall = () => {
    if (!selectedEntry || !selectedInstallOption) {
      return;
    }
    onSelect(createServerFromMarketplaceEntry(selectedEntry, selectedInstallOption, existingIds, isCodexMode));
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-marketplace-dialog">
        <div className="dialog-header">
          <div>
            <h3>{t('mcp.market.title')}</h3>
            <div className="marketplace-subtitle">{t('mcp.market.subtitle')}</div>
          </div>
          <button className="close-btn" type="button" aria-label={t('mcp.cancel')} onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body marketplace-body">
          <div className="marketplace-toolbar">
            <div className="marketplace-search-box">
              <span className="codicon codicon-search"></span>
              <input
                value={query}
                placeholder={t('mcp.market.searchPlaceholder')}
                onChange={event => setQuery(event.target.value)}
              />
            </div>
            <select
              className="marketplace-source-select"
              value={selectedSourceId}
              onChange={event => setSelectedSourceId(event.target.value)}
            >
              <option value={ALL_SOURCES_ID}>{t('mcp.market.allSources')}</option>
              {sources.map(source => (
                <option key={source.id} value={source.id}>{source.name}</option>
              ))}
            </select>
            <button className="icon-btn" onClick={() => loadEntries(true)} title={t('mcp.market.refresh')}>
              <span className={`codicon codicon-sync ${loading ? 'spinning' : ''}`}></span>
            </button>
          </div>

          {error && (
            <div className="marketplace-error">
              <span className="codicon codicon-warning"></span>
              {error}
            </div>
          )}

          <div className="marketplace-content">
            <div className="marketplace-list">
              {loading && entries.length === 0 && (
                <div className="marketplace-loading">
                  <span className="codicon codicon-loading codicon-modifier-spin"></span>
                  {t('mcp.market.loading')}
                </div>
              )}
              {!loading && entries.length === 0 && (
                <div className="marketplace-empty">
                  <span className="codicon codicon-extensions"></span>
                  <p>{t('mcp.market.empty')}</p>
                </div>
              )}
              {entries.map(entry => (
                <MarketplaceListItem
                  key={entry.id}
                  entry={entry}
                  selected={selectedEntry?.id === entry.id}
                  onSelect={() => handleSelectEntry(entry)}
                />
              ))}
            </div>

            <div className="marketplace-details">
              {selectedEntry ? (
                <MarketplaceDetails
                  entry={selectedEntry}
                  selectedOptionIndex={selectedOptionIndex}
                  onSelectedOptionIndexChange={setSelectedOptionIndex}
                />
              ) : (
                <div className="marketplace-details-empty">{t('mcp.market.selectServer')}</div>
              )}
            </div>
          </div>
        </div>

        <div className="dialog-footer marketplace-footer">
          <div className="footer-hint">
            <span className="codicon codicon-shield"></span>
            {t('mcp.market.footerHint')}
          </div>
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={onClose}>{t('mcp.cancel')}</button>
            <button className="btn btn-primary" onClick={handleInstall} disabled={!selectedInstallOption}>
              {t('mcp.market.addServer')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MarketplaceListItemProps {
  entry: McpMarketplaceEntry;
  selected: boolean;
  onSelect: () => void;
}

function MarketplaceListItem({ entry, selected, onSelect }: MarketplaceListItemProps) {
  const { t } = useTranslation();
  const displayName = entry.displayName || entry.name;
  return (
    <div
      className={`marketplace-entry ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="marketplace-entry-icon">{displayName.charAt(0).toUpperCase()}</div>
      <div className="marketplace-entry-info">
        <div className="marketplace-entry-title-row">
          <span className="marketplace-entry-title">{displayName}</span>
          {entry.official && <span className="marketplace-pill official">{t('mcp.market.official')}</span>}
          {entry.installOptions.length > 0 ? <span className="marketplace-pill installable">{t('mcp.market.installable')}</span> : <span className="marketplace-pill browse-only">{t('mcp.market.browseOnly')}</span>}
        </div>
        {entry.description && <div className="marketplace-entry-description">{entry.description}</div>}
        <div className="marketplace-entry-meta">
          <span>{entry.sourceName}</span>
          {entry.status && <span>{entry.status}</span>}
        </div>
      </div>
    </div>
  );
}

interface MarketplaceDetailsProps {
  entry: McpMarketplaceEntry;
  selectedOptionIndex: number;
  onSelectedOptionIndexChange: (index: number) => void;
}

// JCEF won't route target=_blank to the system browser — go through the bridge.
const openMarketplaceLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  openBrowser(event.currentTarget.href);
};

function MarketplaceDetails({ entry, selectedOptionIndex, onSelectedOptionIndexChange }: MarketplaceDetailsProps) {
  const { t } = useTranslation();
  const selectedOption = entry.installOptions[Math.min(selectedOptionIndex, Math.max(entry.installOptions.length - 1, 0))];
  return (
    <div className="marketplace-details-card">
      <div className="marketplace-details-title-row">
        <h4>{entry.displayName || entry.name}</h4>
        <span className="marketplace-source-badge">{entry.sourceName}</span>
      </div>
      <div className="marketplace-details-name">{entry.name}</div>
      {entry.description && <p className="marketplace-details-description">{entry.description}</p>}

      <div className="marketplace-tags">
        {entry.tags.slice(0, 8).map((tag, index) => <span key={`${tag}-${index}`} className="tag">{tag}</span>)}
      </div>

      <div className="marketplace-link-grid">
        {isSafeHttpUrl(entry.repositoryUrl) && <a href={entry.repositoryUrl} target="_blank" rel="noopener noreferrer" onClick={openMarketplaceLink}>{t('mcp.market.repository')}</a>}
        {isSafeHttpUrl(entry.docsUrl) && <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer" onClick={openMarketplaceLink}>{t('mcp.market.docs')}</a>}
        {isSafeHttpUrl(entry.homepage) && <a href={entry.homepage} target="_blank" rel="noopener noreferrer" onClick={openMarketplaceLink}>{t('mcp.market.homepage')}</a>}
      </div>

      {entry.installOptions.length > 0 ? (
        <>
          <label className="marketplace-option-label">{t('mcp.market.installOption')}</label>
          <select
            className="marketplace-install-select"
            value={selectedOptionIndex}
            onChange={event => onSelectedOptionIndexChange(Number(event.target.value))}
          >
            {entry.installOptions.map((option, index) => (
              <option key={`${option.label}-${index}`} value={index}>{option.label}</option>
            ))}
          </select>
          {selectedOption && <InstallPreview option={selectedOption} />}
        </>
      ) : (
        <div className="marketplace-no-install">
          {t('mcp.market.noInstall')}
        </div>
      )}
    </div>
  );
}

interface InstallPreviewProps {
  option: McpInstallOption;
}

function InstallPreview({ option }: InstallPreviewProps) {
  const { t } = useTranslation();
  const preview = createPreviewConfig(option);
  const risky = isRiskyInstallOption(option);
  const warningKey = option.riskLevel === 'unverified-command'
    ? 'mcp.market.riskWarningUnverified'
    : 'mcp.market.riskWarning';
  return (
    <div className="marketplace-install-preview">
      {risky && (
        <div className={`marketplace-risk-warning ${option.riskLevel === 'unverified-command' ? 'severe' : ''}`}>
          <span className="codicon codicon-warning"></span>
          <span>{t(warningKey)}</span>
        </div>
      )}
      <div className="marketplace-preview-header">
        <span className="codicon codicon-terminal"></span>
        {t('mcp.market.configPreview')}
        {option.riskLevel && <span className="marketplace-risk">{option.riskLevel}</span>}
      </div>
      <pre>{JSON.stringify(preview, null, 2)}</pre>
    </div>
  );
}

function createServerFromMarketplaceEntry(
  entry: McpMarketplaceEntry,
  option: McpInstallOption,
  existingIds: string[],
  isCodexMode: boolean
): McpServer {
  return {
    id: createUniqueServerId(entry, existingIds),
    name: entry.displayName || entry.name,
    description: entry.description,
    tags: entry.tags,
    server: createServerSpec(option, entry),
    apps: {
      claude: !isCodexMode,
      codex: isCodexMode,
      gemini: false,
    },
    homepage: entry.homepage,
    docs: entry.docsUrl,
    enabled: true,
  };
}

function createServerSpec(option: McpInstallOption, entry: McpMarketplaceEntry): McpServerSpec {
  const spec: McpServerSpec = {
    type: normalizeMcpServerType(option.type),
  };
  if (option.command) {
    spec.command = option.command;
  }
  if (option.args && option.args.length > 0) {
    spec.args = option.args;
  }
  if (option.url) {
    spec.url = option.url;
  }
  if (option.env && Object.keys(option.env).length > 0) {
    spec.env = option.env;
  }
  if (option.headers && Object.keys(option.headers).length > 0) {
    spec.headers = option.headers;
  }
  spec['x-metadata'] = {
    registry: {
      source: entry.sourceName,
      mcpServer: {
        name: entry.name,
      },
    },
  };
  return spec;
}

function createPreviewConfig(option: McpInstallOption): Record<string, unknown> {
  const config = createServerSpec(option, {
    id: 'preview',
    name: 'preview',
    sourceId: 'preview',
    sourceName: option.source || 'marketplace',
    sourceType: 'preview',
    official: false,
    tags: [],
    installOptions: [],
  });
  delete config['x-metadata'];
  return config;
}

function createUniqueServerId(entry: McpMarketplaceEntry, existingIds: string[]): string {
  const baseId = (entry.name || entry.displayName || 'mcp-server')
    .replace(/^io\.github\./, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mcp-server';
  if (!existingIds.includes(baseId)) {
    return baseId;
  }
  let counter = 2;
  while (existingIds.includes(`${baseId}-${counter}`)) {
    counter++;
  }
  return `${baseId}-${counter}`;
}

function normalizeMcpServerType(type: string | undefined): 'stdio' | 'http' | 'sse' {
  if (type === 'sse') {
    return 'sse';
  }
  if (type === 'http') {
    return 'http';
  }
  return 'stdio';
}
