import React, { useState } from "react";
import { Card, Select } from "../../components";
import { toFiniteNumber } from "../../../lib/format";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { ProviderIcon } from "./ProviderIcon";
import { ProjectDetailModal } from "./ProjectDetailModal.jsx";
import {
  ProjectAvatar,
  githubOwnerFor,
  splitProjectKey,
} from "./project-usage-utils.jsx";

const PROJECT_SOURCE_ICON_LIMIT = 5;

// Hoisted so destructuring defaults don't create a fresh reference per render.
const EMPTY_LIST = [];
const EMPTY_QUERY = {};

function ProjectRow({ entry, maxTokens, copy, formatTokens, formatTokensTooltip, onSelect }) {
  const projectKey = typeof entry?.project_key === "string" ? entry.project_key : "";
  const projectRef = typeof entry?.project_ref === "string" ? entry.project_ref : "";
  const { owner, repo } = splitProjectKey(projectKey);
  const githubOwner = githubOwnerFor(projectRef, owner);
  const tokensRaw = toFiniteNumber(entry?.billable_total_tokens ?? entry?.total_tokens) ?? 0;
  const widthPct = maxTokens > 0 ? Math.min(100, Math.max(2, (tokensRaw / maxTokens) * 100)) : 0;
  const sources = Array.isArray(entry?.sources) ? entry.sources : [];
  const visibleSources = sources.slice(0, PROJECT_SOURCE_ICON_LIMIT);
  const overflowCount = sources.length - visibleSources.length;

  // A button, not an external link: clicking opens the local drill-down
  // modal. Never navigate to project_ref — leaking which repos the user
  // works on to an external host is not this panel's call to make.
  return (
    <button
      type="button"
      onClick={() => onSelect?.(entry)}
      className="flex w-full items-center gap-3 p-2 rounded-lg text-left hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50 active:bg-oai-gray-100 dark:active:bg-oai-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand/60 transition-colors"
    >
      <ProjectAvatar
        githubOwner={githubOwner}
        letter={(repo?.[0] || projectKey?.[0] || "?").toUpperCase()}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline min-w-0">
          {owner ? (
            <span className="oai-text-caption text-oai-gray-400 dark:text-oai-gray-500 truncate flex-shrink-[2]">
              {owner}/
            </span>
          ) : null}
          <span className="oai-text-body-sm font-medium text-oai-black dark:text-oai-white truncate">
            {repo || projectKey || "—"}
          </span>
        </div>
        {visibleSources.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1">
            {visibleSources.map((s) => (
              <ProviderIcon
                key={s.source}
                provider={s.source}
                size={12}
                className="text-oai-gray-400 dark:text-oai-gray-500"
              />
            ))}
            {overflowCount > 0 && (
              <span className="oai-text-caption text-oai-gray-400 dark:text-oai-gray-500">
                {copy("dashboard.projects.sources_more", { n: overflowCount })}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex w-24 flex-shrink-0 flex-col items-end gap-1">
        <span
          className="oai-text-body-sm font-medium text-oai-black dark:text-oai-white tabular-nums"
          title={formatTokensTooltip(tokensRaw)}
        >
          {formatTokens(tokensRaw)}
        </span>
        <div className="h-1 w-full overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800">
          <div
            className="h-full rounded-full bg-emerald-500"
            style={{ width: `${widthPct}%`, minWidth: tokensRaw > 0 ? "3px" : 0 }}
          />
        </div>
      </div>
    </button>
  );
}

export function DataDetails({
  // Project props
  projectEntries = EMPTY_LIST,
  projectLimit = 3,
  onProjectLimitChange,
  // { from, to, timeZone, tzOffsetMinutes } — forwarded to the per-project
  // drill-down modal so it queries the same range the panel shows.
  projectDetailQuery = EMPTY_QUERY,
  // Daily breakdown props
  copy,
  hasDetailsActual,
  dailyEmptyPrefix,
  installSyncCmd,
  dailyEmptySuffix,
  detailsColumns,
  ariaSortFor,
  toggleSort,
  sortIconFor,
  pagedDetails,
  dailyBreakdownRows = EMPTY_LIST,
  dailyBreakdownColumns = EMPTY_LIST,
  dailyBreakdownAriaSortFor,
  dailyBreakdownSortIconFor,
  dailyBreakdownDateKey = "day",
  detailsDateKey,
  renderDetailDate,
  renderDailyBreakdownDate,
  renderDetailCell,
  DETAILS_PAGED_PERIODS,
  period,
  detailsPageCount,
  detailsPage,
  setDetailsPage,
}) {
  const [activeTab, setActiveTab] = useState("daily");
  const [detailEntry, setDetailEntry] = useState(null);
  const { formatTokens, formatTokensTooltip } = useTokenFormat();

  return (
    <Card>
      {/* Tab Switcher + Controls */}
      <div className={`flex items-center justify-between gap-3 ${activeTab === "projects" ? "mb-4" : "mb-0"}`}>
        <div role="tablist" aria-label="Data view" className="flex gap-1">
          <button
            role="tab"
            aria-selected={activeTab === "daily"}
            type="button"
            onClick={() => setActiveTab("daily")}
            className={`text-xs font-medium px-3 py-1.5 rounded transition-colors ${
              activeTab === "daily"
                ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50"
            }`}
          >
            {copy("dashboard.daily.title")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "projects"}
            type="button"
            onClick={() => setActiveTab("projects")}
            className={`text-xs font-medium px-3 py-1.5 rounded transition-colors ${
              activeTab === "projects"
                ? "text-oai-black dark:text-oai-white bg-oai-gray-100 dark:bg-oai-gray-800"
                : "text-oai-gray-500 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/50"
            }`}
          >
            {copy("dashboard.projects.title")}
          </button>
        </div>
        {activeTab === "projects" && (
          <Select
            ariaLabel={copy("dashboard.projects.limit_aria")}
            value={projectLimit}
            onValueChange={(value) => onProjectLimitChange?.(Number(value))}
            options={[
              { value: 3, label: copy("dashboard.projects.limit_top_3") },
              { value: 6, label: copy("dashboard.projects.limit_top_6") },
              { value: 10, label: copy("dashboard.projects.limit_top_10") },
            ]}
            align="end"
            className="px-2 py-1 text-xs text-oai-gray-600 dark:text-oai-gray-300"
          />
        )}
      </div>

      {/* Projects Tab */}
      {activeTab === "projects" && (() => {
        const visibleEntries = projectEntries.slice(0, projectLimit);
        if (visibleEntries.length === 0) {
          return (
            <div className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300">
              {copy("dashboard.projects.empty")}
            </div>
          );
        }
        const maxTokens = visibleEntries.reduce((max, entry) => {
          const n = toFiniteNumber(entry?.billable_total_tokens ?? entry?.total_tokens) ?? 0;
          return n > max ? n : max;
        }, 0);
        return (
          <div className="space-y-1">
            {visibleEntries.map((entry, idx) => (
              <ProjectRow
                key={entry?.project_key || entry?.project_ref || `entry-${idx}`}
                entry={entry}
                maxTokens={maxTokens}
                copy={copy}
                formatTokens={formatTokens}
                formatTokensTooltip={formatTokensTooltip}
                onSelect={setDetailEntry}
              />
            ))}
          </div>
        );
      })()}

      {detailEntry && (
        <ProjectDetailModal
          entry={detailEntry}
          query={projectDetailQuery}
          onClose={() => setDetailEntry(null)}
        />
      )}

      {/* Daily Tab */}
      {activeTab === "daily" && (
        <div>
          {dailyBreakdownRows?.length === 0 ? (
            <div className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 mb-4">
              {dailyEmptyPrefix}
              <code className="mx-1 rounded border border-oai-gray-300 dark:border-oai-gray-700 oai-bg-elevated px-1.5 py-0.5 font-mono oai-text-caption">
                {installSyncCmd}
              </code>
              {dailyEmptySuffix}
            </div>
          ) : (
          <div className="overflow-auto max-h-[384px] -mx-4 oai-scrollbar">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-oai-gray-200 dark:border-oai-gray-700">
                  {dailyBreakdownColumns.map((column) => (
                    <th
                      key={column.key}
                      aria-sort={dailyBreakdownAriaSortFor?.(column.key) || "none"}
                      className="text-left p-0 bg-white dark:bg-oai-gray-900"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className="flex w-full items-center justify-start px-2.5 sm:px-4 py-2 text-left oai-text-caption font-semibold text-oai-gray-600 dark:text-oai-gray-300 hover:text-oai-black dark:hover:text-oai-white transition-colors"
                      >
                        <span className="inline-flex items-center gap-1">
                          <span>{column.label}</span>
                          <span className="text-oai-gray-400 dark:text-oai-gray-400">
                            {dailyBreakdownSortIconFor?.(column.key) || ""}
                          </span>
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dailyBreakdownRows.map((row) => (
                  <tr
                    key={String(
                      row?.[dailyBreakdownDateKey] || row?.day || row?.hour || row?.month || "",
                    )}
                    className={`border-b border-oai-gray-100 dark:border-oai-gray-800 last:border-b-0 hover:bg-oai-gray-50/50 dark:hover:bg-oai-gray-800/50 transition-colors ${
                      row.missing ? "text-oai-gray-400 dark:text-oai-gray-400" : row.future ? "text-oai-gray-300 dark:text-oai-gray-600" : "text-oai-black dark:text-oai-white"
                    }`}
                  >
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 whitespace-nowrap">
                      {renderDailyBreakdownDate ? renderDailyBreakdownDate(row) : renderDetailDate(row)}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm font-medium text-oai-black dark:text-oai-white tabular-nums">
                      {renderDetailCell(row, "total_tokens")}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "input_tokens")}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "output_tokens")}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "cached_input_tokens")}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "reasoning_output_tokens")}
                    </td>
                    <td className="px-2.5 sm:px-4 py-2 oai-text-body-sm text-oai-gray-600 dark:text-oai-gray-300 tabular-nums">
                      {renderDetailCell(row, "conversation_count")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}

          {/* Pagination - 使用 design system typography，Daily Breakdown 不需要分页 */}
          {activeTab !== "daily" && DETAILS_PAGED_PERIODS.has(period) && detailsPageCount > 1 ? (
            <div className="mt-3 flex items-center justify-between oai-text-caption">
              <button
                type="button"
                onClick={() => setDetailsPage((prev) => Math.max(0, prev - 1))}
                disabled={detailsPage === 0}
                className="px-3 py-1.5 text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {copy("details.pagination.prev")}
              </button>
              <span className="oai-text-muted">
                {detailsPage + 1} / {detailsPageCount}
              </span>
              <button
                type="button"
                onClick={() => setDetailsPage((prev) => Math.min(detailsPageCount - 1, prev + 1))}
                disabled={detailsPage + 1 >= detailsPageCount}
                className="px-3 py-1.5 text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {copy("details.pagination.next")}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
