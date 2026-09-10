// Details-table state for DashboardPage: sort, pagination, daily-breakdown
// rows, and the cell/date render helpers handed to DashboardView.
import { useEffect, useMemo, useState } from "react";
import { copy } from "../lib/copy";
import { getDetailsSortColumns, sortDailyRows } from "../lib/daily";
import { DETAILS_PAGE_SIZE, paginateRows, trimLeadingZeroMonths } from "../lib/details";
import { toDisplayNumber } from "../lib/format";
import { selectDailyBreakdownRows } from "../lib/daily-breakdown";
import { DETAILS_DATE_KEYS, DETAILS_PAGED_PERIODS, getBillableTotal } from "./dashboardDataUtils.js";

export function useDashboardDetails({
  period,
  trendRows,
  daily,
  dailyBreakdownDaily,
  todayKey,
  formatTokens,
  formatTokensTooltip,
}) {
  const visibleDaily = useMemo(() => {
    return daily.filter((row) => {
      if (row?.future) return false;
      if (!row?.day || !todayKey) return true;
      return String(row.day) <= String(todayKey);
    });
  }, [daily, todayKey]);

  const detailsDateKey = useMemo(() => {
    if (period === "day") return "hour";
    if (period === "total") return "month";
    return "day";
  }, [period]);
  const detailsColumns = useMemo(() => getDetailsSortColumns(detailsDateKey), [detailsDateKey]);
  const dailyBreakdownDateKey = "day";
  const dailyBreakdownColumns = useMemo(() => getDetailsSortColumns(dailyBreakdownDateKey), []);
  const [sort, setSort] = useState(() => ({ key: "day", dir: "desc" }));
  useEffect(() => {
    setSort((prev) => {
      if (!DETAILS_DATE_KEYS.has(prev.key)) return prev;
      if (prev.key === detailsDateKey) return prev;
      return { key: detailsDateKey, dir: prev.dir };
    });
  }, [detailsDateKey]);
  const effectiveSort = useMemo(() => {
    if (DETAILS_DATE_KEYS.has(sort.key) && sort.key !== detailsDateKey) {
      return { ...sort, key: detailsDateKey };
    }
    return sort;
  }, [detailsDateKey, sort]);
  const detailsRows = useMemo(() => {
    if (period === "day") {
      return Array.isArray(trendRows) ? trendRows.filter((row) => row?.hour && !row?.future) : [];
    }
    if (period === "total") {
      const rows = Array.isArray(trendRows)
        ? trendRows.filter((row) => row?.month && !row?.future)
        : [];
      return trimLeadingZeroMonths(rows);
    }
    // 对于 week/month/all/today 等，优先使用 visibleDaily
    // 如果数据为空或全是 missing，回退到最近30天的 daily 数据
    const rows = visibleDaily;
    const hasActualData = rows.some((row) => !row?.missing && !row?.future);
    if (!hasActualData && daily.length > 0) {
      // 取最近30天有数据的记录
      return daily
        .filter((row) => !row?.future)
        .slice(-30)
        .filter((row) => row?.day);
    }
    return rows;
  }, [period, trendRows, visibleDaily, daily]);
  const sortedDetails = useMemo(
    () => sortDailyRows(detailsRows, effectiveSort),
    [detailsRows, effectiveSort],
  );
  const hasDetailsActual = useMemo(
    () => detailsRows.some((row) => !row?.missing && !row?.future),
    [detailsRows],
  );
  const detailsPageCount = useMemo(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return 1;
    const count = Math.ceil(sortedDetails.length / DETAILS_PAGE_SIZE);
    return count > 0 ? count : 1;
  }, [period, sortedDetails.length]);
  const [detailsPage, setDetailsPage] = useState(0);
  useEffect(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) {
      setDetailsPage(0);
      return;
    }
    setDetailsPage((prev) => Math.min(prev, detailsPageCount - 1));
  }, [detailsPageCount, period]);
  useEffect(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return;
    setDetailsPage(0);
  }, [period, sort.dir, sort.key]);
  const pagedDetails = useMemo(() => {
    if (!DETAILS_PAGED_PERIODS.has(period)) return sortedDetails;
    return paginateRows(sortedDetails, detailsPage, DETAILS_PAGE_SIZE);
  }, [detailsPage, period, sortedDetails]);

  // Regular periods show the last 30 calendar days. Total view uses the
  // selected history range and keeps the latest 30 observed days, so an idle
  // account does not look erased behind a screenful of missing rows.
  const dailyBreakdownRows = useMemo(() => {
    return selectDailyBreakdownRows(dailyBreakdownDaily, { period });
  }, [dailyBreakdownDaily, period]);
  const dailyBreakdownSort = useMemo(() => {
    if (DETAILS_DATE_KEYS.has(sort.key)) {
      return { ...sort, key: dailyBreakdownDateKey };
    }
    return sort;
  }, [sort]);
  const sortedDailyBreakdownRows = useMemo(
    () => sortDailyRows(dailyBreakdownRows, dailyBreakdownSort),
    [dailyBreakdownRows, dailyBreakdownSort],
  );

  function renderDetailCell(row, key) {
    if (row?.future) return "—";
    if (row?.missing) return copy("shared.status.unsynced");
    if (key.endsWith("_tokens")) {
      const value = key === "total_tokens" ? getBillableTotal(row) : row?.[key];
      return (
        <span title={formatTokensTooltip(value)}>
          {formatTokens(value)}
        </span>
      );
    }
    return toDisplayNumber(row?.[key]);
  }

  function renderDetailDate(row) {
    const raw = row?.[detailsDateKey];
    if (raw == null) return "";
    const value = String(raw);
    if (detailsDateKey === "hour") {
      const [datePart, timePart] = value.split("T");
      if (datePart && timePart) {
        return `${datePart} ${timePart.slice(0, 5)}`;
      }
    }
    return value;
  }

  function renderDailyBreakdownDate(row) {
    const raw = row?.[dailyBreakdownDateKey];
    return raw == null ? "" : String(raw);
  }

  function toggleSort(key) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "desc" };
    });
  }

  function ariaSortFor(key) {
    if (effectiveSort.key !== key) return "none";
    return effectiveSort.dir === "asc" ? "ascending" : "descending";
  }

  function sortIconFor(key) {
    if (effectiveSort.key !== key) return "";
    return effectiveSort.dir === "asc" ? "▲" : "▼";
  }

  function dailyAriaSortFor(key) {
    if (dailyBreakdownSort.key !== key) return "none";
    return dailyBreakdownSort.dir === "asc" ? "ascending" : "descending";
  }

  function dailySortIconFor(key) {
    if (dailyBreakdownSort.key !== key) return "";
    return dailyBreakdownSort.dir === "asc" ? "▲" : "▼";
  }

  return {
    detailsDateKey,
    detailsColumns,
    dailyBreakdownDateKey,
    dailyBreakdownColumns,
    hasDetailsActual,
    pagedDetails,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
    sortedDailyBreakdownRows,
    toggleSort,
    ariaSortFor,
    sortIconFor,
    dailyAriaSortFor,
    dailySortIconFor,
    renderDetailCell,
    renderDetailDate,
    renderDailyBreakdownDate,
  };
}
