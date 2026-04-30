import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFileReferenceOutputPrompt, prependFileReferenceOutputPrompt } from './file-reference-output-prompt.js';
import { buildIDEContextPrompt } from './system-prompts.js';

describe('file reference output prompt', () => {
  it('instructs assistants to cite real project files with line numbers', () => {
    const prompt = buildFileReferenceOutputPrompt();

    assert.match(prompt, /FileName\.ext \(line N\)/);
    assert.match(prompt, /relative\/path\/FileName\.ext \(line N\)/);
    assert.match(prompt, /instead of Markdown file links/);
    assert.match(prompt, /Do not abbreviate file paths with "\.\.\."/);
    assert.match(prompt, /CommunityDomainServiceImpl\.java \(line 862\)/);
    assert.match(prompt, /Do not put file references inside code blocks/);
  });

  it('is included in the IDE context prompt even when no files are open', () => {
    const prompt = buildIDEContextPrompt(null);

    assert.match(prompt, /Clickable File References/);
    assert.match(prompt, /FileName\.ext \(line N\)/);
  });

  it('wraps every Codex user message with UI output instructions', () => {
    const message = prependFileReferenceOutputPrompt('Explain this project');

    assert.match(message, /^<ui-output-instructions>/);
    assert.match(message, /Clickable File References/);
    assert.match(message, /<\/ui-output-instructions>\n\nExplain this project$/);
  });
});
