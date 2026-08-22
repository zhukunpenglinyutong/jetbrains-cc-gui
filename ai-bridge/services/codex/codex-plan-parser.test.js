import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUpdatePlanFromResponseItemPayload } from './codex-plan-parser.js';

function execPayload(input) {
  return { type: 'custom_tool_call', name: 'exec', call_id: 'plan-1', input };
}

test('extracts the latest update_plan literal without evaluating JavaScript', () => {
  const input = [
    'const oldPlan = await tools.update_plan({plan:[{step:"Old",status:"pending"}]});',
    'const currentPlan = await tools.update_plan({',
    '  explanation: "Current plan",',
    '  plan: [',
    '    {step:"Inspect, parse { safely }",status:"done"},',
    "    {step:'Implement parser',status:'running'},",
    '  ],',
    '});',
  ].join('\n');

  assert.deepEqual(extractUpdatePlanFromResponseItemPayload(execPayload(input)), {
    explanation: 'Current plan',
    plan: [
      { step: 'Inspect, parse { safely }', status: 'completed', content: 'Inspect, parse { safely }' },
      { step: 'Implement parser', status: 'in_progress', content: 'Implement parser' },
    ],
  });
});

test('preserves an explicit empty plan snapshot', () => {
  assert.deepEqual(
    extractUpdatePlanFromResponseItemPayload(execPayload('text(await tools.update_plan({ plan: [] }));')),
    { plan: [] },
  );
});

test('ignores update_plan text in strings and comments', () => {
  const input = [
    'const example = "tools.update_plan({plan:[{step:\'fake\'}]})";',
    '// tools.update_plan({plan:[{step:"fake"}]})',
    '/* tools.update_plan({plan:[{step:"fake"}]}) */',
  ].join('\n');

  assert.equal(extractUpdatePlanFromResponseItemPayload(execPayload(input)), null);
});

test('rejects dynamic plan expressions instead of evaluating them', () => {
  assert.equal(
    extractUpdatePlanFromResponseItemPayload(execPayload('await tools.update_plan(buildPlan());')),
    null,
  );
});

test('rejects a dynamic latest call instead of falling back to an earlier plan', () => {
  const input = [
    'await tools.update_plan({plan:[{step:"Old",status:"pending"}]});',
    'await tools.update_plan({plan:[{step:buildStep(),status:"pending"}]});',
  ].join('\n');

  assert.equal(extractUpdatePlanFromResponseItemPayload(execPayload(input)), null);
});

test('reads only direct plan properties from plain literal objects', () => {
  const nestedMetadata = 'tools.update_plan({plan:[{step:"Real",metadata:{content:"Not a task"}}]})';
  const parsed = extractUpdatePlanFromResponseItemPayload(execPayload(nestedMetadata));
  assert.equal(parsed.plan.length, 1);
  assert.equal(parsed.plan[0].step, 'Real');
  assert.equal(parsed.plan[0].status, 'pending');
  assert.equal(parsed.plan[0].metadata.content, 'Not a task');

  const inheritedPlan = 'tools.update_plan({__proto__:{plan:[{step:"Injected"}]}})';
  assert.equal(extractUpdatePlanFromResponseItemPayload(execPayload(inheritedPlan)), null);
  assert.equal(
    extractUpdatePlanFromResponseItemPayload(execPayload('other.tools.update_plan({plan:[]})')),
    null,
  );
});
