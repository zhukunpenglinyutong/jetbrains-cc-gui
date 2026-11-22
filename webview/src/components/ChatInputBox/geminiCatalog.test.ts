import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  geminiDropdownGroupOfFor,
  geminiTierOf,
  resolveVanishedGeminiSelection,
} from './geminiCatalog';
import { GEMINI_DEFAULT_MODEL_ID, type ModelInfo } from './types';

const SERVICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'ai-bridge', 'services', 'gemini');

/**
 * The LIVE catalog capture (`agy models` stdout) — one `id<TAB>Label` pair per
 * line, shared with the ai-bridge parser tests so both sides of the channel
 * are pinned to the same fixture.
 */
const LIVE_CATALOG_LINES = readFileSync(join(SERVICE_DIR, 'fixtures', 'models-catalog.tsv'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.includes('\t'))
  .map((line) => {
    const [id, label] = line.split('\t');
    return { id: id.trim(), label: label.trim() };
  });

const AUTO_ENTRY: ModelInfo = {
  id: GEMINI_DEFAULT_MODEL_ID,
  label: 'Default (CLI)',
  description: 'Use the Antigravity CLI default model',
};

const catalog = (): ModelInfo[] => [AUTO_ENTRY, ...LIVE_CATALOG_LINES.map(({ id, label }) => ({ id, label }))];

describe('geminiTierOf — label-driven, not slug-driven', () => {
  it('recognizes tiers from the (High)/(Medium)/(Low) label suffix', () => {
    expect(geminiTierOf({ label: 'Gemini 3.7 Flash (High)' })).toBe('high');
    expect(geminiTierOf({ label: 'Gemini 3.1 Pro (Low)' })).toBe('low');
    expect(geminiTierOf({ label: 'GPT-OSS 120B (Medium)' })).toBe('medium');
  });

  it('does NOT infer a tier from slug suffixes — the two ambiguity exemplars', () => {
    // claude-opus-4-6-thinking: the slug's -thinking is not a tier, and the
    // (Thinking) label suffix is not one either.
    expect(geminiTierOf({ label: 'Claude Opus 4.6 (Thinking)' })).toBeNull();
    // claude-sonnet-4-6: no tier at all — the (Thinking) label is not a tier.
    expect(geminiTierOf({ label: 'Claude Sonnet 4.6 (Thinking)' })).toBeNull();
  });
});

describe('geminiDropdownGroupOfFor — section key per family label', () => {
  it('keys tiered entries on the tier-stripped family label', () => {
    const groupOf = geminiDropdownGroupOfFor(catalog());
    expect(groupOf({ id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' }))
      .toBe('Gemini 3.7 Flash');
    expect(groupOf({ id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' }))
      .toBe('Gemini 3.7 Flash');
  });

  it('gives tier-less entries and the auto sentinel their own sections', () => {
    const groupOf = geminiDropdownGroupOfFor(catalog());
    expect(groupOf({ id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' }))
      .toBe('Claude Opus 4.6 (Thinking)');
    expect(groupOf({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }))
      .toBe('Claude Sonnet 4.6 (Thinking)');
    expect(groupOf(AUTO_ENTRY)).toBe('Default (CLI)');
  });

  it('the slug-suffix ambiguity exemplar: gpt-oss-120b-medium is a real (Medium) tier', () => {
    // The slug says -medium AND the (Medium) label agrees — the label decides
    // the family shape, so this is one tiered family 'GPT-OSS 120B'.
    const groupOf = geminiDropdownGroupOfFor(catalog());
    expect(groupOf({ id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }))
      .toBe('GPT-OSS 120B');
  });

  it('keeps the live catalog unambiguous — no family ever needs a disambiguation suffix', () => {
    const groupOf = geminiDropdownGroupOfFor(catalog());
    for (const { id, label } of LIVE_CATALOG_LINES) {
      const group = groupOf({ id, label });
      // A disambiguated key would embed the family id in parens at the end.
      expect(group).not.toMatch(/\s\([a-z0-9-]+\)$/);
    }
  });

  it('splits two DIFFERENT families that share a label into honest sections', () => {
    // Same tier-stripped label 'Gemini X', different family ids — merging
    // them into one section would make a pick from the section ambiguous.
    const groupOf = geminiDropdownGroupOfFor([
      AUTO_ENTRY,
      { id: 'gemini-x-high', label: 'Gemini X (High)' },
      { id: 'gcp-x-low', label: 'Gemini X (Low)' },
    ]);
    expect(groupOf({ id: 'gemini-x-high', label: 'Gemini X (High)' })).toBe('Gemini X (gemini-x)');
    expect(groupOf({ id: 'gcp-x-low', label: 'Gemini X (Low)' })).toBe('Gemini X (gcp-x)');
  });

  it('does not disambiguate same-label entries that ARE one family', () => {
    // gemini-x-high / gemini-x-low share the family id 'gemini-x' — one
    // section, no suffix.
    const groupOf = geminiDropdownGroupOfFor([
      { id: 'gemini-x-high', label: 'Gemini X (High)' },
      { id: 'gemini-x-low', label: 'Gemini X (Low)' },
    ]);
    expect(groupOf({ id: 'gemini-x-high', label: 'Gemini X (High)' })).toBe('Gemini X');
    expect(groupOf({ id: 'gemini-x-low', label: 'Gemini X (Low)' })).toBe('Gemini X');
  });
});

describe('resolveVanishedGeminiSelection', () => {
  const available = catalog().map((m) => ({ id: m.id }));

  it('flags and snaps a persisted slug that the current catalog dropped', () => {
    expect(resolveVanishedGeminiSelection('gemini-9.9-flash-high', available, GEMINI_DEFAULT_MODEL_ID))
      .toEqual({ next: GEMINI_DEFAULT_MODEL_ID, vanished: true });
  });

  it('keeps a selection that still exists, and never touches empty input', () => {
    expect(resolveVanishedGeminiSelection('gemini-3.7-flash-high', available))
      .toEqual({ next: 'gemini-3.7-flash-high', vanished: false });
    expect(resolveVanishedGeminiSelection('', available))
      .toEqual({ next: '', vanished: false });
  });

  it('cannot judge against an empty catalog', () => {
    expect(resolveVanishedGeminiSelection('gemini-3.7-flash-high', []))
      .toEqual({ next: 'gemini-3.7-flash-high', vanished: false });
  });
});
