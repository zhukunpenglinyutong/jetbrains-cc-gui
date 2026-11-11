/**
 * Answers OMP's `extension_ui_request` frames through the plugin's dialogs.
 *
 * In RPC mode OMP has no dialog of its own. Tool approvals arrive as a `select`
 * titled `Allow tool: <name>` and go to the permission dialog; the `ask` tool
 * and extension prompts arrive as `select` / `confirm` / `input` / `editor` and
 * go to the question dialog. Both dialogs are reached over the file IPC in
 * permission-ipc.js.
 *
 * A checkbox group has no request of its own: OMP sends its options as a
 * `select` again and again, one toggle per answer. The plugin shows it as one
 * multi-select question (see `handleCheckboxRound`).
 */

import { absolutePath } from './tool-mapping.js';

const APPROVAL_TITLE_PREFIX = 'Allow tool: ';
// The `ask` tool appends this row to choice questions and follows it with an `input` request.
const OTHER_OPTION_LABEL = 'Other (type your own)';
// A checkbox round: the title leads with the number of answers once there is
// one, and the last row (`<success symbol> Done selecting`) ends the question.
const SELECTED_COUNT_PREFIX = /^\((\d+) selected\) /;
const DONE_OPTION = /(?:^|\s)Done selecting(?: \(\d+\))?$/;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const CONFIRM_YES = 'Yes';
const CONFIRM_NO = 'No';

function answerLabels(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  return typeof value === 'string' && value.trim() !== '' ? [value] : [];
}

/**
 * Recognize a tool-approval prompt: `Allow tool: <name>` on the first title
 * line, the tool's own detail lines after it, and an approve and a deny choice.
 *
 * `approve` is the once-only choice. Remembering a decision is the plugin's
 * job (its dialog has "always allow"), so OMP's session-wide and cached
 * choices are never taken.
 *
 * @returns {{ toolName: string, details: string, approve: string, deny: string }|null}
 */
export function parseApprovalRequest(frame) {
  const title = typeof frame?.title === 'string' ? frame.title : '';
  if (frame?.method !== 'select' || !title.startsWith(APPROVAL_TITLE_PREFIX)) return null;
  const options = Array.isArray(frame.options) ? frame.options.filter((option) => typeof option === 'string') : [];
  const approve = options.find((option) => option === 'Approve')
    ?? options.find((option) => option === 'Approve Once');
  const deny = options.find((option) => option === 'Deny')
    ?? options.find((option) => option.startsWith('Deny'));
  if (!approve || !deny) return null;
  const [firstLine, ...rest] = title.split('\n');
  const toolName = firstLine.slice(APPROVAL_TITLE_PREFIX.length).trim();
  return toolName ? { toolName, details: rest.join('\n').trim(), approve, deny } : null;
}

/**
 * What the permission dialog shows for an OMP tool. `Bash` and `Write` take the
 * shapes the plugin already knows (command preview, IDE diff review); every
 * other tool shows OMP's own description of the call.
 */
export function buildPermissionRequest({ toolName, details }, call, { cwd, home } = {}) {
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  if (toolName === 'bash' && typeof args.command === 'string') {
    return { toolName: 'Bash', inputs: { command: args.command, cwd: typeof args.cwd === 'string' ? args.cwd : cwd } };
  }
  if (toolName === 'write' && typeof args.path === 'string' && !URL_SCHEME.test(args.path)
    && typeof args.content === 'string') {
    return {
      toolName: 'Write',
      inputs: { file_path: absolutePath(args.path, cwd, home), content: args.content },
    };
  }
  if (details) return { toolName, inputs: { text: details } };
  return { toolName, inputs: args };
}

/**
 * Read a `select` as one round of a checkbox question.
 *
 * A group that must have an answer and has none yet carries neither the count
 * nor the "Done" row. Such a round is only recognized as the continuation of
 * the question `current` is working through.
 *
 * @param {string} title
 * @param {string[]} options
 * @param {{ question: string, labels: string[] }|null} current
 * @returns {{
 *   question: string, count: number, labels: string[],
 *   other: string|null, done: string|null, continues: boolean,
 * }|null} `count` is how many answers OMP holds; `other` and `done` are the
 *   rows for typed text and for ending the question, when OMP offers them
 */
function parseCheckboxRound(title, options, current) {
  const counted = SELECTED_COUNT_PREFIX.exec(title);
  const last = options.at(-1);
  const done = last !== undefined && DONE_OPTION.test(last) ? last : null;
  const choices = done === null ? options : options.slice(0, -1);
  const other = choices.at(-1) === OTHER_OPTION_LABEL ? OTHER_OPTION_LABEL : null;
  const labels = other === null ? choices : choices.slice(0, -1);
  const question = counted ? title.slice(counted[0].length) : title;
  const continues = current !== null && current.question === question
    && current.labels.length === labels.length
    && current.labels.every((label, index) => label === labels[index]);
  if (labels.length === 0 || (!counted && done === null && !continues)) return null;
  return { question, count: counted ? Number(counted[1]) : 0, labels, other, done, continues };
}

/**
 * @param {object} options
 * @param {(frame: object) => void} options.respond writes an `extension_ui_response`
 * @param {(toolName: string, inputs: object) => Promise<boolean>} options.requestPermission
 * @param {(input: object) => Promise<object|null>} options.requestAnswers
 * @param {(toolName: string) => object|undefined} [options.claimToolCall] the running call an approval refers to
 * @param {string} [options.cwd]
 * @param {(...args: unknown[]) => void} [options.log]
 */
export function createUiBridge({
  respond,
  requestPermission,
  requestAnswers,
  claimToolCall = () => undefined,
  cwd,
  log = () => {},
}) {
  // One dialog at a time: the plugin shows a single prompt, and the `ask`
  // tool's follow-up `input` must see the answer to the `select` before it.
  let queue = Promise.resolve();
  // Requests OMP withdrew (timeout, abort). It ignores a late answer, so none is sent.
  const withdrawn = new Set();
  // Free text typed into a choice question, owed to the `input` request that follows "Other".
  let otherText = null;
  // The checkbox question being worked through, or null (see handleCheckboxRound).
  let checkbox = null;

  /** @returns {boolean} false when OMP withdrew the request and the answer was dropped */
  const reply = (id, body) => {
    if (withdrawn.delete(id)) {
      log(`ui request ${id} was withdrawn; the answer is not sent`);
      return false;
    }
    respond({ type: 'extension_ui_response', id, ...body });
    return true;
  };

  /** Ask one question; resolves the chosen labels / typed text, or null when dismissed. */
  const ask = async (frame, question) => {
    const answers = await requestAnswers({ questions: [{ id: frame.id, ...question }], provider: 'omp' });
    const answer = answers && typeof answers === 'object' ? answers[frame.id] : undefined;
    return answer === undefined || answer === null ? null : answerLabels(answer);
  };

  const handleApproval = async (frame, approval) => {
    const request = buildPermissionRequest(approval, claimToolCall(approval.toolName), { cwd });
    let allowed = false;
    try {
      allowed = await requestPermission(request.toolName, request.inputs);
    } catch (error) {
      log(`approval for ${approval.toolName} failed: ${error?.message || error}`);
    }
    reply(frame.id, { value: allowed ? approval.approve : approval.deny });
  };

  /**
   * One round of a checkbox question.
   *
   * OMP sends the options as a `select`, toggles the one that comes back and
   * sends the select again, until the answer is its "Done" row. The frame says
   * how many options are checked, not which.
   *
   * The plugin asks once instead. Rounds before the dialog find the checked
   * options (toggle one, read the count, toggle it back), so the dialog opens
   * with the form's own selection and OMP still holds that selection while the
   * user decides. Rounds after the dialog replay the user's choice and finish.
   *
   * @returns {Promise<boolean>} false when the rounds do not behave like this
   *   loop; the caller then shows the round as an ordinary select
   */
  const handleCheckboxRound = async (frame, round) => {
    if (!round.continues) {
      checkbox = {
        question: round.question,
        labels: round.labels,
        phase: 'discover',
        // Labels OMP holds checked while the question is at rest.
        checked: new Set(),
        // Labels whose state is not known yet. With no answer held, none is checked.
        unknown: round.count > 0 ? [...round.labels] : [],
        // How many answers OMP held when the question arrived.
        initialCount: round.count,
        // OMP holds typed text for "Other".
        otherSet: false,
        probe: null,
        steps: [],
        required: false,
        autoReplies: 0,
        plain: false,
      };
    }
    const state = checkbox;
    if (state.plain) return false;
    const showPlainly = (reason) => {
      log(`checkbox question "${state.question}" ${reason}; showing its rounds one by one`);
      state.plain = true;
      return false;
    };
    // Finding the checked options takes two rounds per label, replaying a choice fewer.
    if (state.autoReplies > 2 * state.labels.length + 4) return showPlainly('keeps coming back');
    /** Answer the round without asking. False when OMP withdrew it: the question is over. */
    const answer = (value) => {
      state.autoReplies += 1;
      const delivered = reply(frame.id, { value });
      if (!delivered) checkbox = null;
      return delivered;
    };

    if (state.phase === 'discover') {
      if (state.probe) {
        const { label, before, restoring } = state.probe;
        const moved = round.count - before;
        // A toggle moves the count by one, and toggling back returns it.
        if (restoring ? moved !== 0 : Math.abs(moved) !== 1) return showPlainly('does not count toggles');
        if (restoring) {
          state.probe = null;
        } else {
          // The count fell: the label was checked.
          if (moved === -1) state.checked.add(label);
          state.unknown.shift();
          state.probe = { label, before, restoring: true };
          answer(label);
          return true;
        }
      }
      if (state.unknown.length > 0 && state.checked.size < state.initialCount) {
        state.probe = { label: state.unknown[0], before: round.count, restoring: false };
        answer(state.unknown[0]);
        return true;
      }
      state.unknown = [];
      // An answer that no label accounts for is text typed into "Other".
      state.otherSet = state.initialCount > state.checked.size;
      state.phase = 'ask';
    }

    for (;;) {
      if (state.phase === 'ask') {
        const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
        const answered = await ask(frame, {
          question: state.question,
          header: '',
          options: state.labels.map((label, index) => ({
            label,
            description: details[index]?.description ?? '',
            ...(state.checked.has(label) ? { selected: true } : {}),
          })),
          multiSelect: true,
          // Without its "Done" row OMP accepts nothing less than one answer.
          required: state.required || round.done === null,
        });
        if (answered === null) {
          reply(frame.id, { cancelled: true });
          checkbox = null;
          return true;
        }
        const wanted = new Set(answered.filter((entry) => state.labels.includes(entry)));
        const typed = answered.findLast((entry) => !state.labels.includes(entry));
        // Additions first, so a group that needs an answer never passes through "none".
        state.steps = state.labels
          .filter((label) => wanted.has(label) && !state.checked.has(label))
          .map((label) => ({ value: label }));
        if (typed !== undefined && round.other === null) {
          log(`checkbox question "${state.question}" takes no typed answer; the text is not sent`);
        } else if (typed !== undefined) {
          // Selecting "Other" while it holds text clears it; selecting it again asks for the text.
          if (state.otherSet) state.steps.push({ value: round.other, typed: null });
          state.steps.push({ value: round.other, typed });
        }
        state.steps.push(...state.labels
          .filter((label) => !wanted.has(label) && state.checked.has(label))
          .map((label) => ({ value: label })));
        state.phase = 'replay';
        state.autoReplies = 0;
      }

      const step = state.steps.shift();
      if (step) {
        if (!answer(step.value)) return true;
        if (!('typed' in step)) {
          if (!state.checked.delete(step.value)) state.checked.add(step.value);
        } else {
          state.otherSet = step.typed !== null;
          // The `input` request OMP sends next takes the text.
          if (step.typed !== null) otherText = step.typed;
        }
        return true;
      }
      if (round.done !== null) {
        reply(frame.id, { value: round.done });
        checkbox = null;
        return true;
      }
      // Nothing is selected and OMP offers no way to finish: the group needs an answer.
      state.required = true;
      state.phase = 'ask';
    }
  };

  const handleSelect = async (frame) => {
    const labels = Array.isArray(frame.options) ? frame.options.filter((option) => typeof option === 'string') : [];
    const round = parseCheckboxRound(typeof frame.title === 'string' ? frame.title : '', labels, checkbox);
    if (round === null) {
      checkbox = null;
    } else if (await handleCheckboxRound(frame, round)) {
      return;
    }
    const offersOther = labels.includes(OTHER_OPTION_LABEL);
    const details = Array.isArray(frame.optionDetails) ? frame.optionDetails : [];
    // The dialog has its own free-text box, so OMP's "Other" row is not listed twice.
    const options = labels
      .map((label, index) => ({ label, description: details[index]?.description ?? '' }))
      .filter((option) => option.label !== OTHER_OPTION_LABEL);
    const [answer] = await ask(frame, { question: frame.title || '', header: '', options, multiSelect: false }) ?? [];
    if (answer === undefined) {
      reply(frame.id, { cancelled: true });
    } else if (labels.includes(answer)) {
      reply(frame.id, { value: answer });
    } else if (offersOther) {
      otherText = answer;
      reply(frame.id, { value: OTHER_OPTION_LABEL });
    } else {
      // A select only accepts its own options; free text cannot answer it.
      reply(frame.id, { cancelled: true });
    }
  };

  const handleConfirm = async (frame) => {
    const question = [frame.title, frame.message].filter((part) => typeof part === 'string' && part).join('\n');
    const [answer] = await ask(frame, {
      question,
      header: '',
      options: [{ label: CONFIRM_YES, description: '' }, { label: CONFIRM_NO, description: '' }],
      multiSelect: false,
    }) ?? [];
    if (answer === CONFIRM_YES || answer === CONFIRM_NO) {
      reply(frame.id, { confirmed: answer === CONFIRM_YES });
    } else {
      reply(frame.id, { cancelled: true });
    }
  };

  const handleText = async (frame) => {
    if (otherText !== null) {
      const text = otherText;
      otherText = null;
      reply(frame.id, { value: text });
      return;
    }
    const [answer] = await ask(frame, {
      question: frame.title || '',
      header: '',
      options: [],
      multiSelect: false,
      ...(frame.secret === true ? { isSecret: true } : {}),
    }) ?? [];
    reply(frame.id, answer === undefined ? { cancelled: true } : { value: answer });
  };

  const handlers = { select: handleSelect, confirm: handleConfirm, input: handleText, editor: handleText };

  return {
    /**
     * @param {object} frame an `extension_ui_request`
     * @returns {Promise<void>} settles once the request needs nothing more (never rejects)
     */
    handle(frame) {
      if (typeof frame?.id !== 'string') return Promise.resolve();
      if (frame.method === 'cancel') {
        if (typeof frame.targetId === 'string') withdrawn.add(frame.targetId);
        return Promise.resolve();
      }
      // Everything else (notify, setStatus, setWidget, setTitle, ...) expects no answer.
      const handler = handlers[frame.method];
      if (!handler) return Promise.resolve();
      queue = queue.then(async () => {
        const approval = parseApprovalRequest(frame);
        // Withdrawn while it waited its turn: there is nothing left to ask.
        if (withdrawn.delete(frame.id)) {
          // OMP moved on from the question, so what was planned for its next round is void.
          if (frame.method === 'select' && !approval) checkbox = null;
          return;
        }
        try {
          // Typed "Other" text belongs to the request right after its select only.
          if (frame.method !== 'input' && frame.method !== 'editor') otherText = null;
          await (approval ? handleApproval(frame, approval) : handler(frame));
        } catch (error) {
          log(`ui request ${frame.method} failed: ${error?.message || error}`);
          reply(frame.id, { cancelled: true });
        }
      });
      return queue;
    },
  };
}
