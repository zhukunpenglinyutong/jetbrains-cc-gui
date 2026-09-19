import { render } from '@testing-library/react';
import { DropdownItem } from './DropdownItem.js';

describe('DropdownItem content type marker', () => {
  it('shows a semantic type marker when provided by Codex completions', () => {
    const { container } = render(
      <DropdownItem
        item={{
          id: 'review-code',
          label: '$review-code',
          type: 'command',
          contentType: 'skill',
        }}
      />
    );

    expect(container.querySelector('.dropdown-item-type')?.textContent).toBe('skill');
  });

  it('does not show a type marker for existing non-Codex completion items', () => {
    const { container } = render(
      <DropdownItem
        item={{
          id: 'review',
          label: '/review',
          type: 'command',
        }}
      />
    );

    expect(container.querySelector('.dropdown-item-type')).toBeNull();
  });
});
