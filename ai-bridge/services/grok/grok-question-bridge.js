/**
 * Bridge between Grok ACP server-request ask_user_question and the IDE's AskUserQuestion dialog.
 */

import { requestAskUserQuestionAnswers } from '../../permission-ipc.js';

/**
 * Check if the incoming server request is for ask_user_question.
 * The captured Grok CLI 1.0.41 frame uses `_x.ai/ask_user_question` only.
 */
export function isAskUserQuestionRequestMethod(method) {
  return String(method || '') === '_x.ai/ask_user_question';
}

/**
 * Extract question request fields from ACP server request params.
 */
export function extractQuestionRequest(params = {}) {
  if (!params || typeof params !== 'object') {
    return { sessionId: '', toolCallId: '', questions: [], mode: 'default' };
  }

  let target = params;
  if (params.params && typeof params.params === 'object' && Array.isArray(params.params.questions)) {
    target = params.params;
  } else if (params.input && typeof params.input === 'object' && Array.isArray(params.input.questions)) {
    target = params.input;
  } else if (params.arguments && typeof params.arguments === 'object' && Array.isArray(params.arguments.questions)) {
    target = params.arguments;
  }

  return {
    sessionId: target.sessionId || target.session_id || params.sessionId || params.session_id || '',
    toolCallId: target.toolCallId || target.tool_call_id || params.toolCallId || params.tool_call_id || '',
    questions: Array.isArray(target.questions) ? target.questions : [],
    mode: target.mode || params.mode || 'default',
  };
}

/**
 * Normalize Grok question items to the shape expected by AskUserQuestionDialog.
 * Options preview is folded into description if description is absent.
 */
export function normalizeGrokQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions.map((q) => {
    if (!q || typeof q !== 'object') {
      return {
        id: '',
        question: String(q || ''),
        header: '',
        options: [],
        multiSelect: false,
      };
    }

    const question = typeof q.question === 'string' ? q.question : String(q.id || '');
    const header = typeof q.header === 'string' ? q.header : '';
    const multiSelect = q.multiSelect === true || q.multi_select === true;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions.map((opt) => {
      if (typeof opt === 'string') {
        return { label: opt, description: '' };
      }
      const label = typeof opt?.label === 'string' ? opt.label : String(opt?.name || '');
      let description = typeof opt?.description === 'string' ? opt.description : '';
      if (!description && typeof opt?.preview === 'string' && opt.preview.trim()) {
        description = opt.preview.trim();
      }
      return { label, description };
    });

    return {
      id: typeof q.id === 'string' ? q.id : '',
      question,
      header,
      options,
      multiSelect,
    };
  });
}

/**
 * Map dialog answers to the Grok CLI 1.0.41 wire payload.
 * A selection is `{ outcome: 'accepted', answers }` keyed only by question text.
 * Dismiss, timeout, and an empty selection are `{ outcome: 'cancelled' }`.
 */
export function mapAnswersToGrokResponse(answers, originalQuestions = []) {
  if (!answers || typeof answers !== 'object') {
    return { outcome: 'cancelled' };
  }

  const mappedAnswers = {};
  const questionList = Array.isArray(originalQuestions) ? originalQuestions : [];

  if (questionList.length === 0) {
    for (const [key, value] of Object.entries(answers)) {
      if (value != null) mappedAnswers[key] = value;
    }
  } else {
    for (const q of questionList) {
      const qText = typeof q.question === 'string' ? q.question : '';
      const qId = typeof q.id === 'string' ? q.id : '';
      const answerVal =
        qText && Object.prototype.hasOwnProperty.call(answers, qText)
          ? answers[qText]
          : qText && Object.prototype.hasOwnProperty.call(answers, qText.trim())
            ? answers[qText.trim()]
            : qId && Object.prototype.hasOwnProperty.call(answers, qId)
              ? answers[qId]
              : undefined;
      if (answerVal != null && qText) mappedAnswers[qText] = answerVal;
    }
  }

  if (Object.keys(mappedAnswers).length === 0) {
    return { outcome: 'cancelled' };
  }

  return {
    outcome: 'accepted',
    answers: mappedAnswers,
  };
}

/**
 * Handle incoming server request for ask_user_question.
 * Resolves user answers via Java/IPC dialog, replies to the ACP request,
 * and handles replacement of in-flight questions by declining previous ones.
 *
 * @param {object} options
 * @param {string} options.method
 * @param {object} options.params
 * @param {number|string} options.id
 * @param {object} options.acp
 * @param {Function} [options.requestQuestions]
 * @param {Function} [options.emit]
 * @param {Function} [options.log]
 * @returns {Promise<boolean>} true if handled, false otherwise
 */
export async function handleAskUserQuestionServerRequest({
  method,
  params,
  id,
  acp,
  requestQuestions = requestAskUserQuestionAnswers,
  emit = null,
  log = console.error,
}) {
  if (!isAskUserQuestionRequestMethod(method, params)) {
    return false;
  }

  // Idle createRuntime and in-turn executeTurn both receive this same ACP client.
  const holder = acp || {};

  // AC 8: If another question is in-flight on this client, decline previous first.
  // Settle only after the write attempt, matching the success path: a thrown
  // first respond still retries cancelled, and the old handler must not answer later.
  if (holder._activeQuestionRequest && !holder._activeQuestionRequest.settled) {
    const prev = holder._activeQuestionRequest;
    prev.cancelled = true;
    try {
      if (typeof log === 'function') {
        log(`[GROK-QUESTION] Replacing active question - cancelling previous id=${prev.id}`);
      }
      acp.respond(prev.id, { outcome: 'cancelled' });
    } catch (e) {
      if (typeof log === 'function') {
        log(`[GROK-QUESTION] failed to decline previous question id=${prev.id}:`, e?.message || e);
      }
      try {
        acp.respond(prev.id, { outcome: 'cancelled' });
      } catch {
        // The pipe is already dead. Still settle so a late dialog answer cannot send accepted.
      }
    }
    prev.settled = true;
  }

  const currentRequest = { id, settled: false, cancelled: false };
  holder._activeQuestionRequest = currentRequest;

  try {
    const reqData = extractQuestionRequest(params);
    const normalized = normalizeGrokQuestions(reqData.questions);

    if (typeof emit === 'function') {
      emit('ask_user_question', {
        id,
        sessionId: reqData.sessionId,
        toolCallId: reqData.toolCallId,
        questions: normalized,
      });
    }

    let answers = null;
    try {
      answers = await requestQuestions({
        questions: normalized,
        provider: 'grok',
      });
    } catch (err) {
      if (typeof log === 'function') {
        log('[GROK-QUESTION] error waiting for answers:', err?.message || err);
      }
      answers = null;
    }

    // If cancelled or replaced while in-flight, do not answer again
    if (currentRequest.settled) {
      return true;
    }

    const response = mapAnswersToGrokResponse(answers, reqData.questions);
    acp.respond(id, response);
    currentRequest.settled = true;
    if (holder._activeQuestionRequest === currentRequest) {
      holder._activeQuestionRequest = null;
    }
    return true;
  } catch (err) {
    if (typeof log === 'function') {
      log('[GROK-QUESTION] unexpected error in question handler:', err?.message || err);
    }
    if (!currentRequest.settled) {
      currentRequest.settled = true;
      if (holder._activeQuestionRequest === currentRequest) {
        holder._activeQuestionRequest = null;
      }
      try {
        acp.respond(id, { outcome: 'cancelled' });
      } catch {}
    }
    return true;
  }
}
