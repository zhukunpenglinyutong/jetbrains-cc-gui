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

import { absolutePath, isPlainFilePath } from './tool-mapping.js';

const APPROVAL_TITLE_PREFIX = 'Allow tool: ';
// The `ask` tool appends this row to choice questions and follows it with an `input` request.
const OTHER_OPTION_LABEL = 'Other (type your own)';
// A checkbox round: the title leads with the number of answers once there is
// one, and a row (`<success symbol> Done selecting`) ends the question.
const SELECTED_COUNT_PREFIX = /^\((\d+) selected\) /;
const DONE_OPTION = /(?:^|\s)Done selecting(?: \(\d+\))?$/;
const ELIDED_TAIL = /\[…(\d+)ch elided…\]$/;
// Title lines OMP adds on its own, ahead of what the tool prints about the call.
const APPROVAL_HEADER_LINE = /^(?:Origin|Reason): /;
// A prompt can reach the bridge just before the start event of its own call
// (OMP writes the prompt directly and the event through its event stream).
const CALL_START_GRACE_MS = 300;
const PRINTED_ARGS_LIMIT = 2000;
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

/** Whether `shown`, a value as OMP prints it in an approval prompt, stands for `actual`. */
function showsValue(shown, actual) {
  // The prompt's details are trimmed, which drops trailing whitespace of the last value.
  if (shown === actual || shown === actual.trimEnd()) return true;
  const elided = ELIDED_TAIL.exec(shown);
  if (!elided) return false;
  const head = shown.slice(0, elided.index);
  return actual.length === head.length + Number(elided[1]) && actual.startsWith(head);
}

/**
 * Whether a running call is the one an approval prompt prints. The prompt
 * carries no call id, only the tool's detail lines: the command of a `bash`
 * call, the path and content of a `write`. No other tool prints its call in a
 * form that can be compared, so their calls are never recognized.
 *
 * @param {{ toolName: string, details: string }} approval
 * @param {unknown} args the call's arguments
 */
export function approvalDescribesCall({ toolName, details }, args) {
  if (!args || typeof args !== 'object') return false;
  if (toolName === 'bash') {
    const shown = /(?:^|\n)Command: ([\s\S]*)$/.exec(details)?.[1];
    return typeof args.command === 'string' && shown !== undefined && showsValue(shown, args.command);
  }
  if (toolName === 'write') {
    const shown = /(?:^|\n)Path: ([^\n]*)\nContent:(?:\n([\s\S]*))?$/.exec(details);
    return typeof args.path === 'string' && typeof args.content === 'string' && shown !== null
      && showsValue(shown[1], args.path) && showsValue(shown[2] ?? '', args.content);
  }
  return false;
}

/**
 * What the permission dialog shows for a prompt that prints its call. `Bash`
 * and `Write` take the shapes the plugin already knows (command preview, IDE
 * diff review) once the running call the prompt is about is known; everything
 * else shows OMP's own description of the call.
 */
export function buildPermissionRequest({ toolName, details }, call, { cwd, home } = {}) {
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  if (toolName === 'bash' && typeof args.command === 'string') {
    return { toolName: 'Bash', inputs: { command: args.command, cwd: typeof args.cwd === 'string' ? args.cwd : cwd } };
  }
  if (toolName === 'write' && typeof args.content === 'string' && isPlainFilePath(args.path)) {
    return {
      toolName: 'Write',
      inputs: { file_path: absolutePath(args.path, cwd, home), content: args.content },
    };
  }
  return { toolName, inputs: { text: details } };
}

/**
 * The text for a prompt that prints nothing about its call (tools without an
 * approval formatter). Nothing ties such a prompt to one call, so the dialog
 * names every call of the tool that is running instead of guessing which.
 *
 * @param {{ toolName: string, details: string }} approval
 * @param {{ args?: unknown }[]} calls the running calls of that tool
 */
export function describeUnidentifiedCall({ toolName, details }, calls) {
  const lines = details ? [details, ''] : [];
  if (calls.length === 0) {
    lines.push(`OMP did not say which ${toolName} call it is asking about, and no ${toolName} call has started yet.`);
    return lines.join('\n');
  }
  lines.push(`OMP did not say which ${toolName} call it is asking about. Running now:`);
  calls.forEach((call, index) => {
    const printed = JSON.stringify(call.args ?? {}) ?? '{}';
    const shown = printed.length > PRINTED_ARGS_LIMIT
      ? `${printed.slice(0, PRINTED_ARGS_LIMIT)}[…${printed.length - PRINTED_ARGS_LIMIT}ch elided…]`
      : printed;
    lines.push(`${index + 1}. ${shown}`);
  });
  return lines.join('\n');
}

/**
 * Read a `select` as one round of a checkbox question.
 *
 * A group that has no answer yet can come without the count and without the
 * "Done" row (omp 18.12 always, later versions when the group must be answered).
 * Such a round is only recognized as the continuation of the question `current`
 * is working through.
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
  // The closing rows follow the labels, each at most once: "Other" then "Done"
  // (omp 18.18) or "Done" then "Other" (omp 18.12). Only the tail is read, so an
  // option that merely ends in the same words is still an option.
  let done = null;
  let other = null;
  let end = options.length;
  while (end > 0) {
    const option = options[end - 1];
    if (other === null && option === OTHER_OPTION_LABEL) other = option;
    else if (done === null && DONE_OPTION.test(option)) done = option;
    else break;
    end -= 1;
  }
  const labels = options.slice(0, end);
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
 * @param {(toolName: string, describes: (args: unknown) => boolean) => object|undefined} [options.claimToolCall]
 *   takes the running call of that tool that `describes` accepts, for a prompt that prints its call
 * @param {(toolName: string) => { args?: unknown }[]} [options.runningToolCalls] every running call of that tool
 * @param {(toolName: string, timeoutMs: number) => Promise<boolean>} [options.waitForToolStart]
 *   resolves true as soon as a call of that tool starts, false once `timeoutMs` have passed
 * @param {string} [options.cwd]
 * @param {(...args: unknown[]) => void} [options.log]
 */
export function createUiBridge({
  respond,
  requestPermission,
  requestAnswers,
  claimToolCall = () => undefined,
  runningToolCalls = () => [],
  waitForToolStart = async () => false,
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

  /**
   * What the permission dialog shows for an approval prompt.
   *
   * A prompt names its tool and, for most tools, prints the call. It carries no
   * call id, and it can arrive a moment before the start event of its own call.
   * So a call that happens to be running is never taken for the one asked about:
   * a `bash` or `write` call is recognized by what the prompt prints, and a
   * prompt that prints nothing lists every running call of its tool.
   */
  const describeApproval = async (approval) => {
    const { toolName, details } = approval;
    const printsCall = details.split('\n').some((line) => line.trim() !== '' && !APPROVAL_HEADER_LINE.test(line));
    if (!printsCall) {
      await waitForToolStart(toolName, CALL_START_GRACE_MS);
      return { toolName, inputs: { text: describeUnidentifiedCall(approval, runningToolCalls(toolName)) } };
    }
    if (toolName !== 'bash' && toolName !== 'write') return { toolName, inputs: { text: details } };

    const describes = (args) => approvalDescribesCall(approval, args);
    const deadline = Date.now() + CALL_START_GRACE_MS;
    let call = claimToolCall(toolName, describes);
    while (!call && await waitForToolStart(toolName, deadline - Date.now())) {
      call = claimToolCall(toolName, describes);
    }
    return buildPermissionRequest(approval, call, { cwd });
  };

  const handleApproval = async (frame, approval) => {
    const request = await describeApproval(approval);
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
          ...(round.other === null ? { choiceOnly: true } : {}),
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
    const [answer] = await ask(frame, {
      question: frame.title || '',
      header: '',
      options,
      multiSelect: false,
      // A select only accepts its own options: without OMP's "Other" row there is nowhere to send typed text.
      ...(offersOther ? {} : { choiceOnly: true }),
    }) ?? [];
    if (answer === undefined) {
      reply(frame.id, { cancelled: true });
    } else if (labels.includes(answer)) {
      reply(frame.id, { value: answer });
    } else if (offersOther) {
      otherText = answer;
      reply(frame.id, { value: OTHER_OPTION_LABEL });
    } else {
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
      choiceOnly: true,
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
