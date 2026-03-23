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
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
    },
  },
});

describe('ProviderDialog', () => {
  it('显示第三方自定义入口，选中后隐藏模型映射输入', () => {
    render(
      <ProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: 'settings.provider.presets.custom' })).toBeTruthy();
    expect(screen.getByText('settings.provider.dialog.modelMapping')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'settings.provider.presets.custom' }));

    expect(screen.queryByText('settings.provider.dialog.modelMapping')).toBeNull();
  });

  it('清空可见模型映射后，保存时应移除残留的全局 ANTHROPIC_MODEL', () => {
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
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });
});
