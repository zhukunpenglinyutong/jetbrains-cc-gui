import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProviderDialog from './ProviderDialog';
import type { ProviderConfig } from '../types/provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.name ?? key,
  }),
}));

const createProvider = (): ProviderConfig => ({
  id: 'provider-zhipu',
  name: 'Zhipu',
  isActive: true,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'glm-4.7',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
    },
  },
});

const createCustomProxyProvider = (): ProviderConfig => ({
  id: 'provider-custom',
  name: 'My Proxy',
  isActive: true,
  settingsConfig: {
    env: {
      ANTHROPIC_BASE_URL: 'https://my-proxy.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_SMALL_FAST_MODEL: 'custom-haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus',
    },
  },
});

describe('ProviderDialog', () => {
  it('add mode shows official preset selected by default with model mapping visible', () => {
    render(
      <ProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    // Official preset should be present and selected
    expect(screen.getByRole('radio', { name: 'settings.provider.dialog.officialPreset' })).toBeTruthy();
    // Model mapping should be visible
    expect(screen.getByText('settings.provider.dialog.modelMapping')).toBeTruthy();
  });

  it('third-party preset still shows model mapping section', () => {
    render(
      <ProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    // Click a third-party preset (zhipu)
    const zhipuBtn = screen.getByRole('radio', { name: 'settings.provider.presets.zhipu' });
    fireEvent.click(zhipuBtn);

    // Model mapping should remain visible
    expect(screen.getByText('settings.provider.dialog.modelMapping')).toBeTruthy();
  });

  it('editing provider with unrecognized proxy URL still shows model mapping', () => {
    render(
      <ProviderDialog
        isOpen
        provider={createCustomProxyProvider()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    // Model mapping should be visible even for unrecognized proxy URLs
    expect(screen.getByText('settings.provider.dialog.modelMapping')).toBeTruthy();
    // Should have the custom model values populated
    expect((screen.getByLabelText('settings.provider.dialog.sonnetModel') as HTMLInputElement).value).toBe('custom-sonnet');
    expect((screen.getByLabelText('settings.provider.dialog.opusModel') as HTMLInputElement).value).toBe('custom-opus');
    expect((screen.getByLabelText('settings.provider.dialog.haikuModel') as HTMLInputElement).value).toBe('custom-haiku');
  });

  it('clearing model mapping fields should remove residual ANTHROPIC_MODEL on save', () => {
    const onSave = vi.fn();

    render(
      <ProviderDialog
        isOpen
        provider={createProvider()}
        onClose={vi.fn()}
        onSave={onSave}
        addToast={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.provider.dialog.sonnetModel'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('settings.provider.dialog.opusModel'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('settings.provider.dialog.haikuModel'), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.provider.dialog.saveChanges' }));

    expect(onSave).toHaveBeenCalledTimes(1);

    const payload = onSave.mock.calls[0]?.[0] as { jsonConfig: string };
    const parsed = JSON.parse(payload.jsonConfig);
    const env = parsed.env ?? {};

    expect(env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
  });
});
