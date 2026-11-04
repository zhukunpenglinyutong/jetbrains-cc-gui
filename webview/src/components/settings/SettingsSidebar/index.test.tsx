import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsSidebar from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const renderSidebar = (isCollapsed: boolean) => render(
  <SettingsSidebar
    currentTab="basic"
    onTabChange={vi.fn()}
    isCollapsed={isCollapsed}
    onToggleCollapse={vi.fn()}
  />
);

describe('SettingsSidebar', () => {
  it('shows the translated item label in a tooltip when collapsed', async () => {
    renderSidebar(true);

    const basicItem = screen.getByRole('button', { name: 'settings.basic.title' });
    expect(basicItem.hasAttribute('title')).toBe(false);

    fireEvent.mouseEnter(basicItem);

    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('settings.basic.title');
    });
  });

  it('supports keyboard navigation for collapsed items', async () => {
    const onTabChange = vi.fn();
    render(
      <SettingsSidebar
        currentTab="basic"
        onTabChange={onTabChange}
        isCollapsed
        onToggleCollapse={vi.fn()}
      />
    );

    const providersItem = screen.getByRole('button', { name: 'settings.providers' });
    fireEvent.focus(providersItem);
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toContain('settings.providers');
    });

    fireEvent.keyDown(providersItem, { key: 'Enter' });
    expect(onTabChange).toHaveBeenCalledWith('providers');
  });
});
