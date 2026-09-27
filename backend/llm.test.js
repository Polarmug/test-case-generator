const test = require('node:test');
const assert = require('node:assert');
const {
  normalize, parseJson, parseCriteria, parseGenerateRequest, formatPrompt, extractBobText, extractBobStats, tryProviders
} = require('./llm');

const input = {
  storyId: '005',
  story: 'As a bank customer, I want to transfer money so that I can pay people quickly.',
  criteria: ['transfer succeeds when the balance is sufficient', 'daily limit is 50,000 PHP']
};

// ---------- parseJson ----------

test('parseJson strips markdown fences and surrounding prose', () => {
  const text = 'Here you go:\n```json\n{"testCases": []}\n```\nHope this helps!';
  assert.deepStrictEqual(parseJson(text), { testCases: [] });
});

test('parseJson throws when there is no JSON', () => {
  assert.throws(() => parseJson('Sorry, I cannot help with that.'));
});

// ---------- normalize ----------

test('normalize fixes malformed test cases', () => {
  const { testCases } = normalize({
    testCases: [
      { testCaseId: 'TC-1', type: 'positive', steps: '1. Open page\n2. Click login', criteria: [1] },
      { type: 'Boundary', steps: null },
      'garbage',
      null
    ]
  }, input);
  assert.strictEqual(testCases.length, 2);
  assert.strictEqual(testCases[0].type, 'Happy Path');
  assert.deepStrictEqual(testCases[0].steps, ['Open page', 'Click login']);
  assert.strictEqual(testCases[0].preconditions, '');
  assert.strictEqual(testCases[1].type, 'Edge Case');
  assert.deepStrictEqual(testCases[1].steps, []);
  assert.deepStrictEqual(testCases[1].criteria, []);
});

test('normalize renumbers IDs to TC-<storyId>-NN and sets storyId', () => {
  const { testCases } = normalize({
    testCases: [{ testCaseId: 'weird', storyId: '999' }, { testCaseId: 'weird' }]
  }, input);
  assert.deepStrictEqual(testCases.map(tc => tc.testCaseId), ['TC-005-01', 'TC-005-02']);
  assert.deepStrictEqual(testCases.map(tc => tc.storyId), ['005', '005']);
});

test('normalize computes coverage from the user criteria, not the model', () => {
  const { coverage, testCases } = normalize({
    testCases: [
      { criteria: [1] },
      { criteria: ['1', 'AC2', 7, 0] }, // strings and "AC2" parse; out-of-range numbers are dropped
      { criteria: [] }
    ],
    coverage: [{ criterion: 'made up by the model', testCaseIds: ['TC-X'] }]
  }, input);
  assert.deepStrictEqual(testCases[1].criteria, [1, 2]);
  assert.deepStrictEqual(coverage, [
    { criterion: input.criteria[0], testCaseIds: ['TC-005-01', 'TC-005-02'] },
    { criterion: input.criteria[1], testCaseIds: ['TC-005-02'] }
  ]);
});

test('normalize marks criteria with no test case as uncovered', () => {
  const { coverage } = normalize({ testCases: [{ criteria: [1] }] }, input);
  assert.deepStrictEqual(coverage[1].testCaseIds, []);
});

test('normalize reads priority and reason, defaulting unclear values to Medium', () => {
  const { testCases } = normalize({
    testCases: [
      { priority: 'High', priorityReason: ' money could be lost ' },
      { priority: 'critical' },
      { priority: 'low' },
      { priority: 'P3' },
      { priority: 'urgent-ish' },
      {}
    ]
  }, input);
  assert.deepStrictEqual(testCases.map(tc => tc.priority), ['High', 'High', 'Low', 'Low', 'Medium', 'Medium']);
  assert.strictEqual(testCases[0].priorityReason, 'money could be lost');
  assert.strictEqual(testCases[5].priorityReason, '');
});

test('normalize reads gaps and cleans them up', () => {
  const { gaps } = normalize({
    testCases: [],
    gaps: [
      { kind: 'Unclear', criterion: 2, title: 'Limit resets when?', questions: ['Midnight or rolling 24h?'], suggestion: 'limit resets at midnight' },
      { kind: 'ambiguous', criterion: 9, title: 'Bad criterion number' }, // no such criterion -> Missing
      { kind: 'Missing', criterion: 1, title: 'Own account', questions: 'Can I send to myself?\nWhat error?' },
      { title: '', questions: [] }, // empty -> dropped
      'garbage'
    ]
  }, input);
  assert.deepStrictEqual(gaps, [
    { kind: 'Unclear', criterion: 2, title: 'Limit resets when?', questions: ['Midnight or rolling 24h?'], suggestion: 'limit resets at midnight' },
    { kind: 'Missing', criterion: null, title: 'Bad criterion number', questions: [], suggestion: '' },
    { kind: 'Missing', criterion: null, title: 'Own account', questions: ['Can I send to myself?', 'What error?'], suggestion: '' }
  ]);
});

test('normalize caps gaps at 5 and defaults to none', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'Missing', title: `gap ${i}` }));
  assert.strictEqual(normalize({ testCases: [], gaps: many }, input).gaps.length, 5);
  assert.deepStrictEqual(normalize({ testCases: [] }, input).gaps, []);
});

test('normalize handles missing testCases', () => {
  const empty = normalize({}, input);
  assert.deepStrictEqual(empty.testCases, []);
  assert.strictEqual(empty.coverage.length, 2);
  assert.deepStrictEqual(normalize(null, input).testCases, []);
});

// ---------- request parsing ----------

test('parseCriteria splits lines and strips bullets and numbering', () => {
  assert.deepStrictEqual(
    parseCriteria('- first\n\n2. second\n* third\n  • fourth  \n5) fifth'),
    ['first', 'second', 'third', 'fourth', 'fifth']
  );
  assert.deepStrictEqual(parseCriteria(['a', ' ', '- b']), ['a', 'b']);
});

test('parseGenerateRequest accepts separate fields', () => {
  const parsed = parseGenerateRequest({ storyId: ' 005 ', story: ' As a user... ', criteria: 'one\ntwo' });
  assert.deepStrictEqual(parsed, { storyId: '005', story: 'As a user...', criteria: ['one', 'two'] });
});

test('parseGenerateRequest defaults and sanitizes the story ID', () => {
  assert.strictEqual(parseGenerateRequest({ story: 's', criteria: ['c'] }).storyId, '001');
  assert.strictEqual(parseGenerateRequest({ storyId: 'US 42/x', story: 's', criteria: ['c'] }).storyId, 'US42x');
});

test('parseGenerateRequest splits a legacy single-text story', () => {
  const parsed = parseGenerateRequest({
    userStory: 'Story ID: 001\nAs a user, I want to log in.\nAcceptance criteria:\n- valid login works\n- wrong password rejected'
  });
  assert.deepStrictEqual(parsed, {
    storyId: '001',
    story: 'As a user, I want to log in.',
    criteria: ['valid login works', 'wrong password rejected']
  });
});

test('parseGenerateRequest rejects missing story or criteria', () => {
  assert.throws(() => parseGenerateRequest({ story: '', criteria: 'c' }), /user story/);
  assert.throws(() => parseGenerateRequest({ story: 's', criteria: '  \n ' }), /acceptance criterion/);
  assert.throws(() => parseGenerateRequest({ story: 's', criteria: Array(21).fill('c') }), /Too many/);
});

test('formatPrompt numbers the criteria', () => {
  const prompt = formatPrompt(input);
  assert.match(prompt, /Story ID: 005/);
  assert.match(prompt, /1\. transfer succeeds/);
  assert.match(prompt, /2\. daily limit/);
});

// ---------- Bob Shell output ----------

test('extractBobText reads last_message as a string', () => {
  const out = JSON.stringify({ type: 'result', status: 'success', last_message: '{"testCases": []}' });
  assert.strictEqual(extractBobText(out), '{"testCases": []}');
});

test('extractBobText reads last_message as a message object', () => {
  const out = JSON.stringify({ status: 'success', last_message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  assert.strictEqual(extractBobText(out), 'hi');
});

test('extractBobStats reads duration and cost from Bob Shell output', () => {
  const out = JSON.stringify({ status: 'success', stats: { task_id: 'x', duration_ms: 2341, session_costs: 0.010014 }, last_message: 'hi' });
  assert.deepStrictEqual(extractBobStats(out), { durationMs: 2341, cost: 0.010014 });
});

test('extractBobStats skips missing or invalid stats', () => {
  assert.deepStrictEqual(extractBobStats(JSON.stringify({ status: 'success', last_message: 'hi' })), {});
  assert.deepStrictEqual(extractBobStats(JSON.stringify({ stats: { duration_ms: 'soon', session_costs: -1 } })), {});
});

test('extractBobText rejects failed runs', () => {
  assert.throws(() => extractBobText(JSON.stringify({ status: 'error', last_message: 'x' })));
});

// ---------- provider chain ----------

const good = { testCases: [{ type: 'Negative', steps: ['a'], criteria: [1] }] };

test('tryProviders passes provider stats through', async () => {
  const result = await tryProviders([
    { name: 'bob', model: 'Bob Shell 2.0.5', call: async () => ({ content: JSON.stringify(good), stats: { durationMs: 24300, cost: 0.04 } }) }
  ], input);
  assert.deepStrictEqual(result.stats, { durationMs: 24300, cost: 0.04 });
  assert.strictEqual(result.model, 'Bob Shell 2.0.5');
});

test('tryProviders sends the formatted prompt to providers', async () => {
  let received;
  await tryProviders([{ name: 'bob', model: 'Bob Shell', call: async p => { received = p; return JSON.stringify(good); } }], input);
  assert.strictEqual(received, formatPrompt(input));
});

test('tryProviders falls back to the next provider when one fails', async () => {
  const result = await tryProviders([
    { name: 'bob', model: 'Bob Shell', call: async () => { throw new Error('out of bobcoins'); } },
    { name: 'watsonx', model: 'granite', call: async () => JSON.stringify(good) }
  ], input);
  assert.strictEqual(result.provider, 'watsonx');
  assert.strictEqual(result.testCases[0].type, 'Negative');
});

test('tryProviders skips a provider that returns no test cases', async () => {
  const result = await tryProviders([
    { name: 'bob', model: 'Bob Shell', call: async () => '{"testCases": []}' },
    { name: 'watsonx', model: 'granite', call: async () => JSON.stringify(good) }
  ], input);
  assert.strictEqual(result.provider, 'watsonx');
});

test('tryProviders uses the first provider when it works', async () => {
  const result = await tryProviders([
    { name: 'bob', model: 'Bob Shell', call: async () => JSON.stringify(good) },
    { name: 'watsonx', model: 'granite', call: async () => { throw new Error('should not be called'); } }
  ], input);
  assert.strictEqual(result.provider, 'bob');
});

test('tryProviders reports the model a provider actually used', async () => {
  const result = await tryProviders([
    { name: 'gemini', model: 'gemini-3.5-flash', call: async () => ({ content: JSON.stringify(good), model: 'gemini-3.5-flash-lite' }) }
  ], input);
  assert.strictEqual(result.model, 'gemini-3.5-flash-lite');
});

test('tryProviders throws when every provider fails', async () => {
  await assert.rejects(tryProviders([
    { name: 'bob', model: 'Bob Shell', call: async () => { throw new Error('down'); } }
  ], input));
  await assert.rejects(tryProviders([], input));
});
