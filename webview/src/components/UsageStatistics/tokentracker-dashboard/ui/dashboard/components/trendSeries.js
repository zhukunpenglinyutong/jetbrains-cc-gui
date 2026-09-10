// Pure series math for TrendMonitor: y-axis scaling with outlier clipping,
// per-row value extraction, and gap interpolation/extrapolation for
// missing/future bars. Kept dependency-free so both the component and unit
// tests can import it without pulling in React.

function interpolateQuantile(sortedValues, ratio) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

export function getTrendMonitorScale(values) {
  const finiteValues = Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
    : [];

  if (finiteValues.length === 0) {
    return {
      rawMax: 0,
      effectiveMax: 1,
      clippedValues: Array.isArray(values) ? values.map(() => 0) : [],
    };
  }

  const rawMax = finiteValues.at(-1) ?? 0;
  let effectiveMax = rawMax;

  if (finiteValues.length >= 4) {
    const q1 = interpolateQuantile(finiteValues, 0.25);
    const q3 = interpolateQuantile(finiteValues, 0.75);
    const iqr = Math.max(q3 - q1, 0);
    const upperWhisker = q3 + iqr * 1.5;
    const hasOutlier = rawMax > upperWhisker;

    if (hasOutlier) {
      effectiveMax = Math.max(upperWhisker, q3, 1);
    }
  }

  return {
    rawMax,
    effectiveMax: Math.max(effectiveMax, 1),
    clippedValues: Array.isArray(values)
      ? values.map((value) => {
          if (!Number.isFinite(value) || value <= 0) return 0;
          return Math.min(value, Math.max(effectiveMax, 1));
        })
      : [],
  };
}

// Extract numeric tokens from a row, or null if the row carries no observation
// (missing/future, no field, or non-finite). Real zeros stay as `0` — they are
// observations, not gaps, and must NOT be interpolated over.
export function readRowValue(row) {
  if (row?.missing || row?.future) return null;
  const raw = row?.billable_total_tokens ?? row?.total_tokens ?? row?.value;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Predicted-bar curve tuning. We extrapolate at the mean of observed values
// and apply a mild decay across distance to suggest uncertainty without
// burying the bars. The nearest neighbour is intentionally NOT mixed in:
// the last real bar is often a partial current hour that would otherwise
// drag every future-hour prediction down for the rest of the day.
const EXTRAPOLATION_DECAY_PER_STEP = 0.98;

// Pure helper exported for unit testing. Returns one estimated value per index:
// observed values pass through unchanged; null gaps are linearly interpolated
// when bracketed by observations, and extrapolated at the mean of observed
// values with a mild distance-based decay when only one side has data.
// All-null input returns all zeros.
export function computeInterpolatedSeries(rawValues) {
  if (!Array.isArray(rawValues)) return [];
  const out = new Array(rawValues.length);
  for (let i = 0; i < rawValues.length; i++) {
    if (rawValues[i] !== null) {
      out[i] = rawValues[i];
      continue;
    }

    let leftVal = null;
    let leftIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (rawValues[j] !== null) {
        leftVal = rawValues[j];
        leftIdx = j;
        break;
      }
    }

    let rightVal = null;
    let rightIdx = -1;
    for (let j = i + 1; j < rawValues.length; j++) {
      if (rawValues[j] !== null) {
        rightVal = rawValues[j];
        rightIdx = j;
        break;
      }
    }

    if (leftVal !== null && rightVal !== null) {
      const ratio = (i - leftIdx) / (rightIdx - leftIdx);
      out[i] = leftVal + (rightVal - leftVal) * ratio;
    } else if (leftVal !== null) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j <= leftIdx; j++) {
        if (rawValues[j] !== null) {
          sum += rawValues[j];
          count += 1;
        }
      }
      const base = count > 0 ? sum / count : leftVal;
      out[i] = base * Math.pow(EXTRAPOLATION_DECAY_PER_STEP, i - leftIdx);
    } else if (rightVal !== null) {
      let sum = 0;
      let count = 0;
      for (let j = rightIdx; j < rawValues.length; j++) {
        if (rawValues[j] !== null) {
          sum += rawValues[j];
          count += 1;
        }
      }
      const base = count > 0 ? sum / count : rightVal;
      out[i] = base * Math.pow(EXTRAPOLATION_DECAY_PER_STEP, rightIdx - i);
    } else {
      out[i] = 0;
    }
  }
  return out;
}
