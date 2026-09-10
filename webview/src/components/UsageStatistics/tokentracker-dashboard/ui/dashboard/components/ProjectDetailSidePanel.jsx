import React from "react";
import { GitBranch } from "lucide-react";
import { copy } from "../../../lib/copy";
import { toDisplayNumber } from "../../../lib/format";
import { ProviderIcon } from "./ProviderIcon";
import {
  ProjectAvatar,
  forgeKindFromHost,
  githubOwnerFor,
} from "./project-usage-utils.jsx";
import { formatPercent } from "./projectDetailModalUtils.jsx";

// Shares the terminal-native inspection language of TrendMonitorZoomModal /
// the 3D heatmap insight modal, so every "zoom to inspect" surface reads as
// one family. ACCENT matches theirs.
const ACCENT = "#10b981";

// Zoom-modal stat vocabulary: micro mono label over a heavy mono figure.
function StatCell({ label, value, title }) {
  return (
    <div className="flex flex-col gap-1.5 group min-w-0">
      <span className="text-[9px] font-bold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span
        className="text-xl font-black font-mono text-zinc-900 dark:text-zinc-50 tracking-tight leading-none tabular-nums truncate transition-transform duration-200 group-hover:-translate-y-[1px]"
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

// Host brand mark instead of a bare hostname string; the full host stays
// reachable via the title tooltip. Brand marks come from the ProviderIcon
// registry; unknown self-hosted forges get a neutral git glyph rather than
// a wrong brand.
function HostIcon({ host }) {
  if (!host) return null;
  let icon;
  const forge = forgeKindFromHost(host);
  if (forge === "github" || forge === "gitlab") {
    icon = <ProviderIcon provider={forge} size={12} className="fill-current" />;
  } else {
    icon = <GitBranch size={12} />;
  }
  return (
    <span title={host} aria-label={host} className="inline-flex flex-shrink-0 items-center">
      {icon}
    </span>
  );
}

// Left: identity + aggregate stats — terminal-native panel language.
export function ProjectDetailSidePanel({
  projectKey,
  owner,
  repo,
  projectRef,
  host,
  data,
  hasData,
  totals,
  billableTotal,
  shareRatio,
  cacheHitRatio,
  daysActive,
  formatTokens,
  formatTokensTooltip,
}) {
  return (
    <div className="w-full md:w-[300px] shrink-0 border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-5 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">
      <div className="select-none">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: ACCENT }} />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: ACCENT }} />
          </span>
          <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
            {copy("dashboard.projects.detail.badge")}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-3 min-w-0">
          <ProjectAvatar
            githubOwner={githubOwnerFor(projectRef, owner)}
            letter={(repo?.[0] || projectKey?.[0] || "?").toUpperCase()}
            size="w-10 h-10"
          />
          <div className="min-w-0">
            {owner ? (
              <p className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 truncate leading-tight">
                {owner}/
              </p>
            ) : null}
            <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-tight truncate">
              {repo || projectKey || "—"}
            </h4>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 dark:text-zinc-500 leading-relaxed">
          <HostIcon host={host} />
          {host && data?.from && data?.to ? <span>·</span> : null}
          {data?.from && data?.to ? (
            <span className="tabular-nums">{data.from} – {data.to}</span>
          ) : null}
        </div>
      </div>

      {hasData ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-t border-zinc-200/50 dark:border-zinc-800/50 pt-5 select-none">
          <StatCell
            label={copy("dashboard.projects.detail.stat_total")}
            value={formatTokens(billableTotal)}
            title={formatTokensTooltip(billableTotal)}
          />
          <StatCell
            label={copy("dashboard.projects.detail.stat_share")}
            value={shareRatio == null ? "—" : formatPercent(shareRatio)}
          />
          <StatCell
            label={copy("dashboard.projects.detail.stat_cache_hit")}
            value={cacheHitRatio == null ? "—" : formatPercent(cacheHitRatio)}
          />
          <StatCell
            label={copy("dashboard.projects.detail.stat_conversations")}
            value={toDisplayNumber(totals.conversation_count)}
          />
          <StatCell
            label={copy("dashboard.projects.detail.stat_active_days")}
            value={toDisplayNumber(daysActive)}
          />
          <StatCell
            label={copy("dashboard.projects.detail.stat_avg_day")}
            value={daysActive > 0 ? formatTokens(Math.round(billableTotal / daysActive)) : "—"}
          />
        </div>
      ) : null}
    </div>
  );
}
