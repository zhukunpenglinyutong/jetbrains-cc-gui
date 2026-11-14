import test from 'node:test';
import assert from 'node:assert/strict';
import { runCliStreaming, trimPartialUtf8Head } from './cli-spawn.js';
import { decodeCliOutput } from './cli-path.js';

test('a UTF-8 character split across stderr chunks survives decoding', async () => {
  // Review repro: decodeCliOutput used to run on each stderr chunk, so a
  // multi-byte character cut at a chunk boundary turned into U+FFFD and the
  // per-chunk GBK fallback then garbled the whole chunk into mojibake. The
  // stream now decodes incrementally with StringDecoder and only re-decodes
  // the complete tail at close, so split characters survive on every platform
  // (the GBK retry is win32-only and never sees partial sequences).
  const text = '错误：找不到会话文件，请重新登录';
  const bytes = Buffer.from(text, 'utf8');
  const split = 7; // lands INSIDE the third multi-byte character
  const asArray = (buf) => JSON.stringify([...buf]);
  const script = ''
    + `process.stderr.write(Buffer.from(${asArray(bytes.subarray(0, split))}));`
    + 'process.exitCode = 2;'
    + `setTimeout(() => process.stderr.write(Buffer.concat([Buffer.from(${asArray(bytes.subarray(split))}), Buffer.from('\\n')])), 30);`;
  const result = await runCliStreaming({
    bin: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    label: 'SplitCli',
    onLine: () => {},
    emitEndStream: false,
    onError: () => { /* capture via the resolved errorMessage instead */ },
  });
  assert.equal(result.code, 2);
  assert.ok(
    result.errorMessage.includes(text),
    `the reassembled tail must equal the original text: ${result.errorMessage}`,
  );
  assert.equal(result.errorMessage.includes('\uFFFD'), false);
  // The GBK mis-read of the same bytes ('閿欒' etc.) must never appear.
  assert.equal(result.errorMessage.includes('閿'), false);
  assert.equal(result.errorMessage.includes('鎵'), false);
});

test('a healthy run resolves without an error message', async () => {
  const result = await runCliStreaming({
    bin: process.execPath,
    args: ['-e', 'console.log("ok")'],
    cwd: process.cwd(),
    label: 'OkCli',
    onLine: () => {},
    emitEndStream: false,
    onError: () => {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.hadError, false);
  assert.equal(result.errorMessage, undefined);
});

test('a byte-capped stderr tail that starts mid-character still decodes as UTF-8 on win32', () => {
  const text = '错误：找不到会话文件';
  const cut = Buffer.from(text, 'utf8').subarray(1); // tail cap landed inside the first character
  // Repro: the leading continuation bytes turn into U+FFFD and win32 re-decodes everything as GBK.
  assert.notEqual(decodeCliOutput(cut, { forceWindows: true }), text.slice(1));
  assert.equal(decodeCliOutput(trimPartialUtf8Head(cut), { forceWindows: true }), text.slice(1));
  const whole = Buffer.from(text, 'utf8');
  assert.equal(trimPartialUtf8Head(whole), whole);
});
