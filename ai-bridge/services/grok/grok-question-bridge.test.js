import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAskUserQuestionRequestMethod,
  extractQuestionRequest,
  normalizeGrokQuestions,
  mapAnswersToGrokResponse,
  handleAskUserQuestionServerRequest,
} from './grok-question-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'ask-user-question.fixture.json'), 'utf8')
);

test('isAskUserQuestionRequestMethod accepts only the captured fixture method', () => {
  assert.equal(isAskUserQuestionRequestMethod('_x.ai/ask_user_question'), true);
  assert.equal(isAskUserQuestionRequestMethod('x.ai/ask_user_question'), false);
  assert.equal(isAskUserQuestionRequestMethod('ask_user_question'), false);
  assert.equal(isAskUserQuestionRequestMethod('_ask_user_question'), false);
  assert.equal(
    isAskUserQuestionRequestMethod('ext_method', { method: 'x.ai/ask_user_question' }),
    false
  );
  assert.equal(
    isAskUserQuestionRequestMethod('_ext_method', { method: '_x.ai/ask_user_question' }),
    false
  );

  // Other server requests should NOT be recognised as ask_user_question
  assert.equal(isAskUserQuestionRequestMethod('session/request_permission'), false);
  assert.equal(isAskUserQuestionRequestMethod('request_permission'), false);
  assert.equal(isAskUserQuestionRequestMethod('exit_plan_mode'), false);
  assert.equal(isAskUserQuestionRequestMethod('_x.ai/plan_approval'), false);
  assert.equal(isAskUserQuestionRequestMethod('fs/read_text_file'), false);
  assert.equal(isAskUserQuestionRequestMethod(null), false);
  assert.equal(isAskUserQuestionRequestMethod(undefined), false);
});

test('normalizeGrokQuestions folds preview into description when description is empty', () => {
  const normalized = normalizeGrokQuestions([
    {
      id: 'q1',
      question: 'Choose framework',
      options: [
        { label: 'React', description: 'Web UI library', preview: null },
        { label: 'Vue', description: '', preview: 'The Progressive JavaScript Framework' },
      ],
      multiSelect: true,
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'q1');
  assert.equal(normalized[0].question, 'Choose framework');
  assert.equal(normalized[0].multiSelect, true);
  assert.equal(normalized[0].options[0].description, 'Web UI library');
  assert.equal(normalized[0].options[1].description, 'The Progressive JavaScript Framework');
});

test('mapAnswersToGrokResponse returns accepted keyed only by question text', () => {
  const questions = [
    {
      id: 'package_manager',
      question: 'Which package manager would you like to use for this project?',
    },
  ];

  const answers = {
    'Which package manager would you like to use for this project?': 'pnpm',
  };

  const response = mapAnswersToGrokResponse(answers, questions);
  assert.deepEqual(response, {
    outcome: 'accepted',
    answers: {
      'Which package manager would you like to use for this project?': 'pnpm',
    },
  });
});

test('mapAnswersToGrokResponse returns accepted with a custom Other answer', () => {
  const questions = [
    {
      id: 'db_choice',
      question: 'Which database?',
    },
  ];

  const answers = {
    'Which database?': 'CustomInHouseDB',
  };

  const response = mapAnswersToGrokResponse(answers, questions);
  assert.deepEqual(response, {
    outcome: 'accepted',
    answers: {
      'Which database?': 'CustomInHouseDB',
    },
  });
});

test('mapAnswersToGrokResponse returns cancelled when answers are missing, empty, or all null', () => {
  assert.deepEqual(mapAnswersToGrokResponse(null), { outcome: 'cancelled' });
  assert.deepEqual(mapAnswersToGrokResponse({}), { outcome: 'cancelled' });
  assert.deepEqual(mapAnswersToGrokResponse(undefined), { outcome: 'cancelled' });
  assert.deepEqual(
    mapAnswersToGrokResponse(
      { 'Which database?': null },
      [{ id: 'db_choice', question: 'Which database?' }],
    ),
    { outcome: 'cancelled' },
  );
});

test('handleAskUserQuestionServerRequest handles fixture request and responds with Accepted', async () => {
  const responses = [];
  const fakeAcp = {
    respond: (id, result) => {
      responses.push({ id, result });
    },
  };

  let requestedInput = null;
  const fakeRequestQuestions = async (input) => {
    requestedInput = input;
    return {
      'Which package manager would you like to use for this project?': 'pnpm',
    };
  };

  const handled = await handleAskUserQuestionServerRequest({
    method: fixture.method,
    params: fixture.params,
    id: fixture.id,
    acp: fakeAcp,
    requestQuestions: fakeRequestQuestions,
  });

  assert.equal(handled, true);
  assert.ok(requestedInput);
  assert.equal(requestedInput.provider, 'grok');
  assert.equal(requestedInput.questions.length, 1);
  assert.equal(requestedInput.questions[0].question, 'Which package manager would you like to use for this project?');

  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, fixture.id);
  assert.equal(responses[0].result.outcome, 'accepted');
  assert.equal(
    responses[0].result.answers['Which package manager would you like to use for this project?'],
    'pnpm',
  );
  assert.equal(responses[0].result.answers.package_manager, undefined);
  assert.notDeepEqual(responses[0].result, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
});

test('handleAskUserQuestionServerRequest handles dialog cancel / null by responding with cancelled', async () => {
  const responses = [];
  const fakeAcp = {
    respond: (id, result) => {
      responses.push({ id, result });
    },
  };

  const handled = await handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: fixture.params,
    id: 102,
    acp: fakeAcp,
    requestQuestions: async () => null,
  });

  assert.equal(handled, true);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 102);
  assert.deepEqual(responses[0].result, { outcome: 'cancelled' });
});

test('handleAskUserQuestionServerRequest returns false for non-question methods without responding', async () => {
  const responses = [];
  const fakeAcp = {
    respond: (id, result) => {
      responses.push({ id, result });
    },
  };

  const handledPlan = await handleAskUserQuestionServerRequest({
    method: 'exit_plan_mode',
    params: {},
    id: 103,
    acp: fakeAcp,
    requestQuestions: async () => {
      assert.fail('should not ask questions');
    },
  });

  const handledPermission = await handleAskUserQuestionServerRequest({
    method: 'session/request_permission',
    params: {},
    id: 104,
    acp: fakeAcp,
    requestQuestions: async () => {
      assert.fail('should not ask questions');
    },
  });

  assert.equal(handledPlan, false);
  assert.equal(handledPermission, false);
  assert.equal(responses.length, 0);
});

test('handleAskUserQuestionServerRequest declines previous in-flight question when replaced (AC 8)', async () => {
  const responses = [];
  const fakeAcp = {
    respond: (id, result) => {
      responses.push({ id, result });
    },
  };

  let resolveFirstQuestion;
  const firstPromise = new Promise((resolve) => {
    resolveFirstQuestion = resolve;
  });

  // Idle handler stores the in-flight id on the ACP client.
  const req1Promise = handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: fixture.params,
    id: 201,
    acp: fakeAcp,
    requestQuestions: () => firstPromise,
  });

  // The in-turn handler used to keep a separate runtime object. The same client must still decline.
  const req2Promise = handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: {
      ...fixture.params,
      questions: [
        {
          id: 'confirm',
          question: 'Are you sure?',
          options: [{ label: 'Yes', description: '' }],
        },
      ],
    },
    id: 202,
    acp: fakeAcp,
    requestQuestions: async () => ({ 'Are you sure?': 'Yes' }),
  });

  await req2Promise;

  assert.ok(responses.length >= 2);
  assert.equal(responses[0].id, 201);
  assert.deepEqual(responses[0].result, { outcome: 'cancelled' });

  assert.equal(responses[1].id, 202);
  assert.equal(responses[1].result.outcome, 'accepted');
  assert.equal(responses[1].result.answers['Are you sure?'], 'Yes');
  assert.equal(responses[1].result.answers.confirm, undefined);

  // Now resolve first question late (e.g. user answered the old prompt late)
  resolveFirstQuestion({
    'Which package manager would you like to use for this project?': 'npm',
  });
  await req1Promise;

  // It should NOT send another response for id 201
  const id201Responses = responses.filter((r) => r.id === 201);
  assert.equal(id201Responses.length, 1);
});

test('handleAskUserQuestionServerRequest still answers cancelled when the first respond throws', async () => {
  const responses = [];
  let calls = 0;
  const fakeAcp = {
    respond: (id, result) => {
      calls += 1;
      if (calls === 1) throw new Error('broken pipe');
      responses.push({ id, result });
    },
  };

  const handled = await handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: fixture.params,
    id: 301,
    acp: fakeAcp,
    requestQuestions: async () => ({
      'Which package manager would you like to use for this project?': 'pnpm',
    }),
    log: () => {},
  });

  assert.equal(handled, true);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 301);
  assert.deepEqual(responses[0].result, { outcome: 'cancelled' });
});

test('replacement still declines the previous id when the first respond throws', async () => {
  const responses = [];
  let calls = 0;
  const fakeAcp = {
    respond: (id, result) => {
      calls += 1;
      if (calls === 1) throw new Error('broken pipe');
      responses.push({ id, result });
    },
  };

  let resolveFirstQuestion;
  const firstPromise = new Promise((resolve) => {
    resolveFirstQuestion = resolve;
  });

  const req1Promise = handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: fixture.params,
    id: 401,
    acp: fakeAcp,
    requestQuestions: () => firstPromise,
    log: () => {},
  });

  const req2Promise = handleAskUserQuestionServerRequest({
    method: '_x.ai/ask_user_question',
    params: {
      ...fixture.params,
      questions: [
        {
          id: 'confirm',
          question: 'Are you sure?',
          options: [{ label: 'Yes', description: '' }],
        },
      ],
    },
    id: 402,
    acp: fakeAcp,
    requestQuestions: async () => ({ 'Are you sure?': 'Yes' }),
    log: () => {},
  });

  await req2Promise;

  assert.equal(responses[0].id, 401);
  assert.deepEqual(responses[0].result, { outcome: 'cancelled' });
  assert.equal(responses[1].id, 402);
  assert.equal(responses[1].result.outcome, 'accepted');
  assert.equal(responses[1].result.answers['Are you sure?'], 'Yes');

  resolveFirstQuestion({
    'Which package manager would you like to use for this project?': 'npm',
  });
  await req1Promise;

  assert.equal(responses.filter((r) => r.id === 401).length, 1);
});
