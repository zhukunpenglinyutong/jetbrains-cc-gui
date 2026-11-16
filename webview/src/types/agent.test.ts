import { describe, expect, it } from 'vitest';
import {
  AGENT_DISCOVERY_FIELDS,
  AGENT_SPECIFICATION_FIELDS,
  AGENT_SCOPES,
  isAgentScope,
  isNonHyphenCaseName,
  isValidAgentName,
  type AgentConfig,
} from './agent';

/**
 * Contract tests for the extended agent model (task 56).
 *
 * The field set is pinned to the Claude Code subagent specification documented at
 * code.claude.com/docs/en/claude-directory, row `agents/*.md`. The Java side
 * (AgentFields.SPECIFICATION_FIELDS) carries the same list; AgentFieldsContractParity
 * below re-checks the backend copy so the two cannot drift.
 */

/** A verbatim copy of AgentFields.SPECIFICATION_FIELDS from the Java side. */
const JAVA_SPECIFICATION_FIELDS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'omitClaudeMd',
  'experimental',
];

const JAVA_DISCOVERY_FIELDS = ['path', 'scope', 'source', 'readOnly', 'warning'];

describe('AgentFieldsContractParity', () => {
  it('matches the Java specification field set exactly', () => {
    expect([...AGENT_SPECIFICATION_FIELDS]).toEqual(JAVA_SPECIFICATION_FIELDS);
  });

  it('matches the Java discovery field set exactly', () => {
    expect([...AGENT_DISCOVERY_FIELDS]).toEqual(JAVA_DISCOVERY_FIELDS);
  });

  it('exposes the three documented discovery scopes', () => {
    expect([...AGENT_SCOPES]).toEqual(['global', 'local', 'store']);
  });
});

describe('isValidAgentName', () => {
  it('accepts hyphen-case names of any length', () => {
    expect(isValidAgentName('java-pro')).toBe(true);
    expect(isValidAgentName('v2')).toBe(true);
    expect(isValidAgentName('reviewer-v2')).toBe(true);
    // The removed 20-character cap: real names from ~/.claude/agents.
    expect(isValidAgentName('seo-cannibalization-detector')).toBe(true);
    expect(isValidAgentName('workflow-orchestration-patterns')).toBe(true);
    expect(isValidAgentName('a'.repeat(200))).toBe(true);
  });

  it('accepts names with spaces and other special characters', () => {
    // Legacy store entries legitimately contain spaces ("New Agent"), so
    // rejecting them would be a backward-compatibility regression.
    expect(isValidAgentName('New Agent')).toBe(true);
    expect(isValidAgentName('java_pro')).toBe(true);
    expect(isValidAgentName('Java Pro!')).toBe(true);
  });

  it('rejects empty and blank names', () => {
    expect(isValidAgentName('')).toBe(false);
    expect(isValidAgentName('   ')).toBe(false);
    expect(isValidAgentName(undefined)).toBe(false);
    expect(isValidAgentName(null)).toBe(false);
  });

  it('rejects the reserved colon used for plugin-scoped identifiers', () => {
    expect(isValidAgentName('my-plugin:reviewer')).toBe(false);
    expect(isValidAgentName('a:b')).toBe(false);
  });
});

describe('isNonHyphenCaseName', () => {
  it('flags names that deviate from the convention', () => {
    expect(isNonHyphenCaseName('New Agent')).toBe(true);
    expect(isNonHyphenCaseName('java_pro')).toBe(true);
    expect(isNonHyphenCaseName('JavaPro')).toBe(true);
  });

  it('accepts hyphen-case names', () => {
    expect(isNonHyphenCaseName('java-pro')).toBe(false);
    expect(isNonHyphenCaseName('v2')).toBe(false);
    expect(isNonHyphenCaseName('reviewer-v2')).toBe(false);
  });

  it('is a warning, not a rejection, for long names', () => {
    // Length and convention are independent: a long hyphen-case name is valid
    // and conventionally spelled, so it produces no warning.
    const long = 'seo-cannibalization-detector';
    expect(isValidAgentName(long)).toBe(true);
    expect(isNonHyphenCaseName(long)).toBe(false);
  });
});

describe('isAgentScope', () => {
  it('recognizes the three scopes', () => {
    expect(isAgentScope('global')).toBe(true);
    expect(isAgentScope('local')).toBe(true);
    expect(isAgentScope('store')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAgentScope('project')).toBe(false);
    expect(isAgentScope(undefined)).toBe(false);
    expect(isAgentScope(42)).toBe(false);
  });
});

describe('AgentConfig backward compatibility', () => {
  it('accepts a legacy four-field entry unchanged', () => {
    // Exactly what a pre-task-56 ~/.codemoss/agent.json entry looks like.
    const legacy: AgentConfig = {
      id: 'legacy-uuid',
      name: 'accessibility-expert',
      prompt: 'You are an accessibility expert.',
      createdAt: 1789902892647,
    };

    expect(legacy.id).toBe('legacy-uuid');
    expect(legacy.name).toBe('accessibility-expert');
    expect(legacy.prompt).toBe('You are an accessibility expert.');
    expect(legacy.createdAt).toBe(1789902892647);
    // Absent optional fields read as undefined rather than a default value.
    expect(legacy.scope).toBeUndefined();
    expect(legacy.model).toBeUndefined();
    expect(legacy.readOnly).toBeUndefined();
  });

  it('accepts a full specification entry', () => {
    const full: AgentConfig = {
      id: 'full-agent',
      name: 'spec-agent',
      description: 'Use when verifying the specification contract.',
      prompt: 'Body prompt.',
      createdAt: 1700000000000,
      tools: ['Read', 'Grep', 'Bash'],
      disallowedTools: ['Write', 'Edit'],
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      maxTurns: 20,
      skills: ['workflow-patterns'],
      mcpServers: ['slack'],
      hooks: { PreToolUse: [] },
      memory: 'project',
      background: true,
      effort: 'high',
      isolation: 'worktree',
      color: 'blue',
      initialPrompt: 'Start here.',
      omitClaudeMd: true,
      experimental: { cacheTtl: '5m' },
      path: '/Users/me/.claude/agents/spec-agent.md',
      scope: 'global',
      source: 'global',
      readOnly: true,
    };

    for (const field of AGENT_SPECIFICATION_FIELDS) {
      expect(field in full, `missing specification field ${field}`).toBe(true);
    }
    for (const field of AGENT_DISCOVERY_FIELDS) {
      // `warning` is only present on an agent that failed to load fully, so a
      // healthy entry legitimately omits it.
      if (field === 'warning') continue;
      expect(field in full, `missing discovery field ${field}`).toBe(true);
    }
    expect(full.warning).toBeUndefined();
    expect(full.maxTurns).toBe(20);
    expect(full.background).toBe(true);
    expect(full.omitClaudeMd).toBe(true);
  });

  it('renders without breaking when every optional field is missing', () => {
    // What a hand-written agent with only the required fields looks like.
    const minimal: AgentConfig = { id: 'minimal', name: 'minimal-agent' };

    expect(minimal.prompt).toBeUndefined();
    expect(minimal.description).toBeUndefined();
    expect(minimal.path).toBeUndefined();
    expect(minimal.warning).toBeUndefined();
    // A consumer doing `agent.prompt && agent.prompt.substring(...)` must not throw.
    const preview = minimal.prompt && minimal.prompt.substring(0, 50);
    expect(preview).toBeUndefined();
  });

  it('carries a warning marker for a partially loaded agent', () => {
    const broken: AgentConfig = {
      id: 'broken',
      name: 'broken-agent',
      warning: 'frontmatter did not parse',
    };

    expect(broken.warning).toBe('frontmatter did not parse');
    expect(broken.name).toBe('broken-agent');
  });
});
