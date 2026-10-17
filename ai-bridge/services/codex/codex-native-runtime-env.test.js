import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCodexRuntimeEnvironment, collectCodexProviderEnvKeys, lookupCodexShellEnvironment } from './codex-native-runtime-env.js';

test('provider env_key strings are collected outside comments and multiline instructions', () => {
  const config = `# [model_providers.fake]\n# env_key = "FAKE_KEY"\nbase_instructions = """\n[model_providers.fake]\nenv_key = "FAKE_KEY"\n"""\n[model_providers.one]\nenv_key = "FIRST_KEY" # comment\n[model_providers.'two.with.dot']\nenv_key = 'SECOND_KEY'\n[model_providers.one.http_headers]\nenv_key = "NOT_A_PROVIDER_KEY"\n`;
  assert.deepEqual([...collectCodexProviderEnvKeys(config)], [['one', 'FIRST_KEY'], ['two.with.dot', 'SECOND_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('model_providers.one.env_key = "FIRST_KEY"\n')], [['one', 'FIRST_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('[model_providers]\none.env_key = \'FIRST_KEY\'\n')], [['one', 'FIRST_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('[model_providers]\none = { env_key = "INLINE_KEY" }\n')], [['one', 'INLINE_KEY']]);
});

test('valid root inline tables, dotted keys and quoted provider names match native TOML semantics', () => {
  assert.deepEqual([...collectCodexProviderEnvKeys("model_providers={ team={ env_key='TEAM_KEY' } }\n")], [['team', 'TEAM_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('model_providers."team.with.dot".env_key="TEAM_KEY"\n')], [['team.with.dot', 'TEAM_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('[model_providers."escaped\\u0020name"]\nenv_key="TEAM_KEY"\n')], [['escaped name', 'TEAM_KEY']]);
  assert.deepEqual([...collectCodexProviderEnvKeys('model_max_output_tokens=999999999999999999\n[model_providers.team]\nenv_key="TEAM_KEY"\n')], [['team', 'TEAM_KEY']]);
});

test('multiline TOML strings cannot invent providers and invalid configurations remain native-owned', () => {
  const config = "base_instructions = '''\n[model_providers.fake]\nenv_key='FAKE_KEY'\n'''\n[model_providers.team]\nenv_key=\"TEAM_KEY\"\n";
  assert.deepEqual([...collectCodexProviderEnvKeys(config)], [['team', 'TEAM_KEY']]);
  for (const invalid of ['[model_providers.team]\nenv_key="TEAM_KEY"\nenv_key="OTHER_KEY"',
    'broken=[\n[model_providers.team]\nenv_key="TEAM_KEY"', '[model_providers.team]\nenv_key="TEAM_KEY"\ninvalid="unterminated']) {
    assert.deepEqual([...collectCodexProviderEnvKeys(invalid)], []);
  }
});

test('a legal __proto__ credential stays an own environment value without changing object prototypes', async () => {
  const baseEnv = {};
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {}, baseEnv }, {
    readConfig: async () => '[model_providers.__proto__]\nenv_key="__proto__"\n',
    lookup: async keys => {
      assert.deepEqual(keys, ['__proto__']);
      return Object.fromEntries([['__proto__', 'fixture-native-value']]);
    },
  });
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'fixture-native-value');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(baseEnv, {});
});

test('an explicitly empty __proto__ credential is preserved without borrowing a shell value', async () => {
  const baseEnv = Object.fromEntries([['__proto__', '']]);
  let lookups = 0;
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {}, baseEnv }, {
    readConfig: async () => '[model_providers.team]\nenv_key="__proto__"\n',
    lookup: async () => { lookups += 1; return {}; },
  });
  assert.equal(lookups, 0);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, '');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('managed and inactive launch modes never read native configuration or resolve shell credentials', async () => {
  for (const authMode of ['managed', 'inactive']) {
    const env = { EXPLICIT_KEY: 'managed-value' };
    let reads = 0;
    let lookups = 0;
    const result = await prepareCodexRuntimeEnvironment({ authMode, env }, {
      readConfig: async () => { reads += 1; return '[model_providers.team]\nenv_key="NATIVE_KEY"\n'; },
      lookup: async () => { lookups += 1; return { NATIVE_KEY: 'native-value' }; },
    });
    assert.equal(reads, 0);
    assert.equal(lookups, 0);
    assert.deepEqual(result, env);
  }
});

test('CLI Login resolves only missing provider keys in the selected native home without mutating pristine env', async () => {
  const env = { PRESENT_KEY: 'explicit', EMPTY_KEY: '' };
  const baseEnv = { ...env };
  const reads = [];
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', codexHome: 'private-home', env, baseEnv }, {
    readConfig: async path => { reads.push(path); return '[model_providers.a]\nenv_key="PRESENT_KEY"\n[model_providers.b]\nenv_key="EMPTY_KEY"\n[model_providers.c]\nenv_key="MISSING_KEY"\n'; },
    lookup: async keys => { assert.deepEqual(keys, ['MISSING_KEY']); return { MISSING_KEY: 'resolved', UNRELATED_KEY: 'ignored' }; },
  });
  assert.match(reads[0], /private-home[\\/]config\.toml$/);
  assert.deepEqual(result, { ...env, MISSING_KEY: 'resolved' });
  assert.deepEqual(baseEnv, env);
});

test('an explicitly empty pristine credential remains empty after runtime sanitization', async () => {
  let lookups = 0;
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {}, baseEnv: { EMPTY_KEY: '' } }, {
    readConfig: async () => '[model_providers.a]\nenv_key="EMPTY_KEY"\n',
    lookup: async () => { lookups += 1; return { EMPTY_KEY: 'another-account' }; },
  });
  assert.equal(lookups, 0);
  assert.deepEqual(result, { EMPTY_KEY: '' });
});

test('native CODEX_HOME and default home selection preserve the actual credential scope', async () => {
  const reads = [];
  const dependencies = { home: 'private-default', readConfig: async path => { reads.push(path); return ''; } };
  await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: { CODEX_HOME: 'private-override' } }, dependencies);
  await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {} }, dependencies);
  assert.match(reads[0], /private-override[\\/]config\.toml$/);
  assert.match(reads[1], /private-default[\\/]\.codex[\\/]config\.toml$/);
});

test('explicit runtime provider definitions override native env_key selection', async () => {
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {},
    config: { model_providers: { custom: { env_key: 'OVERRIDE_KEY' } } } }, {
    readConfig: async () => '[model_providers.custom]\nenv_key="OLD_KEY"\n',
    lookup: async keys => { assert.deepEqual(keys, ['OVERRIDE_KEY']); return { OVERRIDE_KEY: 'resolved' }; },
  });
  assert.deepEqual(result, { OVERRIDE_KEY: 'resolved' });
});

test('invalid or protected env names never reach a shell and unavailable lookup stays a native failure', async () => {
  const config = '[model_providers.bad]\nenv_key="KEY;echo injected"\n[model_providers.options]\nenv_key="NODE_OPTIONS"\n[model_providers.permission]\nenv_key="CODEX_SANDBOX_MODE"\n';
  let lookups = 0;
  assert.deepEqual(await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {} }, {
    readConfig: async () => config, lookup: async () => { lookups += 1; return {}; },
  }), {});
  assert.equal(lookups, 0);
  assert.deepEqual(await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {} }, {
    readConfig: async () => '[model_providers.a]\nenv_key="MISSING_KEY"\n', lookup: async () => { throw new Error('lookup unavailable'); },
  }), {});
  assert.deepEqual(await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {} }, {
    readConfig: async () => { throw new Error('configuration unreadable'); },
  }), {});
});

test('Windows preserves existing case aliases and empty credential values', async () => {
  let lookups = 0;
  const result = await prepareCodexRuntimeEnvironment({ authMode: 'cli_login', env: {}, baseEnv: { custom_key: '' } }, {
    platform: 'win32', readConfig: async () => '[model_providers.a]\nenv_key="CUSTOM_KEY"\n',
    lookup: async () => { lookups += 1; return {}; },
  });
  assert.equal(lookups, 0);
  assert.deepEqual(result, { custom_key: '' });
});

test('login shell lookup extracts only framed requested values and ignores startup output', async () => {
  let invocation;
  const values = await lookupCodexShellEnvironment(['FOO', 'FOO2'], { SHELL: '/bin/bash' }, {
    platform: 'linux', exists: () => true,
    execute: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: 'startup noise\n__CODEMOSS_ENV_START__FOO\none\n__CODEMOSS_ENV_END__FOO\n__CODEMOSS_ENV_START__FOO2\ntwo\n__CODEMOSS_ENV_END__FOO2\n' };
    },
  });
  assert.deepEqual(values, { FOO: 'one', FOO2: 'two' });
  assert.equal(invocation.file, '/bin/bash');
  assert.deepEqual(invocation.args.slice(-2), ['FOO', 'FOO2']);
  assert.equal(invocation.options.timeout, 5000);
  assert.equal(invocation.options.env.SHELL, '/bin/bash');
});

test('shell discovery failures and unsupported Windows lookup never expose output or choose another transport', async () => {
  assert.deepEqual(await lookupCodexShellEnvironment(['FOO'], {}, {
    platform: 'linux', exists: () => true, execute: async () => { throw new Error('shell failed'); },
  }), {});
  assert.deepEqual(await lookupCodexShellEnvironment(['FOO'], {}, {
    platform: 'win32', execute: () => assert.fail('no POSIX login shell on Windows'),
  }), {});
});
