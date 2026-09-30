/**
 * Map an `x.ai/billing` ACP result onto the shared ContextBar capacity payload.
 * The agent returns one current period (weekly or monthly), not a 5h+7d pair.
 *
 * Wire result is the BillingConfigResponse itself (`ExtResponse` is transparent).
 * Also accepts `{ result: ... }` and `{ billing: ... }` envelopes.
 */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function centVal(cent) {
  const o = asObject(cent);
  if (!o) return null;
  return finiteNumber(o.val);
}

function unwrapBilling(raw) {
  let o = asObject(raw);
  if (!o) return null;
  if (asObject(o.billing)) o = o.billing;
  const nested = asObject(o.result);
  if (nested && (nested.config || nested.subscriptionTier || nested.subscription_tier)) {
    o = nested;
  }
  return o;
}

function unavailable(message) {
  return {
    present: false,
    unavailable: true,
    provider: 'grok',
    source: 'x.ai/billing',
    message: message || 'Grok usage unavailable',
  };
}

/**
 * @param {unknown} raw ACP `message.result` for `_x.ai/billing`
 * @returns {object} capacity payload consumed by `parseCapacityPayload`
 */
export function billingToCapacity(raw) {
  const billing = unwrapBilling(raw);
  if (!billing) {
    return unavailable('invalid billing payload');
  }
  const config = asObject(billing.config) || billing;

  let pct = finiteNumber(config.creditUsagePercent);
  if (pct == null) {
    const limit = centVal(config.monthlyLimit);
    const used = centVal(config.used);
    if (limit != null && limit > 0 && used != null) {
      pct = (used / limit) * 100;
    }
  }
  if (pct == null) {
    return unavailable('billing missing creditUsagePercent');
  }

  const period = asObject(config.currentPeriod);
  const resetAt = (period && typeof period.end === 'string' && period.end)
    || (typeof config.billingPeriodEnd === 'string' ? config.billingPeriodEnd : null);
  const periodStart = (period && typeof period.start === 'string' && period.start)
    || (typeof config.billingPeriodStart === 'string' ? config.billingPeriodStart : null);
  const periodType = period && typeof period.type === 'string' && period.type
    ? period.type
    : null;
  const windowId = periodType || 'current';

  const window = {
    id: windowId,
    used_pct: pct,
    period_type: periodType || windowId,
  };
  if (resetAt) window.reset_at = resetAt;

  const out = {
    ok: true,
    present: true,
    provider: 'grok',
    source: 'x.ai/billing',
    capacity_pct: pct,
    windows: [window],
  };
  if (resetAt) out.reset_at = resetAt;
  if (periodStart) out.period_start = periodStart;
  if (periodType) out.period_type = periodType;

  const tier = typeof billing.subscriptionTier === 'string'
    ? billing.subscriptionTier
    : typeof billing.subscription_tier === 'string'
      ? billing.subscription_tier
      : '';
  if (tier) out.level = tier;
  return out;
}
