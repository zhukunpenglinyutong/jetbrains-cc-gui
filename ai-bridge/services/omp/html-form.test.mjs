import test from 'node:test';
import assert from 'node:assert/strict';
import { formEntries, formQuestion, formValue } from './html-form.js';

test('a form is read with OMP\'s HTML rules: implied end tags, character references, detached labels', () => {
  const entries = formEntries(`
    <form>
      <p>Pick a region
      <fieldset><legend>Deploy</legend>
        <select name=region><option value="eu&amp;west">EU West<option selected>US East<option disabled>Mars</select>
        <label for="msg">Commit message</label>
        <textarea id="msg" name="message" required minlength="3">
fix: retry</textarea>
      </fieldset>
    </form>`);

  assert.deepEqual(entries.map((entry) => formQuestion(entry)), [
    {
      // The fieldset ends the open paragraph, so its text is context and the legend is the question.
      question: 'Deploy',
      header: '',
      detail: 'Pick a region',
      // An option that cannot be chosen is not offered.
      options: [{ label: 'EU West', description: '' }, { label: 'US East', description: '', selected: true }],
      multiSelect: false,
      required: true,
      choiceOnly: true,
    },
    { question: 'Commit message', header: '', options: [], multiSelect: false, required: true, defaultText: 'fix: retry' },
  ]);
  // A label is shown, the option's value is sent; without a `value` the option text is the value.
  assert.equal(formValue(entries[0], ['EU West']), 'eu&west');
  assert.equal(formValue(entries[0], ['US East']), 'US East');
});

test('the form text around a field is its detail, as Markdown that shows the text literally', () => {
  const [entry] = formEntries(`
    <form>
      <h3>Rollout</h3>
      <p>Run <code>npm test</code> first.<br>2. Costs *nothing*</p>
      <ul><li>fast<li>safe</ul>
      <pre>
- old
+ new</pre>
      <table><tr><th>Plan<th>Cost</tr><tr><td>A|B<td><code>1|2</code></table>
      <label>Go? <input name="go"></label>
      <p>Thanks</p>
    </form>`);

  assert.equal(entry.question, 'Go?');
  assert.equal(entry.context, [
    '**Rollout**',
    'Run `npm test` first&#46;  \n2&#46; Costs &#42;nothing&#42;',
    '- fast\n- safe',
    '```\n- old\n+ new\n```',
    '| Plan | Cost |\n| --- | --- |\n| A&#124;B | `1\\|2` |',
    // The last field also carries the text after it.
    'Thanks',
  ].join('\n\n'));
});

test('typed text joins a checkbox group as its "Other" answer, and text that spells an option value is that option', () => {
  const [entry] = formEntries(`<form>
    <label><input type="checkbox" name="tools" value="ci"> CI</label>
    <label><input type="checkbox" name="tools" value="docs"> Docs</label>
  </form>`);

  assert.deepEqual(formValue(entry, ['CI', 'terraform']), ['ci', 'terraform']);
  assert.deepEqual(formValue(entry, ['CI', 'docs']), ['ci', 'docs']);
  // OMP rejects a value that comes twice.
  assert.deepEqual(formValue(entry, ['CI', 'ci']), ['ci']);
  assert.deepEqual(formValue(entry, []), []);
});

test('a group that offers its own "Other" option takes no typed answer', () => {
  const [entry] = formEntries(`<form>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
    <label><input type="radio" name="db" value="other"> Other (say which below)</label>
  </form>`);

  assert.equal(formQuestion(entry).choiceOnly, true);
  assert.equal(formValue(entry, ['MySQL']), undefined);
});
