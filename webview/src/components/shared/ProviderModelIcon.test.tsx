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

  it('renders the official Pi geometric mark for the pi CLI provider', () => {
    const { container } = render(
      <ProviderModelIcon providerId="pi" size={16} colored />,
    );

    expect(container.querySelector('[aria-label="Pi"]')).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('Pi');
    // Official path data from https://pi.dev/logo-auto.svg (P block + i-dot)
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    expect(paths[0]?.getAttribute('d')).toContain('165.29');
    expect(paths[1]?.getAttribute('d')).toContain('517.36');
  });

  it('renders the official OMP mark for the omp CLI provider', () => {
    const { container } = render(
      <ProviderModelIcon providerId="omp" size={16} colored />,
    );

    expect(container.querySelector('[aria-label="OMP"]')).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('OMP');
    // Official path data from https://omp.sh/favicon.svg
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(1);
    expect(paths[0]?.getAttribute('d')).toContain('M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z');
  });
});
