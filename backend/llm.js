const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_PROMPT = `You are a QA test-case generator. Given a user story and its numbered acceptance criteria, generate comprehensive test cases.

Rules:
- Generate 8 to 12 test cases, with at least 2 of each type
- Cover happy path, negative cases, and edge cases (boundaries, empty/invalid input, limits, timing)
- "type" must be exactly one of: "Happy Path", "Negative", "Edge Case"
- "criteria" lists the numbers of the acceptance criteria the test case verifies
- Every acceptance criterion must be verified by at least one test case
- Test Case ID format: TC-[StoryID]-[two-digit number]
- "steps" must be an array of strings
- Do not read, create or edit any files; answer directly
- Return ONLY valid JSON, no other text, no markdown

Output JSON format:
{
  "testCases": [
    {
      "testCaseId": "TC-001-01",
      "scenario": "short description",
      "type": "Happy Path",
      "criteria": [1],
      "preconditions": "...",
      "steps": ["step 1", "step 2"],
      "testData": "...",
      "expectedResult": "...",
      "storyId": "001"
    }
  ]
}`;

const DEFAULT_STORY_ID = '001';

// The user message sent to every provider: story plus numbered criteria.
function formatPrompt({ storyId, story, criteria }) {
  return [
    `Story ID: ${storyId}`,
    'User story:',
    story,
    'Acceptance criteria:',
    ...criteria.map((c, i) => `${i + 1}. ${c}`)
  ].join('\n');
}

// Split pasted criteria into one entry per line, dropping bullets and numbering.
function parseCriteria(value) {
  const lines = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  return lines
    .map(line => String(line).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

const MAX_STORY_LENGTH = 4000;
const MAX_CRITERIA = 20;
const MAX_CRITERION_LENGTH = 500;

// Split a whole pasted story ("Story ID: ... / story text / Acceptance criteria: ...") into parts.
function splitFullStory(text) {
  const idMatch = text.match(/^\s*story\s*id\s*[:#-]?\s*(\S+)\s*$/im);
  const withoutId = idMatch ? text.replace(idMatch[0], '') : text;
  const [storyPart, ...criteriaParts] = withoutId.split(/^\s*acceptance\s+criteria\s*:?\s*$/im);
  return { storyId: idMatch?.[1], story: storyPart, criteria: criteriaParts.join('\n') };
}

// Validate a /api/generate body into { storyId, story, criteria[] }. Throws with a user-facing message.
// Accepts { storyId, story, criteria } (criteria as an array or newline text), or a legacy { userStory } blob.
function parseGenerateRequest(body) {
  const fields = typeof body?.story === 'string' || body?.criteria != null
    ? body
    : splitFullStory(typeof body?.userStory === 'string' ? body.userStory : '');

  const story = typeof fields.story === 'string' ? fields.story.trim() : '';
  const criteria = parseCriteria(fields.criteria);
  // Story IDs end up in test case IDs, so keep them short and filename-safe.
  const storyId = String(fields.storyId ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || DEFAULT_STORY_ID;

  if (!story) throw new Error('Please enter the user story.');
  if (story.length > MAX_STORY_LENGTH) throw new Error(`User story is too long (max ${MAX_STORY_LENGTH} characters).`);
  if (criteria.length === 0) throw new Error('Please add at least one acceptance criterion (one per line).');
  if (criteria.length > MAX_CRITERIA) throw new Error(`Too many acceptance criteria (max ${MAX_CRITERIA}).`);
  if (criteria.some(c => c.length > MAX_CRITERION_LENGTH)) {
    throw new Error(`Each acceptance criterion must be under ${MAX_CRITERION_LENGTH} characters.`);
  }
  return { storyId, story, criteria };
}

const BOB_TIMEOUT_MS = 120_000;

// Treat unset values and the "your_..." placeholders from .env.example as missing.
function env(name) {
  const value = (process.env[name] || '').trim();
  return value && !value.startsWith('your_') ? value : undefined;
}

// BOB_API_KEY_2 is a spare key, used when the first one fails (e.g. out of bobcoins or revoked).
function bobKeys() {
  return [env('BOB_API_KEY'), env('BOB_API_KEY_2')].filter(Boolean);
}

function bobConfigured() {
  return bobKeys().length > 0;
}

function watsonxConfigured() {
  return Boolean(env('WATSONX_API_KEY') && env('WATSONX_PROJECT_ID'));
}

// Bob runs in an empty scratch folder so it has no project files to read or modify.
const BOB_WORKSPACE = path.join(os.tmpdir(), 'test-case-generator-bob');
fs.mkdirSync(BOB_WORKSPACE, { recursive: true });

// Bob Shell's JSON output puts the answer in `last_message`; accept a string or a message object.
function extractBobText(stdout) {
  const output = parseJson(stdout);
  if (output.status && output.status !== 'success' && output.status !== 'completed') {
    throw new Error(`Bob Shell finished with status "${output.status}"`);
  }
  const message = output.last_message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    if (typeof message.content === 'string') return message.content;
    if (typeof message.text === 'string') return message.text;
    if (Array.isArray(message.content)) {
      return message.content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
    }
  }
  throw new Error('Bob Shell output had no last_message');
}

// Try each Bob key in turn. A timeout means Bob itself is slow, so the spare key isn't tried then.
async function callBob(userStory) {
  const keys = bobKeys();
  let lastError;
  for (const [i, apiKey] of keys.entries()) {
    try {
      return await runBob(userStory, apiKey);
    } catch (err) {
      lastError = err;
      if (err.timedOut || i === keys.length - 1) break;
      console.error(`[bob] key ${i + 1} failed (${err.message.slice(0, 120)}), trying spare key`);
    }
  }
  throw lastError;
}

// Run `bob run --format json` with the prompt on stdin and return Bob's final answer.
function runBob(userStory, apiKey) {
  const command = env('BOB_COMMAND') || 'bob';
  const args = ['run', '--format', 'json', '--mode', env('BOB_MODE') || 'ask', '--disable-mcp',
    '--disable-subagents', '--log-level', 'silent', '--trust', '--workspace', `"${BOB_WORKSPACE}"`];
  if (env('BOB_MAX_COST')) args.push('--max-cost', env('BOB_MAX_COST'));
  // Headless runs can't answer the license prompt; the operator opts in explicitly.
  if (env('BOB_ACCEPT_LICENSE') === 'true') args.push('--accept-license');

  return new Promise((resolve, reject) => {
    // Run through the shell so Windows can resolve bob.cmd / bob.ps1 shims. Every part of the
    // command line is a fixed string or config value; the user story only goes in via stdin.
    const commandLine = [command.includes(' ') ? `"${command}"` : command, ...args].join(' ');
    const child = spawn(commandLine, {
      shell: true,
      env: { ...process.env, BOB_API_KEY: apiKey, NODE_NO_WARNINGS: '1' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`Bob Shell timed out after ${BOB_TIMEOUT_MS / 1000}s`), { timedOut: true }));
    }, BOB_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Could not start Bob Shell (${command}): ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`Bob Shell exited with code ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      }
      try {
        resolve(extractBobText(stdout));
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.end(`${SYSTEM_PROMPT}\n\n${userStory}\n`);
  });
}

// ---------- IBM watsonx.ai (first backup when Bob fails, e.g. out of bobcoins) ----------

const WATSONX_TIMEOUT_MS = 90_000;

let iamToken = null;
let iamTokenExpiresAt = 0;

// Exchange the IBM Cloud API key for a short-lived IAM bearer token, cached until near expiry.
async function getIamToken() {
  if (iamToken && Date.now() < iamTokenExpiresAt - 60_000) return iamToken;
  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: env('WATSONX_API_KEY')
    }),
    signal: AbortSignal.timeout(WATSONX_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`IBM IAM token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  iamToken = data.access_token;
  iamTokenExpiresAt = data.expiration * 1000;
  return iamToken;
}

async function callWatsonx(userStory) {
  const baseUrl = env('WATSONX_URL') || 'https://us-south.ml.cloud.ibm.com';
  const res = await fetch(`${baseUrl}/ml/v1/text/chat?version=2024-05-31`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getIamToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model_id: watsonxModel(),
      project_id: env('WATSONX_PROJECT_ID'),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userStory }
      ],
      temperature: 0.3,
      max_tokens: 4000
    }),
    signal: AbortSignal.timeout(WATSONX_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`watsonx.ai request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function watsonxModel() {
  return env('WATSONX_MODEL_ID') || 'ibm/granite-4-h-small';
}

// ---------- Groq (backup) ----------

const HTTP_TIMEOUT_MS = 90_000;

function groqModel() {
  return env('GROQ_MODEL') || 'openai/gpt-oss-120b';
}

async function callGroq(userStory) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('GROQ_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: groqModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userStory }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Groq request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ---------- Google Gemini (backup) ----------

// GEMINI_MODEL may list several models; later ones are tried when Google reports the earlier ones as overloaded.
function geminiModels() {
  return (env('GEMINI_MODEL') || 'gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
}

async function callGemini(userStory) {
  let lastError;
  for (const model of geminiModels()) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userStory }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return { content: parts.map(p => p.text ?? '').join(''), model };
    }
    lastError = new Error(`Gemini ${model} request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    // Only overload / rate-limit errors are worth retrying on another model.
    if (![429, 500, 503].includes(res.status)) break;
    console.error(`[gemini] ${model} unavailable (${res.status}), trying next model`);
  }
  throw lastError;
}

// ---------- Parsing and normalizing model output ----------

// Models sometimes wrap JSON in ```fences``` or add prose around it.
function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Response contained no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function str(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeType(value) {
  const t = str(value).toLowerCase();
  if (t.includes('happy') || t.includes('positive')) return 'Happy Path';
  if (t.includes('neg')) return 'Negative';
  if (t.includes('edge') || t.includes('boundary')) return 'Edge Case';
  return 'Other';
}

function normalizeSteps(value) {
  const steps = Array.isArray(value) ? value.map(str) : str(value).split(/\r?\n|;\s*/);
  return steps.map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
}

// Criterion numbers (1-based) a test case claims to verify, limited to ones that exist.
function normalizeCriteriaRefs(value, criteriaCount) {
  const refs = (Array.isArray(value) ? value : [value])
    .map(v => parseInt(String(v).replace(/\D/g, ''), 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= criteriaCount);
  return [...new Set(refs)].sort((a, b) => a - b);
}

// Coerce whatever the model returned into the exact shape the frontend expects.
// IDs are renumbered so they are unique and match TC-<storyId>-NN, and coverage is computed
// from the user's own criteria list rather than trusted from the model.
function normalize(raw, { storyId, criteria }) {
  const list = Array.isArray(raw?.testCases) ? raw.testCases : [];
  const testCases = list
    .filter(tc => tc && typeof tc === 'object')
    .map((tc, i) => ({
      testCaseId: `TC-${storyId}-${String(i + 1).padStart(2, '0')}`,
      scenario: str(tc.scenario),
      type: normalizeType(tc.type),
      criteria: normalizeCriteriaRefs(tc.criteria, criteria.length),
      preconditions: str(tc.preconditions),
      steps: normalizeSteps(tc.steps),
      testData: str(tc.testData),
      expectedResult: str(tc.expectedResult),
      storyId
    }));

  const coverage = criteria.map((criterion, i) => ({
    criterion,
    testCaseIds: testCases.filter(tc => tc.criteria.includes(i + 1)).map(tc => tc.testCaseId)
  }));

  return { testCases, coverage };
}

const PROVIDERS = {
  bob: { configured: bobConfigured, model: () => 'Bob Shell', call: callBob },
  watsonx: { configured: watsonxConfigured, model: watsonxModel, call: callWatsonx },
  groq: { configured: () => Boolean(env('GROQ_API_KEY')), model: groqModel, call: callGroq },
  gemini: { configured: () => Boolean(env('GEMINI_API_KEY')), model: () => geminiModels()[0], call: callGemini }
};

// Providers in priority order (AI_PROVIDERS overrides it); only those with credentials are tried.
function configuredProviders() {
  const order = (env('AI_PROVIDERS') || 'bob,watsonx,groq,gemini').split(',').map(s => s.trim().toLowerCase());
  return order
    .filter(name => PROVIDERS[name]?.configured())
    .map(name => ({ name, model: PROVIDERS[name].model(), call: PROVIDERS[name].call }));
}

// Try each provider in turn; the first usable answer wins. Throws if all fail.
// `input` is { storyId, story, criteria[] }.
async function tryProviders(providers, input) {
  if (providers.length === 0) throw new Error('No AI provider configured in backend/.env');
  const prompt = formatPrompt(input);
  let lastError;
  for (const provider of providers) {
    try {
      // A provider returns the answer text, or { content, model } when the model used can vary.
      const answer = await provider.call(prompt);
      const content = typeof answer === 'string' ? answer : answer.content;
      const result = normalize(parseJson(content), input);
      if (result.testCases.length === 0) throw new Error('returned no test cases');
      return { ...result, provider: provider.name, model: answer.model ?? provider.model };
    } catch (err) {
      console.error(`[${provider.name}] failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError;
}

function generateTestCases(input) {
  return tryProviders(configuredProviders(), input);
}

module.exports = {
  generateTestCases, configuredProviders, tryProviders, normalize, parseJson, parseCriteria, parseGenerateRequest,
  formatPrompt, extractBobText, DEFAULT_STORY_ID
};
