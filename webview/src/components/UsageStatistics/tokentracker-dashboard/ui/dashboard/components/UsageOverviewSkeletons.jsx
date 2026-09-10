import React from "react";

export function SummaryValueSkeleton() {
  return (
    <div
      data-testid="usage-summary-skeleton"
      aria-hidden="true"
      className="mx-auto h-[58px] sm:h-[72px] w-[min(72vw,18rem)] rounded-2xl bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse motion-reduce:animate-none"
    />
  );
}

export function ProviderDistributionSkeleton() {
  return (
    <div
      data-testid="usage-provider-skeleton"
      aria-hidden="true"
      className="space-y-6"
    >
      <div className="h-1.5 w-full rounded-full bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse motion-reduce:animate-none" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-[92px] rounded-xl border border-oai-gray-100 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-800/60 animate-pulse motion-reduce:animate-none"
            style={{ animationDelay: `${index * 70}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
