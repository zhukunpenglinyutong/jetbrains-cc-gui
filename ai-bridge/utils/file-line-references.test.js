import test from 'node:test';
import assert from 'node:assert/strict';
import { reformatFileLineReferences } from './file-line-references.js';

test('reformats the issue reference with a Windows path', () => {
  const input = String.raw`@E:\proj\H2Migrator.java#L77 这段代码是什么意思`;
  const expected = String.raw`@E:\proj\H2Migrator.java (lines 77) 这段代码是什么意思`;
  assert.equal(reformatFileLineReferences(input), expected);
});

test('reformats a line range', () => {
  assert.equal(
    reformatFileLineReferences('@/home/user/Foo.java#L12-24 explica'),
    '@/home/user/Foo.java (lines 12-24) explica',
  );
});

test('accepts the manually written L-prefixed range form', () => {
  assert.equal(
    reformatFileLineReferences('@/home/user/Foo.java#L3-L9 explica'),
    '@/home/user/Foo.java (lines 3-9) explica',
  );
});

test('reformats every reference in a message', () => {
  assert.equal(
    reformatFileLineReferences('@a/Foo.java#L1 and @b/Bar.java#L2-4'),
    '@a/Foo.java (lines 1) and @b/Bar.java (lines 2-4)',
  );
});

test('leaves non-line references and unrelated text unchanged', () => {
  assert.equal(reformatFileLineReferences('@/path/Foo.java'), '@/path/Foo.java');
  assert.equal(reformatFileLineReferences('Foo.java#L1'), 'Foo.java#L1');
  assert.equal(reformatFileLineReferences('text without references'), 'text without references');
});

test('reformats a reference after a newline', () => {
  assert.equal(
    reformatFileLineReferences('这是什么\n@E:/proj/Foo.java#L7 什么意思'),
    '这是什么\n@E:/proj/Foo.java (lines 7) 什么意思',
  );
});

test('does not rewrite a mid-word @ such as an email address', () => {
  assert.equal(
    reformatFileLineReferences('email me at user@host.com#L5 please'),
    'email me at user@host.com#L5 please',
  );
});

test('does not rewrite references quoted in a code span', () => {
  assert.equal(
    reformatFileLineReferences('use `@x/Y.java#L3` in code ticks'),
    'use `@x/Y.java#L3` in code ticks',
  );
});

test('passes through empty and non-string values', () => {
  assert.equal(reformatFileLineReferences(''), '');
  assert.equal(reformatFileLineReferences(null), null);
  assert.equal(reformatFileLineReferences(undefined), undefined);
});
