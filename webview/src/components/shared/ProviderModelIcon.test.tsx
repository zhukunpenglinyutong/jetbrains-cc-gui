import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderModelIcon } from './ProviderModelIcon';

describe('ProviderModelIcon', () => {
  it('renders the Xiaomi MiMo icon for MiMo model IDs on Claude-compatible providers', () => {
    const { container } = render(
      <ProviderModelIcon providerId="claude" modelId="mimo-v2.5-pro" colored />,
    );

    expect(container.querySelector('[aria-label="XiaomiMiMo"]')).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('XiaomiMiMo');
  });
});
