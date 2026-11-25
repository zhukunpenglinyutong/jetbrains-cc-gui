import type { ComponentProps } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonArea } from './ButtonArea';
import type { ModelInfo } from './types';

const tMock = vi.hoisted(() => ({
  t: (key: string, options?: { model?: string }) =>
    options?.model ? `${key}(${options.model})` : key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => tMock,
  // ButtonArea's import chain pulls in src/i18n/config.ts, which registers
  // this plugin even when tests never render through the i18n provider.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

/** Mutable snapshot of the cli-models state the real hook normally owns. */
const cliModelsState = vi.hoisted(() => ({
  models: [] as ModelInfo[],
  hasEntries: false,
  loading: false,
  defaultModel: null as string | null,
}));

vi.mock('../../hooks/providers/useCliModels', () => ({
  useCliModels: () => ({
    cliModels: cliModelsState.models,
    cliModelsLoading: cliModelsState.loading,
    cliModelsError: null,
    cliDefaultModel: cliModelsState.defaultModel,
    cliCatalogHasEntries: cliModelsState.hasEntries,
    refreshCliModels: () => {},
    modelsByProvider: {},
  }),
  useOmpRoles: () => [],
}));

// A live-catalog-shaped fixture: 'auto' first, then a tiered family. Deliberately
// without `gemini-9.9-flash-high` — the vanished persisted slug under test.
const LIVE_CATALOG: ModelInfo[] = [
  { id: 'auto', label: 'Default (CLI)', description: 'Use the Antigravity CLI default model' },
  { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
  { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
];

// Offline fallback (GEMINI_MODELS): only the 'auto' sentinel.
const FALLBACK_CATALOG: ModelInfo[] = [LIVE_CATALOG[0]];

function renderArea(props: Partial<ComponentProps<typeof ButtonArea>>) {
  const onModelSelect = vi.fn();
  const addToast = vi.fn();
  render(
    <ButtonArea
      currentProvider="gemini"
      selectedModel="auto"
      onModelSelect={onModelSelect}
      addToast={addToast}
      {...props}
    />,
  );
  return { onModelSelect, addToast };
}

describe('ButtonArea gemini vanished selection', () => {
  beforeEach(() => {
    cliModelsState.models = [];
    cliModelsState.hasEntries = false;
    cliModelsState.loading = false;
    cliModelsState.defaultModel = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('snaps a persisted slug missing from the live catalog back to auto and says so', () => {
    cliModelsState.models = LIVE_CATALOG;
    cliModelsState.hasEntries = true;
    cliModelsState.defaultModel = 'auto';

    const { onModelSelect, addToast } = renderArea({ selectedModel: 'gemini-9.9-flash-high' });

    expect(onModelSelect).toHaveBeenCalledWith('auto');
    expect(onModelSelect).not.toHaveBeenCalledWith('gemini-9.9-flash-high');
    expect(addToast).toHaveBeenCalledWith(
      'models.gemini.vanishedSelection(gemini-9.9-flash-high)',
      'warning',
    );
  });

  it('keeps a persisted slug that is still present in the live catalog', () => {
    cliModelsState.models = LIVE_CATALOG;
    cliModelsState.hasEntries = true;
    cliModelsState.defaultModel = 'auto';

    const { onModelSelect, addToast } = renderArea({ selectedModel: 'gemini-3.7-flash-low' });

    expect(onModelSelect).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('does not clobber the persisted slug while only the offline fallback is shown', () => {
    cliModelsState.models = FALLBACK_CATALOG;
    cliModelsState.hasEntries = false;
    cliModelsState.loading = true;

    const { onModelSelect, addToast } = renderArea({ selectedModel: 'gemini-9.9-flash-high' });

    expect(onModelSelect).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});
