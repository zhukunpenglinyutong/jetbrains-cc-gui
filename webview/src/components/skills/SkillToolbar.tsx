import { useTranslation } from 'react-i18next';
import type { SkillFilter, SkillEnabledFilter, SkillScope } from '../../types/skill';
import { SkillFilterTabs, SkillSearchBox, SkillImportDropdown } from './SkillToolbarControls';

interface SkillToolbarProps {
  isCodex: boolean;
  currentFilter: SkillFilter;
  enabledFilter: SkillEnabledFilter;
  totalCount: number;
  primaryCount: number;
  secondaryCount: number;
  enabledCount: number;
  disabledCount: number;
  searchQuery: string;
  loading: boolean;
  showDropdown: boolean;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  primaryScope: SkillScope;
  secondaryScope: SkillScope;
  onFilterChange: (filter: SkillFilter) => void;
  onEnabledFilterChange: (filter: SkillEnabledFilter) => void;
  onSearchChange: (query: string) => void;
  onShowHelp: () => void;
  onToggleDropdown: () => void;
  onImport: (scope: SkillScope) => void;
  onRefresh: () => void;
}

/**
 * Skills toolbar: scope/enabled filter tabs, search box,
 * help / import / refresh actions
 */
export function SkillToolbar({
  isCodex,
  currentFilter,
  enabledFilter,
  totalCount,
  primaryCount,
  secondaryCount,
  enabledCount,
  disabledCount,
  searchQuery,
  loading,
  showDropdown,
  dropdownRef,
  primaryScope,
  secondaryScope,
  onFilterChange,
  onEnabledFilterChange,
  onSearchChange,
  onShowHelp,
  onToggleDropdown,
  onImport,
  onRefresh,
}: SkillToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="skills-toolbar">
      {/* Filter tabs */}
      <SkillFilterTabs
        isCodex={isCodex}
        currentFilter={currentFilter}
        enabledFilter={enabledFilter}
        totalCount={totalCount}
        primaryCount={primaryCount}
        secondaryCount={secondaryCount}
        enabledCount={enabledCount}
        disabledCount={disabledCount}
        onFilterChange={onFilterChange}
        onEnabledFilterChange={onEnabledFilterChange}
      />

      {/* Right-side tools */}
      <div className="toolbar-right">
        {/* Search box */}
        <SkillSearchBox searchQuery={searchQuery} onSearchChange={onSearchChange} />

        {/* Help button */}
        <button
          className="icon-btn"
          onClick={onShowHelp}
          title={t('skills.whatIsSkills')}
        >
          <span className="codicon codicon-question"></span>
        </button>

        {/* Import button */}
        <SkillImportDropdown
          isCodex={isCodex}
          showDropdown={showDropdown}
          dropdownRef={dropdownRef}
          primaryScope={primaryScope}
          secondaryScope={secondaryScope}
          onToggleDropdown={onToggleDropdown}
          onImport={onImport}
        />

        {/* Refresh button */}
        <button
          className="icon-btn"
          onClick={onRefresh}
          disabled={loading}
          title={t('chat.refresh')}
        >
          <span className={`codicon codicon-refresh ${loading ? 'spinning' : ''}`}></span>
        </button>
      </div>
    </div>
  );
}
