/**
 * Pure helpers over the live Antigravity (`agy models`) catalog.
 *
 * The catalog pairs each model with an effort tier by baking the tier into
 * the full slug (`gemini-3.7-flash-high`) AND naming it in the human label
 * ("Gemini 3.7 Flash (High)"). The label is authoritative: slug suffixes are
 * ambiguous (`gpt-oss-120b-medium` really is a (Medium) tier, while
 * `claude-opus-4-6-thinking` carries `-thinking` but no tier at all).
 *
 * Grouping therefore keys on the label: an entry joins a family group iff
 * its label ends with (High)/(Medium)/(Low). The family id (slug minus the
 * tier tail) is only used to keep two DIFFERENT families that happen to
 * share a label in separate sections.
 */

import type { ModelInfo } from './types';
import { GEMINI_DEFAULT_MODEL_ID } from './types';

export type GeminiTier = 'high' | 'medium' | 'low';

const TIER_SUFFIXES: Array<[RegExp, GeminiTier]> = [
  [/\(high\)\s*$/i, 'high'],
  [/\(medium\)\s*$/i, 'medium'],
  [/\(low\)\s*$/i, 'low'],
];

/**
 * The effort tier an entry belongs to — recognized from the LABEL suffix
 * only, or null when the entry is tier-less.
 */
export function geminiTierOf(model: Pick<ModelInfo, 'label'>): GeminiTier | null {
  for (const [pattern, tier] of TIER_SUFFIXES) {
    if (pattern.test(model.label)) return tier;
  }
  return null;
}

function stripTierSuffix(label: string): string {
  return label.replace(/\s*\((?:high|medium|low)\)\s*$/i, '').trim();
}

function stripTierToken(slug: string, tier: GeminiTier): string {
  const suffix = `-${tier}`;
  return slug.toLowerCase().endsWith(suffix) ? slug.slice(0, -suffix.length) : slug;
}

/**
 * `buildModelDropdownSections` groupOf callback, bound to the catalog being
 * rendered: section per family, keyed by the tier-stripped family label.
 * The 'auto' sentinel is its own single-choice "Default (CLI)" section
 * instead of an anonymous bucket.
 *
 * The catalog argument also powers a collision guard: two DIFFERENT families
 * (tier-stripped slugs differ) whose labels collapse to the same section
 * key would silently merge into one section — each is disambiguated with its
 * family id so every section still means exactly one family.
 */
export function geminiDropdownGroupOfFor(models: ModelInfo[]): (model: ModelInfo) => string {
  const familyIdsByGroup = new Map<string, Set<string>>();
  for (const model of models) {
    if (model.id === GEMINI_DEFAULT_MODEL_ID) continue;
    const tier = geminiTierOf(model);
    const familyId = tier ? stripTierToken(model.id, tier) : model.id;
    const group = tier ? stripTierSuffix(model.label) : model.label;
    let familyIds = familyIdsByGroup.get(group);
    if (!familyIds) {
      familyIds = new Set();
      familyIdsByGroup.set(group, familyIds);
    }
    familyIds.add(familyId);
  }
  const ambiguousGroups = new Set(
    [...familyIdsByGroup.entries()]
      .filter(([, familyIds]) => familyIds.size > 1)
      .map(([group]) => group),
  );

  return (model: ModelInfo): string => {
    if (model.id === GEMINI_DEFAULT_MODEL_ID) {
      return model.label;
    }
    const tier = geminiTierOf(model);
    const familyId = tier ? stripTierToken(model.id, tier) : model.id;
    const group = tier ? stripTierSuffix(model.label) : model.label;
    return ambiguousGroups.has(group) ? `${group} (${familyId})` : group;
  };
}

/**
 * Vanished-persisted-selection resolution (AC5): a selection that is not in
 * the current catalog snaps to the fallback ('auto' = the CLI default) and is
 * flagged so the UI can say so out loud instead of correcting silently.
 * Empty/unknown-catalog inputs never "vanish" anything.
 */
export function resolveVanishedGeminiSelection(
  selectedId: string,
  availableModels: Array<Pick<ModelInfo, 'id'>>,
  fallbackId: string = GEMINI_DEFAULT_MODEL_ID,
): { next: string; vanished: boolean } {
  if (!selectedId || availableModels.length === 0) {
    return { next: selectedId, vanished: false };
  }
  const exists = availableModels.some((model) => model.id === selectedId);
  if (exists) {
    return { next: selectedId, vanished: false };
  }
  return { next: fallbackId, vanished: true };
}
