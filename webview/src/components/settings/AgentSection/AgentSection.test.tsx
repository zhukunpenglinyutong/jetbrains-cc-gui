import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentSection from './index';
import type { AgentConfig } from '../../../types/agent';

/**
 * The stylesheet is read rather than imported so a selector can be asserted
 * directly. CSS modules are otherwise opaque in jsdom, which would let a
 * renamed class pass unnoticed.
 */
const openFileMock = vi.fn();
// Stands in for the bridge, so a search that grew one would be visible here.
const sendToJavaMock = vi.fn();

const styles = readFileSync('src/components/settings/AgentSection/style.module.less', 'utf8');

const translations: Record<string, string> = {
  'settings.agent.title': 'Prompts',
  'settings.agent.customAgents': 'Custom Prompts',
  'settings.agent.claudeCodeSubagents': 'Claude Code Subagents',
  'settings.agent.noAgents': 'No custom prompts',
  'settings.agent.loading': 'Loading...',
  'settings.agent.menu': 'Menu',
  'settings.agent.create': 'Create',
  'settings.agent.export': 'Export',
  'settings.agent.import': 'Import',
  'settings.agent.scopeGlobal': 'Global',
  'settings.agent.scopeLocal': 'Local',
  'settings.agent.scopeStore': 'Plugin store',
  'settings.agent.totalCount': 'Total',
  'settings.agent.refresh': 'Refresh',
  'settings.agent.openFile': 'Open in editor',
  'settings.agent.openAtLine': 'Open {{path}} at line {{line}}',
  'settings.agent.searchPlaceholder': 'Search prompts',
  'settings.agent.searchClear': 'Clear search',
  'settings.agent.noSearchResults': 'Nothing matches “{{query}}”',
  'settings.agent.matchCount': '{{shown}} of {{total}}',
  'settings.agent.readOnly': 'Read-only',
  'settings.agent.readOnlyHint': 'Discovered from a Claude Code agent file.',
  'settings.agent.disabled': 'Blocked',
  'settings.agent.showDetails': 'Details',
  'settings.agent.hideDetails': 'Hide details',
  'settings.agent.notSpecified': 'not specified',
  'settings.agent.toolsSummaryNone': 'no tools',
  'settings.agent.toolsSummaryNamed': '{{count}} tools',
  'settings.agent.toolsSummaryNamed_one': '{{count}} tool',
  'settings.agent.disallowedSummary': '{{count}} tools blocked',
  'settings.agent.disallowedSummary_one': '{{count}} tool blocked',
  'settings.agent.permissionSummary': '{{mode}} permissions',
  'settings.agent.backgroundSummary': 'runs in background',
  'settings.agent.fieldModel': 'Model',
  'settings.agent.fieldDescription': 'Description',
  'settings.agent.fieldTools': 'Tools',
  'settings.agent.fieldDisallowedTools': 'Blocked tools',
  'settings.agent.fieldHooks': 'Hooks',
  'settings.agent.fieldMaxTurns': 'Max turns',
  'settings.agent.fieldPrompt': 'Prompt',
  'settings.agent.fieldPath': 'File',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
};

/**
 * Minimal i18next-compatible `t`.
 *
 * Plural handling matters here rather than being incidental: the feature
 * renders counts, and a stub that ignored the `_one`/`_other` suffix would let
 * a key wired to the wrong variant pass.
 */
function translate(key: string, options?: Record<string, unknown>): string {
  const resolved = (() => {
    if (!(options && typeof options.count === 'number')) return translations[key];

    // English rules are enough for the stub: one form for 1, another for the
    // rest. The assertion texts are what matter, not the real CLDR table.
    const suffix = options.count === 1 ? '_one' : '_other';
    return translations[`${key}${suffix}`] ?? translations[`${key}_other`] ?? translations[key];
  })();

  // A missing key renders as its own path, which is exactly the
  // half-translated state this feature must never ship, so the stub surfaces it
  // in the test output instead of hiding it.
  if (!resolved) return key;
  if (!options) return resolved;

  return Object.entries(options).reduce(
    (result, [token, value]) => result.replace(`{{${token}}}`, String(value)),
    resolved
  );
}

vi.mock('../../../utils/bridge', () => ({
  openFile: (path: string, line?: number) => openFileMock(path, line),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

/** A discovered, read-only agent as the backend returns it. */
const globalAgent: AgentConfig = {
  id: 'global-code-reviewer',
  name: 'code-reviewer',
  description: 'Reviews code before merge',
  model: 'sonnet',
  scope: 'global',
  source: 'global',
  readOnly: true,
  path: '/home/u/.claude/agents/code-reviewer.md',
};

/** A legacy store entry: no scope, no readOnly marker, editable as always. */
const storeAgent: AgentConfig = {
  id: 'store-1',
  name: 'my-prompt',
  prompt: 'Be concise',
  scope: 'store',
  readOnly: false,
};

function renderSection(overrides: Partial<React.ComponentProps<typeof AgentSection>> = {}) {
  const props: React.ComponentProps<typeof AgentSection> = {
    storeAgents: [],
    subagents: [],
    agentsLoading: false,
    subagentsLoading: false,
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    ...overrides,
  };
  return { props, ...render(<AgentSection {...props} />) };
}

/** Props for a direct render, for the cases that need to re-render mid-test. */
function baseProps(): React.ComponentProps<typeof AgentSection> {
  return {
    storeAgents: [],
    subagents: [],
    agentsLoading: false,
    subagentsLoading: false,
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
  };
}

describe('AgentSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('source badges', () => {
    /**
     * Scoped by test id, not by text: the tally above the list uses the same
     * words for the same three scopes, so a text query would match the tally
     * too and stop saying anything about the badge on the card.
     */
    const badges = () => screen.queryAllByTestId('agent-scope-badge');

    it('shows a badge naming each of the three scopes', () => {
      renderSection({
        storeAgents: [storeAgent],
        subagents: [
          globalAgent,
          { ...globalAgent, id: 'local-1', name: 'local-one', scope: 'local', path: '/w/.claude/agents/local-one.md' },
        ],
      });

      // Store agents render first (Custom Agents section), then subagents (Claude Code Subagents section)
      expect(badges().map((b) => b.textContent)).toEqual(['Plugin store', 'Global', 'Local']);
    });

    it('omits the badge for a legacy entry that has no scope', () => {
      renderSection({ storeAgents: [{ id: 'legacy', name: 'legacy', prompt: 'x' }] });

      // The tally still names all three scopes; what is absent is the badge on
      // the card, because a scopeless record predates discovery and has no
      // source to name.
      expect(badges()).toHaveLength(0);
    });
  });

  describe('row content', () => {
    it('shows name, description and model', () => {
      renderSection({ subagents: [globalAgent] });

      expect(screen.getByText('code-reviewer')).toBeTruthy();
      expect(screen.getByText('Reviews code before merge')).toBeTruthy();
      expect(screen.getByText('Model: sonnet')).toBeTruthy();
    });

    it('summarizes the tools and permission configuration', () => {
      renderSection({
        subagents: [
          {
            ...globalAgent,
            tools: ['Read', 'Grep'],
            disallowedTools: ['Bash'],
            permissionMode: 'plan',
          },
        ],
      });

      // The three parts share one summary line, so they are asserted together
      // rather than through three separate queries against the same element.
      const summary = screen.getByText(/2 tools/);
      expect(summary.textContent).toBe('2 tools · 1 tool blocked · plan permissions');
    });

    it('reports an empty tool list rather than staying silent', () => {
      renderSection({ subagents: [{ ...globalAgent, tools: [] }] });

      expect(screen.getByText('no tools')).toBeTruthy();
    });
  });

  describe('details view', () => {
    it('is collapsed until asked for', () => {
      renderSection({ subagents: [globalAgent] });

      expect(screen.getByText('Details')).toBeTruthy();
      expect(screen.queryByText('Max turns')).toBeNull();
    });

    it('renders every specification field, set or not', () => {
      const { container } = renderSection({
        subagents: [{ ...globalAgent, maxTurns: 12, tools: ['Read'], hooks: { PreToolUse: ['Bash'] } }],
      });

      fireEvent.click(screen.getByText('Details'));

      // A value that is set…
      expect(container.textContent).toContain('12');
      expect(container.textContent).toContain('PreToolUse');
      // …and one that is not, so an absent field is distinguishable from a
      // field the plugin failed to read.
      expect(container.textContent).toContain('Max turns');
      expect(container.textContent).toContain('not specified');
    });

    it('shows the file path of a discovered agent', () => {
      const { container } = renderSection({ subagents: [globalAgent] });

      fireEvent.click(screen.getByText('Details'));

      expect(container.textContent).toContain('/home/u/.claude/agents/code-reviewer.md');
    });

    it('collapses again on a second click', () => {
      renderSection({ subagents: [globalAgent] });

      fireEvent.click(screen.getByText('Details'));
      expect(screen.getByText('Hide details')).toBeTruthy();

      fireEvent.click(screen.getByText('Hide details'));
      expect(screen.getByText('Details')).toBeTruthy();
    });
  });

  describe('warnings', () => {
    it('renders a parser warning for a malformed entry', () => {
      const { container } = renderSection({
        subagents: [
          {
            id: 'global-broken',
            name: 'broken',
            scope: 'global',
            readOnly: true,
            path: '/home/u/.claude/agents/broken.md',
            warning: 'Could not parse frontmatter: unexpected end of file',
          },
        ],
      });

      expect(container.textContent).toContain('Could not parse frontmatter: unexpected end of file');
    });
  });

  describe('deny state', () => {
    it('marks a denied agent and explains why', () => {
      const { container } = renderSection({
        subagents: [
          {
            ...globalAgent,
            disabled: true,
            disabledReason: 'Blocked by permissions.deny: Agent(code-reviewer) in ~/.claude/settings.json',
          },
        ],
      });

      expect(screen.getByText('Blocked')).toBeTruthy();
      expect(container.textContent).toContain('permissions.deny: Agent(code-reviewer)');
    });

    it('does not mark an allowed agent', () => {
      renderSection({ subagents: [globalAgent] });

      expect(screen.queryByText('Blocked')).toBeNull();
    });
  });

  describe('search', () => {
    /** The three scopes' worth of names a search has to be able to reach. */
    const storeInventory: AgentConfig[] = [
      { ...storeAgent, id: 'store-1', name: 'my-prompt', prompt: 'Be extremely concise' },
    ];
    const subagentsInventory: AgentConfig[] = [
      globalAgent,                                   // code-reviewer
      { ...globalAgent, id: 'local-1', name: 'local-helper', scope: 'local', path: '/w/.claude/agents/local-helper.md' },
    ];

    const type = (value: string) => {
      // Target the subagent search box (second one) since we're testing subagent filtering
      const searchInputs = screen.getAllByPlaceholderText('Search prompts');
      fireEvent.change(searchInputs[1], { target: { value } });
    };

    const shownNames = () =>
      screen.queryAllByTestId('agent-scope-badge').length;

    it('narrows the subagent list by name (store agents are in separate section)', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('local-helper');

      // Subagent search filters only subagents
      expect(screen.getByText('local-helper')).toBeTruthy();
      // code-reviewer is a subagent but doesn't match "local-helper"
      expect(screen.queryByText('code-reviewer')).toBeNull();
      // my-prompt is a store agent in a different section - NOT filtered by subagent search
      expect(screen.getByText('my-prompt')).toBeTruthy();
    });

    it('matches on description and on prompt text, not just the name', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      // "before merge" is the description of the first subagent
      type('before merge');
      expect(screen.getByText('code-reviewer')).toBeTruthy();

      // "extremely concise" is in store agent prompt - NOT filtered by subagent search
      // But it would be found by the store agent search (separate search box)
      type('extremely concise');
      // Store agent is not affected by subagent search
      expect(screen.getByText('my-prompt')).toBeTruthy();
    });

    it('matches on the file name, so an agent can be found by where it lives', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('local-helper.md');

      expect(screen.getByText('local-helper')).toBeTruthy();
    });

    it('ignores case', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('CODE-REVIEWER');

      expect(screen.getByText('code-reviewer')).toBeTruthy();
      expect(screen.queryByText('local-helper')).toBeNull();
    });

    /** A stray space must not silently empty a list of a hundred agents. */
    it('treats a whitespace-only query as no query', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('   ');

      // Both store agents (1) and subagents (2) should be visible
      expect(shownNames()).toBe(3);
      expect(screen.queryByTestId('agent-no-matches')).toBeNull();
    });

    /**
     * The tally keeps describing the whole inventory; the narrowing is reported
     * separately. Were the total to follow the filter, "Total" would stop
     * answering the question its label asks.
     */
    it('reports how many matched without changing the tally', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('local-helper');

      // Match count for subagent section has data-testid="subagent-match-count"
      expect(screen.getByTestId('subagent-match-count').textContent).toBe('1 of 2');
      // Scope counts for subagents section (second set of counts)
      const globalCounts = screen.getAllByTestId('count-global');
      expect(globalCounts[1].textContent).toContain('Global1');
    });

    it('hides the match count when nothing is typed', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      // Both match counts should be hidden
      const matchCounts = screen.queryAllByTestId('agent-match-count');
      expect(matchCounts.length).toBe(0);
      expect(screen.queryByTestId('subagent-match-count')).toBeNull();
    });

    /**
     * Distinct from "you have no agents": here the fix is to change the query,
     * so the empty state offers that rather than the create button.
     */
    it('offers to clear the query when nothing matched', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('nothing-is-called-this');

      const empty = screen.getByTestId('agent-no-matches');
      expect(empty).toBeTruthy();
      // Scoped to the empty state on purpose: the header's Create button is
      // always present and always correct. What must not appear HERE is an
      // offer to create a prompt — the inventory is full and the query is what
      // came up empty, so the action that helps is changing the query.
      expect(empty.querySelector('button')?.textContent).toBe('Clear search');
      fireEvent.click(screen.getByTestId('agent-no-matches-clear'));
      expect(shownNames()).toBe(3);
    });

    it('restores the full list when the query is cleared with the button', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });
      type('local-helper');

      // Use the subagent clear button (second one)
      const clearButtons = screen.getAllByTestId('subagent-search-clear');
      fireEvent.click(clearButtons[0]);

      expect(shownNames()).toBe(3);
    });

    it('shows no clear button until there is something to clear', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      // Subagent clear button should be hidden initially
      expect(screen.queryByTestId('subagent-search-clear')).toBeNull();
      type('code');
      // Subagent clear button should appear when searching subagents
      expect(screen.getByTestId('subagent-search-clear')).toBeTruthy();
    });

    /**
     * The list is the only thing that narrows. The inventory has already been
     * resolved, so a search must not trigger a reload — a fresh scan on every
     * keystroke would make the results flicker between scopes.
     */
    it('does not ask the backend for anything', () => {
      renderSection({ storeAgents: storeInventory, subagents: subagentsInventory });

      type('code');

      // Nothing in this component sends a message at all; the assertion is that
      // the component never grew a bridge import for filtering.
      expect(sendToJavaMock).not.toHaveBeenCalled();
    });
  });

  describe('the per-scope tally', () => {
    /**
     * The labels are the same words as the per-card badges, so these are
     * scoped by test id rather than by text: a text query would match both and
     * say nothing about which one is being read.
     */
    const counts = (index = 0) => screen.getAllByTestId('agent-scope-counts')[index];
    const scopeCount = (scope: 'global' | 'local' | 'store', index = 0) =>
      screen.getAllByTestId(`count-${scope}`)[index]?.textContent ?? '';

    it('counts each scope and totals them per section', () => {
      renderSection({
        storeAgents: [storeAgent],
        subagents: [
          globalAgent,
          { ...globalAgent, id: 'local-1', name: 'l', scope: 'local' },
        ],
      });

      // Store agents section (index 0): 1 store agent
      expect(scopeCount('store', 0)).toContain('Plugin store1');
      expect(counts(0).textContent).toContain('Total1');

      // Subagents section (index 1): 1 global, 1 local
      expect(scopeCount('global', 1)).toContain('Global1');
      expect(scopeCount('local', 1)).toContain('Local1');
      expect(counts(1).textContent).toContain('Total2');
    });

    /**
     * The counts come from the resolved list, so a name defined in two places
     * is counted once. Tallying per source instead would make the numbers
     * disagree with the rows on screen, and a user would have no way to tell
     * that shadowing had hidden a definition.
     */
    it('counts a shadowed name once, under the scope that won', () => {
      renderSection({
        // Three rows on screen even though a fourth definition is shadowed.
        storeAgents: [storeAgent, { ...storeAgent, id: 's2', name: 'second' }],
        subagents: [globalAgent],
      });

      // Store agents section (index 0): 2 store agents
      expect(scopeCount('store', 0)).toContain('Plugin store2');
      expect(counts(0).textContent).toContain('Total2');

      // Subagents section (index 1): 1 global
      expect(scopeCount('global', 1)).toContain('Global1');
      expect(counts(1).textContent).toContain('Total1');
    });

    /** A legacy entry from before discovery has no scope; it lives in the store. */
    it('counts a scopeless legacy entry as store', () => {
      renderSection({ storeAgents: [{ id: 'legacy', name: 'legacy', prompt: 'x' }] });

      expect(scopeCount('store', 0)).toContain('Plugin store1');
      expect(counts().textContent).toContain('Total1');
    });

    it('shows a zero rather than hiding a scope with nothing in it', () => {
      renderSection({ storeAgents: [storeAgent] });

      // Hiding empty scopes would make the tally move around between opens.
      expect(scopeCount('global')).toContain('Global0');
      expect(scopeCount('local')).toContain('Local0');
    });

    it('shows nothing when there is nothing to count', () => {
      renderSection({ storeAgents: [], subagents: [] });

      expect(screen.queryByTestId('agent-scope-counts')).toBeNull();
    });
  });

  describe('opening the agent file', () => {
    const broken: AgentConfig = {
      id: 'global-broken',
      name: 'broken',
      scope: 'global',
      readOnly: true,
      path: '/home/u/.claude/agents/broken.md',
      warning: 'invalid YAML in the frontmatter of broken.md: found duplicate key name',
      warningLine: 3,
    };

    const link = () => screen.getByLabelText('Open in editor');

    /**
     * The point of the control. A file-backed agent cannot be edited here —
     * the plugin does not write to a discovery root — so opening the file is
     * the only way to change one, and it must not be scoped to the broken case.
     */
    it('offers the file for a healthy agent too', () => {
      renderSection({ subagents: [globalAgent] });

      fireEvent.click(link());

      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/code-reviewer.md', undefined);
    });

    it('jumps to the line the backend blamed when there is one', () => {
      renderSection({ subagents: [broken] });

      fireEvent.click(link());

      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', 3);
    });

    it('shows which line it will open at', () => {
      const { container } = renderSection({ subagents: [broken] });

      expect(container.textContent).toContain(':3');
    });

    it('shows the file name', () => {
      renderSection({ subagents: [globalAgent] });

      expect(screen.getByText('code-reviewer.md')).toBeTruthy();
    });

    /**
     * A store entry has no file behind it. A dead link is worse than none,
     * because it looks like the thing you want and does nothing.
     */
    it('offers nothing for a store entry', () => {
      renderSection({ agents: [storeAgent] });

      expect(screen.queryByLabelText('Open in editor')).toBeNull();
      expect(openFileMock).not.toHaveBeenCalled();
    });

    /**
     * The file row inside Details is the same action as the row control, not a
     * second one. A user who opened Details to inspect an agent should find the
     * open button there without going back up.
     */
    it('is offered again from inside Details', () => {
      renderSection({ subagents: [globalAgent] });

      fireEvent.click(screen.getByText('Details'));
      fireEvent.click(screen.getByLabelText('Open in editor'));

      expect(openFileMock).toHaveBeenCalledWith(
        '/home/u/.claude/agents/code-reviewer.md',
        undefined
      );
    });

    /**
     * A broken agent gets both halves: the explanation, and a link that lands
     * on the offending line. The link moved out of the warning block to the
     * action row so that a healthy agent has one too — that is the case the
     * control actually exists for.
     */
    it('shows the explanation and the link together for a broken agent', () => {
      renderSection({ subagents: [broken] });

      expect(screen.getByTestId('agent-warning').textContent).toContain(
        'invalid YAML in the frontmatter of broken.md'
      );
      expect(link()).toBeTruthy();
    });
  });

  describe('read-only agents', () => {
    it('shows no edit or delete action, and no kebab menu', () => {
      const { container } = renderSection({ subagents: [globalAgent] });

      expect(screen.queryByText('Edit')).toBeNull();
      expect(screen.queryByText('Delete')).toBeNull();
      expect(container.querySelectorAll(`.${'menuButton'}`).length).toBe(0);
    });

    it('marks the read-only badge so the restriction is visible', () => {
      renderSection({ subagents: [globalAgent] });

      expect(screen.getByText('Read-only')).toBeTruthy();
    });
  });

  describe('store agents', () => {
    it('keeps edit and delete available', () => {
      renderSection({ storeAgents: [storeAgent] });

      fireEvent.click(screen.getByTitle('Menu'));

      expect(screen.getByText('Edit')).toBeTruthy();
      expect(screen.getByText('Delete')).toBeTruthy();
    });

    it('invokes the edit callback with the agent', () => {
      const onEdit = vi.fn();
      renderSection({ storeAgents: [storeAgent], onEdit });

      fireEvent.click(screen.getByTitle('Menu'));
      fireEvent.click(screen.getByText('Edit'));

      expect(onEdit).toHaveBeenCalledWith(storeAgent);
    });
  });


  describe('empty and loading states', () => {
    it('shows the empty state when discovery finds nothing at all', () => {
      renderSection({ storeAgents: [], subagents: [] });

      // Both sections show the empty state
      const emptyStates = screen.getAllByText('No custom prompts');
      expect(emptyStates.length).toBe(2);
    });

    it('shows the loading state instead of a stale list', () => {
      renderSection({ storeAgents: [storeAgent], agentsLoading: true });

      expect(screen.getByText('Loading...')).toBeTruthy();
      expect(screen.queryByText('my-prompt')).toBeNull();
    });
  });

  describe('the refresh button', () => {
    /** Icon-only, so it costs ~32px rather than the ~90px a label would add. */
    const button = () => screen.getByLabelText('Refresh');

    it('asks for a re-read', () => {
      const onRefresh = vi.fn();
      renderSection({ agents: [globalAgent], onRefresh });

      fireEvent.click(button());

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('stays in the title row, with the other short actions', () => {
      renderSection({ agents: [globalAgent] });

      const actions = screen.getByTestId('agent-header-actions');
      expect(actions.contains(button())).toBe(true);
    });

    /**
     * Spins while the re-read is in flight, and stops when the answer lands.
     * The spinner is on the icon rather than over the list, because the user
     * who pressed it has a list in front of them.
     */
    it('spins while in flight and stops when the answer arrives', () => {
      const { rerender } = render(
        <AgentSection {...baseProps()} agents={[globalAgent]} refreshing />
      );
      expect(button().querySelector('.codicon-modifier-spin')).toBeTruthy();
      expect(button().disabled).toBe(true);

      rerender(<AgentSection {...baseProps()} agents={[globalAgent]} refreshing={false} />);
      expect(button().querySelector('.codicon-modifier-spin')).toBeNull();
      expect(button().disabled).toBe(false);
    });

    /**
     * A second press while one is in flight would queue a second scan of a few
     * hundred files for no benefit.
     */
    it('cannot be pressed twice in flight', () => {
      const onRefresh = vi.fn();
      renderSection({ agents: [globalAgent], onRefresh, refreshing: true });

      fireEvent.click(button());

      expect(onRefresh).not.toHaveBeenCalled();
    });
  });

  describe('layout', () => {
    /**
     * The filter moved to its own row because it does not fit beside the
     * action buttons. Asserted structurally rather than by width, since jsdom
     * has no layout engine: what matters is that it is a sibling of the title
     * row rather than a child of the action group, so the row cannot silently
     * reflow into one line again.
     */
    it('puts the filter on its own row', () => {
      renderSection({ storeAgents: [], subagents: [globalAgent] });

      const secondary = screen.getByTestId('agent-header-secondary');
      const actions = screen.getByTestId('agent-header-actions');
      // Use the first search input (store agents section header)
      const search = screen.getAllByPlaceholderText('Search prompts')[0];

      expect(secondary.contains(search)).toBe(true);
      expect(secondary.previousElementSibling).toBe(actions.parentElement);
      expect(secondary.contains(actions)).toBe(false);
      expect(actions.textContent).not.toContain('Search prompts');
    });

    it('keeps the short actions in the title row', () => {
      renderSection({ agents: [globalAgent] });
      const actions = screen.getByTestId('agent-header-actions');

      expect(actions.textContent).toContain('Export');
      expect(actions.textContent).toContain('Import');
      expect(actions.textContent).toContain('Create');
    });
  });

  describe('styling', () => {
    it('keeps the read-only and disabled modifiers in the stylesheet', () => {
      // A class referenced from the component but absent from the Less file
      // renders unstyled in production and no other test would notice.
      for (const className of ['readOnlyBadge', 'disabledBadge', 'scopeBadge', 'iconButton', 'fileLink', 'scopeCounts', 'headerSecondary', 'secondaryLeft', 'searchBox', 'searchInput', 'searchClear', 'matchCount']) {
        expect(styles).toContain(`.${className}`);
      }
    });
  });

  describe('the line a warning link jumps to', () => {
    const broken: AgentConfig = {
      id: 'global-broken',
      name: 'broken',
      scope: 'global',
      readOnly: true,
      path: '/home/u/.claude/agents/broken.md',
      warning: 'invalid YAML in the frontmatter of broken.md',
    };

    /** The row link, and — once opened — the same action inside Details. */
    const rowLink = () => screen.getByLabelText('Open in editor');
    const detailsLink = () => {
      const links = screen.getAllByLabelText('Open in editor');
      return links[links.length - 1];
    };
    const openDetails = () => fireEvent.click(screen.getByText('Details'));

    it('asks the editor for a positive integer line', () => {
      renderSection({ subagents: [{ ...broken, warningLine: 7 }] });

      fireEvent.click(rowLink());

      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', 7);
    });

    /**
     * A fractional line would become a "broken.md:2.5" locator the backend
     * cannot resolve: the editor opens the file and the jump is silently lost.
     * Treating it as no line at all degrades to the honest behaviour — open the
     * file, let the user find the problem.
     */
    it('drops a fractional line instead of requesting a jump that cannot land', () => {
      const { container } = renderSection({ subagents: [{ ...broken, warningLine: 2.5 }] });

      fireEvent.click(rowLink());

      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', undefined);
      // The label must not advertise a line it is not going to open.
      expect(container.textContent).not.toContain('2.5');
    });

    it('drops a line that is not positive', () => {
      for (const warningLine of [0, -1]) {
        vi.clearAllMocks();
        const { unmount } = renderSection({ subagents: [{ ...broken, warningLine }] });

        fireEvent.click(screen.getByLabelText('Open in editor'));

        expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', undefined);
        unmount();
      }
    });

    /**
     * The File row in Details is the same action, so it has to reach the same
     * decision — a rule fixed in one place and not the other would leave the
     * user with two buttons on one agent that disagree about where it opens.
     */
    it('applies the same rule to the File row inside Details', () => {
      const withLine = renderSection({ subagents: [{ ...broken, warningLine: 4 }] });
      openDetails();
      fireEvent.click(detailsLink());
      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', 4);
      withLine.unmount();

      vi.clearAllMocks();
      renderSection({ subagents: [{ ...broken, warningLine: 2.5 }] });
      openDetails();
      fireEvent.click(detailsLink());
      expect(openFileMock).toHaveBeenCalledWith('/home/u/.claude/agents/broken.md', undefined);
    });
  });

  /**
   * The i18n layer is configured with `escapeValue: false`, which is correct
   * because React escapes on render — but it means React is the ONLY thing
   * standing between a Markdown file the user did not write and this webview,
   * which holds a bridge with full access to the plugin. A single raw-HTML
   * render — most likely the first Markdown renderer anyone adds here — turns
   * that into stored XSS with the plugin's own privileges.
   *
   * So the invariant is asserted mechanically rather than left to review: no
   * production file in this section may contain the prop at all.
   */
  describe('raw HTML rendering', () => {
    // Assembled at runtime so this test file cannot trip its own scan, and so
    // the check survives a rename of the exclusion rules below.
    const FORBIDDEN = 'dangerously' + 'SetInnerHTML';

    const SECTION_DIR = dirname(fileURLToPath(import.meta.url));

    const SKIP_FILE = /(\.(test|spec|stories)\.[jt]sx?$)|(\.d\.ts$)|(\.snap$)/i;
    const SKIP_DIR = /^(__snapshots__|__fixtures__|__mocks__|node_modules)$/i;

    /** Recursively collect the production sources — and only those. */
    function productionSources(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIR.test(entry.name) ? [] : productionSources(full);
        if (SKIP_FILE.test(entry.name)) return [];
        if (!/\.[jt]sx?$/.test(entry.name)) return [];
        return [full];
      });
    }

    /** Every `<file>:<line>` in `dir` that contains the forbidden prop. */
    function violations(dir: string): string[] {
      return productionSources(dir).flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((text, index) =>
            text.includes(FORBIDDEN) ? `${relative(dir, file)}:${index + 1}` : null
          )
          .filter((hit): hit is string => hit !== null)
      );
    }

    it('holds across every production file in the section', () => {
      // Sanity first: an empty file list would make this pass while checking
      // nothing, which is the failure mode a scan-based test is most prone to.
      expect(productionSources(SECTION_DIR).length).toBeGreaterThan(2);

      expect(violations(SECTION_DIR)).toEqual([]);
    });

    it('actually fails when a source does use the prop', () => {
      // The other half of the check: a scanner that never reports anything
      // would satisfy the test above without protecting anything.
      const dir = mkdtempSync(join(tmpdir(), 'agent-section-scan-'));
      try {
        writeFileSync(
          join(dir, 'MarkdownPreview.tsx'),
          [
            'export function Preview({ html }: { html: string }) {',
            `  return <div ${FORBIDDEN}={{ __html: html }} />;`,
            '}',
            '',
          ].join('\n')
        );

        const found = violations(dir);
        expect(found).toHaveLength(1);
        // Reported as a path and a line, so the failure is actionable.
        expect(found[0]).toMatch(/MarkdownPreview\.tsx:2$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays quiet on a source that renders the same value as text', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-section-scan-'));
      try {
        writeFileSync(
          join(dir, 'PlainPreview.tsx'),
          'export const Preview = ({ text }: { text: string }) => <p>{text}</p>;\n'
        );

        expect(violations(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
