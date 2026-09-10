// Period/custom-range selection state and the resolved { from, to } range.
import { useCallback, useMemo, useState } from "react";
import { getRangeForPeriod } from "../lib/date-range";

export function useDashboardPeriod({ timeZone, tzOffsetMinutes, mockNow }) {
  const [selectedPeriod, setSelectedPeriod] = useState("day");
  const [customFrom, setCustomFrom] = useState(null);
  const [customTo, setCustomTo] = useState(null);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [prevPeriod, setPrevPeriod] = useState("day");
  const period = selectedPeriod;
  const range = useMemo(() => {
    if (period === "custom" && customFrom && customTo) {
      return { from: customFrom, to: customTo };
    }
    return getRangeForPeriod(period, {
      timeZone,
      offsetMinutes: tzOffsetMinutes,
      now: mockNow,
    });
  }, [mockNow, period, timeZone, tzOffsetMinutes, customFrom, customTo]);
  const from = range.from;
  const to = range.to;

  const handlePeriodChange = useCallback((p) => {
    if (p === "custom") {
      setPrevPeriod((prev) => (prev === "custom" ? "day" : prev));
      setSelectedPeriod((cur) => {
        // If already have custom dates, switch to custom immediately
        if (customFrom && customTo) return "custom";
        return cur;
      });
      setCustomRangeOpen(true);
    } else {
      setSelectedPeriod(p);
      setPrevPeriod(p);
      setCustomRangeOpen(false);
    }
  }, [customFrom, customTo]);

  const handleCustomRangeApply = useCallback((fromDate, toDate) => {
    setCustomFrom(fromDate);
    setCustomTo(toDate);
    setSelectedPeriod("custom");
    setCustomRangeOpen(false);
  }, []);

  const handleCustomRangeOpenChange = useCallback((open) => {
    setCustomRangeOpen(open);
    // If popover closed without applying and no custom dates exist, revert
    if (!open && selectedPeriod === "custom" && !customFrom) {
      setSelectedPeriod(prevPeriod);
    }
  }, [selectedPeriod, customFrom, prevPeriod]);

  return {
    period,
    from,
    to,
    customFrom,
    customTo,
    customRangeOpen,
    handlePeriodChange,
    handleCustomRangeApply,
    handleCustomRangeOpenChange,
  };
}
