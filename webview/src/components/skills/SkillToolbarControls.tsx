import { useTranslation } from 'react-i18next';
import type { SkillFilter, SkillEnabledFilter, SkillScope } from '../../types/skill';

interface TabItemProps {
  active: boolean;
  onActivate: () => void;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

/** Single filter tab with click + Enter/Space keyboard activation */
function TabItem({ active, onActivate, title, className, children }: TabItemProps) {
  return (
    <div
      className={`tab-item${className ? ` ${className}` : ''}${active ? ' active' : ''}`}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } }}
      title={title}
    >
      {children}
    </div>
  );
}

interface SkillFilterTabsProps {
  isCodex: boolean;
  currentFilter: SkillFilter;
  enabledFilter: SkillEnabledFilter;
  totalCount: number;
  primaryCount: number;
  secondaryCount: number;
  enabledCount: number;
  disabledCount: number;
  onFilterChange: (filter: SkillFilter) => void;
  onEnabledFilterChange: (filter: SkillEnabledFilter) => void;
}

/** Scope tabs (all / primary / secondary) plus enabled-status filter tabs */
export function SkillFilterTabs({
  isCodex,
  currentFilter,
  enabledFilter,
  totalCount,
  primaryCount,
  secondaryCount,
  enabledCount,
  disabledCount,
  onFilterChange,
  onEnabledFilterChange,
}: SkillFilterTabsProps) {
  const { t } = useTranslation();
  const primaryFilter: SkillFilter = isCodex ? 'user' : 'global';
  const secondaryFilter: SkillFilter = isCodex ? 'repo' : 'local';

  return (
    <div className="filter-tabs" role="tablist">
      <TabItem
        active={currentFilter === 'all'}
        onActivate={() => onFilterChange('all')}
      >
        {t('skills.all')} <span className="count-badge">{totalCount}</span>
      </TabItem>
      <TabItem
        active={currentFilter === primaryFilter}
        onActivate={() => onFilterChange(primaryFilter)}
      >
        {isCodex ? t('skills.user') : t('skills.global')} <span className="count-badge">{primaryCount}</span>
      </TabItem>
      <TabItem
        active={currentFilter === secondaryFilter}
        onActivate={() => onFilterChange(secondaryFilter)}
      >
        {isCodex ? t('skills.repo') : t('skills.local')} <span className="count-badge">{secondaryCount}</span>
      </TabItem>
      {/* Enabled status filter */}
      <div className="filter-separator"></div>
      <TabItem
        className="enabled-filter"
        active={enabledFilter === 'enabled'}
        onActivate={() => onEnabledFilterChange(enabledFilter === 'enabled' ? 'all' : 'enabled')}
        title={t('skills.filterEnabled')}
      >
        <span className="codicon codicon-check"></span>
        {t('skills.enabled')} <span className="count-badge">{enabledCount}</span>
      </TabItem>
      <TabItem
        className="enabled-filter"
        active={enabledFilter === 'disabled'}
        onActivate={() => onEnabledFilterChange(enabledFilter === 'disabled' ? 'all' : 'disabled')}
        title={t('skills.filterDisabled')}
      >
        <span className="codicon codicon-circle-slash"></span>
        {t('skills.disabled')} <span className="count-badge">{disabledCount}</span>
      </TabItem>
    </div>
  );
}

interface SkillSearchBoxProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

/** Search input with leading icon */
export function SkillSearchBox({ searchQuery, onSearchChange }: SkillSearchBoxProps) {
  const { t } = useTranslation();

  return (
    <div className="search-box">
      <span className="codicon codicon-search"></span>
      <input
        type="text"
        className="search-input"
        placeholder={t('skills.searchPlaceholder')}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  );
}

interface SkillImportDropdownProps {
  isCodex: boolean;
  showDropdown: boolean;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  primaryScope: SkillScope;
  secondaryScope: SkillScope;
  onToggleDropdown: () => void;
  onImport: (scope: SkillScope) => void;
}

/** Import button with scope dropdown menu */
export function SkillImportDropdown({
  isCodex,
  showDropdown,
  dropdownRef,
  primaryScope,
  secondaryScope,
  onToggleDropdown,
  onImport,
}: SkillImportDropdownProps) {
  const { t } = useTranslation();

  return (
    <div className="add-dropdown" ref={dropdownRef}>
      <button
        className="icon-btn primary"
        onClick={onToggleDropdown}
        title={t('skills.importSkill')}
      >
        <span className="codicon codicon-add"></span>
      </button>
      {showDropdown && (
        <div className="dropdown-menu">
          <div className="dropdown-item" onClick={() => onImport(primaryScope)}>
            <span className="codicon codicon-globe"></span>
            {isCodex ? t('skills.importUserSkill') : t('skills.importGlobalSkill')}
          </div>
          <div className="dropdown-item" onClick={() => onImport(secondaryScope)}>
            <span className="codicon codicon-desktop-download"></span>
            {isCodex ? t('skills.importRepoSkill') : t('skills.importLocalSkill')}
          </div>
        </div>
      )}
    </div>
  );
}
