import { describe, expect, it } from 'vitest';
import { isNonRenderedToolUse } from './toolConstants';

describe('Codex terminal polling', () => {
  it('accepts literal polling batches with comments, but leaves broken or computed input visible', () => {
    const hidden = (patch: string) => isNonRenderedToolUse({ type: 'tool_use', name: 'functions.exec', input: { code: patch } }, true);
    expect(hidden('/* wait for output */ text(await tools.write_stdin({session_id:1,chars:""})); // next\nawait functions.write_stdin({session_id:2});')).toBe(true);
    expect(hidden('/* unclosed')).toBe(false);
    expect(hidden('text(await tools.write_stdin({session_id:1,chars:"unclosed}));')).toBe(false);
    expect(hidden('await tools.write_stdin(session);')).toBe(false);
    expect(hidden('await tools.write_stdin({session_id:1,chars:"\\""});')).toBe(false);
  });
  it.each(['write_stdin', 'functions.write_stdin', 'tools.write_stdin'])('hides %s during and after streaming', name => {
    expect(isNonRenderedToolUse({ type: 'tool_use', name }, true)).toBe(true);
    expect(isNonRenderedToolUse({ type: 'tool_use', name }, false)).toBe(true);
  });
  it('hides the recorded pure polling wrapper', () => {
    const input = { patch: 'text(await tools.write_stdin({session_id:22951,chars:"",yield_time_ms:1000,max_output_tokens:1700}));' };
    expect(isNonRenderedToolUse({ type: 'tool_use', name: 'exec', input }, false)).toBe(true);
  });
  it.each([
    'text("tools.write_stdin({})");',
    '// tools.write_stdin({})\ntext(await tools.exec_command({cmd:"pwd"}));',
    'text(await tools.write_stdin({session_id:1})); text(await tools.apply_patch("patch"));',
    'text(await tools.write_stdin({session_id:computeSession()}));',
    'text(await tools.write_stdin({session_id:1,chars:"exit\\n"}));',
    'text(await tools.write_stdin({"session_id":1,"chars":"exit\\n"}));',
    'text(await tools.write_stdin({session_id:1,chars:`${await tools.exec_command({cmd:"pwd"})}`}));',
  ])('retains text, mixed operations and terminal input: %s', patch => {
    expect(isNonRenderedToolUse({ type: 'tool_use', name: 'exec', input: { patch } }, false)).toBe(false);
  });
});
