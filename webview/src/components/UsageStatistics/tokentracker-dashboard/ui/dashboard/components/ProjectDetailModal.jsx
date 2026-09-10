import React from "react";
import { useProjectDetailDerived } from "./useProjectDetailDerived.js";
import { ProjectDetailModalFrame } from "./ProjectDetailModalFrame.jsx";
import { ProjectDetailSidePanel } from "./ProjectDetailSidePanel.jsx";
import { ProjectDetailContent } from "./ProjectDetailContent.jsx";

export function ProjectDetailModal({ entry, query = {}, onClose }) {
  const detail = useProjectDetailDerived({ entry, query });

  return (
    <ProjectDetailModalFrame projectKey={detail.projectKey} onClose={onClose}>
      <ProjectDetailSidePanel
        projectKey={detail.projectKey}
        owner={detail.owner}
        repo={detail.repo}
        projectRef={detail.projectRef}
        host={detail.host}
        data={detail.data}
        hasData={detail.hasData}
        totals={detail.totals}
        billableTotal={detail.billableTotal}
        shareRatio={detail.shareRatio}
        cacheHitRatio={detail.cacheHitRatio}
        daysActive={detail.daysActive}
        formatTokens={detail.formatTokens}
        formatTokensTooltip={detail.formatTokensTooltip}
      />

      <ProjectDetailContent
        loading={detail.loading}
        error={detail.error}
        hasData={detail.hasData}
        daily={detail.daily}
        totals={detail.totals}
        sources={detail.sources}
        totalTokens={detail.totalTokens}
        formatTokens={detail.formatTokens}
        formatTokensTooltip={detail.formatTokensTooltip}
      />
    </ProjectDetailModalFrame>
  );
}
