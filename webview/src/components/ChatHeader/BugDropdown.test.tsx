/**
 * T3: BugDropdown rendering, filtering, keyboard navigation, and testing badge.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BugDropdown } from './BugDropdown';
import type { KnownBug } from '../../diagnostics/knownBugs';

// Mock sendBridgeEvent
vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

const SAMPLE_BUGS: KnownBug[] = [
  { id: 'B-004', label: 'ArrowUp cursor disappear', status: 'open', statusChangedOn: '2026-02-15' },
  { id: 'B-021', label: 'Chat scrolls up abruptly', status: 'testing', statusChangedOn: '2026-03-10' },
  { id: 'B-028', label: 'Assistant above user message', status: 'testing', statusChangedOn: '2026-03-10' },
  { id: 'B-006', label: 'Scroll-to-bottom no re-activate', status: 'open' },
  { id: 'B-007', label: 'Spellcheck in textarea', status: 'open' },
];

function createAnchorRef() {
  const button = document.createElement('button');
  document.body.appendChild(button);
  return { current: button };
}

describe('BugDropdown (T3)', () => {
  let anchorRef: React.RefObject<HTMLButtonElement>;

  beforeEach(() => {
    anchorRef = createAnchorRef();
    // Stub requestAnimationFrame for jsdom
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).setKnownBugs;
  });

  function renderAndLoadBugs(bugs: KnownBug[] = SAMPLE_BUGS) {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const result = render(
      <BugDropdown open={true} anchorRef={anchorRef} onSelect={onSelect} onClose={onClose} />
    );

    // Simulate Java response
    act(() => {
      (window as any).setKnownBugs?.(JSON.stringify(bugs));
    });

    return { onSelect, onClose, ...result };
  }

  it('renders nothing when closed', () => {
    const { container } = render(
      <BugDropdown open={false} anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows loading state initially', () => {
    render(
      <BugDropdown open={true} anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders bug list after setKnownBugs callback', () => {
    renderAndLoadBugs();
    expect(screen.getByText('B-004')).toBeTruthy();
    expect(screen.getByText('B-021')).toBeTruthy();
  });

  it('applies testing class to testing bug IDs', () => {
    renderAndLoadBugs();
    const b021 = screen.getByText('B-021');
    expect(b021.classList.contains('testing')).toBe(true);

    const b028 = screen.getByText('B-028');
    expect(b028.classList.contains('testing')).toBe(true);

    const b004 = screen.getByText('B-004');
    expect(b004.classList.contains('testing')).toBe(false);
  });

  it('does NOT render separate testing label', () => {
    renderAndLoadBugs();
    // The old "testing" label element should not exist
    const testingLabels = document.querySelectorAll('.bug-dropdown-item-status');
    expect(testingLabels.length).toBe(0);
  });

  it('filters bugs by ID', () => {
    renderAndLoadBugs();
    const input = screen.getByPlaceholderText('Filter bugs...');
    fireEvent.change(input, { target: { value: '021' } });

    expect(screen.getByText('B-021')).toBeTruthy();
    expect(screen.queryByText('B-004')).toBeNull();
  });

  it('filters bugs by label', () => {
    renderAndLoadBugs();
    const input = screen.getByPlaceholderText('Filter bugs...');
    fireEvent.change(input, { target: { value: 'spellcheck' } });

    expect(screen.getByText('B-007')).toBeTruthy();
    expect(screen.queryByText('B-004')).toBeNull();
  });

  it('shows empty state when filter matches nothing', () => {
    renderAndLoadBugs();
    const input = screen.getByPlaceholderText('Filter bugs...');
    fireEvent.change(input, { target: { value: 'zzzznonexistent' } });

    expect(screen.getByText('No matching bugs')).toBeTruthy();
  });

  it('limits display to 10 items', () => {
    const manyBugs = Array.from({ length: 15 }, (_, i) => ({
      id: `B-${String(i + 100).padStart(3, '0')}`,
      label: `Bug number ${i}`,
      status: 'open' as const,
    }));
    renderAndLoadBugs(manyBugs);

    const items = document.querySelectorAll('.bug-dropdown-item');
    expect(items.length).toBe(10);
  });

  it('calls onSelect and onClose on click', () => {
    const { onSelect, onClose } = renderAndLoadBugs();
    const b004 = screen.getByText('B-004').closest('.bug-dropdown-item')!;
    fireEvent.click(b004);

    expect(onSelect).toHaveBeenCalledWith('B-004');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const { onClose } = renderAndLoadBugs();
    const dropdown = document.querySelector('.bug-dropdown')!;
    fireEvent.keyDown(dropdown, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('navigates with arrow keys and selects with Enter', () => {
    const { onSelect, onClose } = renderAndLoadBugs();
    const dropdown = document.querySelector('.bug-dropdown')!;

    // Move down once
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' });
    // Now index 1 (B-021) is active → Enter
    fireEvent.keyDown(dropdown, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('B-021');
    expect(onClose).toHaveBeenCalled();
  });
});
