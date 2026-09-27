# AI Test-Case Generator

Enter a user story and its acceptance criteria → **IBM Bob** (with IBM watsonx.ai, Groq and Google Gemini as backups) generates test cases (Happy Path / Negative / Edge Case), each with a **priority** (High / Medium / Low, with a one-line reason) so you know what to run first, → shown in a table with an acceptance-criteria coverage check → edit or delete rows → export to CSV or Gherkin (`.feature`, Given / When / Then, tagged by test case ID, type and acceptance criterion).

## Input

Three fields: **Story ID** (optional, defaults to `001`), **User story**, and **Acceptance criteria** (one per line; bullets and numbering are stripped). The *Load example* menu fills in one of five sample stories.

The AI is given the criteria as a numbered list and tags each test case with the numbers it verifies. The backend then:

- renumbers test cases as `TC-<StoryID>-01`, `-02`, … so IDs are always unique and consistent
- builds the coverage check from **your** criteria list, so a criterion no test case verifies shows as *Not covered* instead of being silently dropped

API: `POST /api/generate` with `{ "storyId": "005", "story": "As a …", "criteria": ["…", "…"] }` (`criteria` may also be newline-separated text). A single `{ "userStory": "Story ID: …
As a …
Acceptance criteria:
- …" }` blob is still accepted.

## How Bob is used

The backend runs Bob Shell (Bob's command-line interface) in non-interactive mode for every request:

```
bob run --format json --mode ask --disable-mcp --workspace <empty temp folder>
```

The prompt (instructions + user story) goes in on stdin. Bob's JSON answer (`last_message`) is parsed and cleaned up before it reaches the frontend. Bob runs in an empty scratch folder, so it can't read or change project files.

## AI providers

Each request tries, in order:

1. **IBM Bob Shell**: primary. If `BOB_API_KEY_2` is set, it's tried when the first key fails (e.g. out of bobcoins or revoked)
2. **IBM watsonx.ai** (Granite, default `ibm/granite-4-h-small`): first backup when Bob fails, e.g. out of bobcoins, error or timeout
3. **Groq** (default `openai/gpt-oss-120b`): fast backup
4. **Google Gemini** (default `gemini-3.5-flash`, then `gemini-3.5-flash-lite` if Google reports it overloaded)
5. **Saved example** (`fallback.json`): last resort so the demo never shows an error

Change the order with `AI_PROVIDERS` in `.env`, e.g. `AI_PROVIDERS=groq,gemini` to test without spending bobcoins.

Providers without credentials in `.env` are skipped. The page's "Powered by" badge shows which one answered, and the backend logs why a provider failed.

## Structure

```
test-case-generator/
├── backend/               Node + Express, port 3001
│   ├── server.js          Routes: POST /api/generate, GET /api/health
│   ├── llm.js             Prompt, Bob Shell / watsonx.ai / Groq / Gemini calls, provider chain, JSON normalization
│   ├── fallback.json      Saved example result, served if Bob fails
│   ├── llm.test.js        Tests (npm test)
│   └── .env               API keys (never commit; template in .env.example)
└── frontend/              Vite + React + TypeScript, port 5173
    ├── src/App.tsx        UI: input, summary/filter, coverage, editable table, CSV export
    └── src/gherkin.ts     Gherkin .feature export
```

## Setup

1. Install Bob Shell (needs Node 24+). In PowerShell:
   ```
   powershell -c "irm -Uri https://bob.ibm.com/download/bobshell.ps1 | iex"
   ```
   Check it works: `bob --version`
2. Create an API key in the Bob web portal (bob.ibm.com) with **Scope = Inference**, and put it in `backend/.env`:
   ```
   BOB_API_KEY=...
   ```
3. Run:
   ```
   cd backend   && npm install && npm start
   cd frontend  && npm install && npm run dev
   ```
   Optionally add the watsonx.ai backup (see `.env.example`): `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL`.
   The backend prints the active chain, e.g. `AI providers: bob -> watsonx -> saved example`.
4. Open http://localhost:5173 and pick a story from **Load example…**.

## Deploy to Railway

The repo deploys as a single Railway service: the `Dockerfile` installs Bob Shell, builds the frontend, and runs the backend, which serves both the page and `/api/*` from one URL. `railway.json` sets the health check to `/api/health`.

```
npm install -g @railway/cli
railway login
railway init            # create a new project
railway up              # upload and build this folder
```

Then in the Railway dashboard, open the service:
- **Variables:** add `BOB_API_KEY` and `BOB_ACCEPT_LICENSE=true`, plus the `WATSONX_*`, `GROQ_API_KEY` and `GEMINI_API_KEY` variables for the backups (optionally `BOB_MAX_COST`, `RATE_LIMIT`, `MAX_CONCURRENT_BOB_RUNS`)
- **Settings → Networking → Generate Domain** to get the public URL

`.env` is excluded from the upload by `.dockerignore`; the key only lives in Railway's variables.

Public-use limits (each Bob run costs bobcoins): 10 generations per visitor per 15 minutes (`RATE_LIMIT`) and at most 2 Bob runs at once (`MAX_CONCURRENT_BOB_RUNS`).

## How it stays demo-safe

- Bob's output is parsed leniently (markdown fences stripped) and normalized: missing fields become empty strings, `steps` is always an array, `type` is mapped to Happy Path / Negative / Edge Case.
- If Bob fails or times out (120 s), the next provider answers instead. If all fail, the backend returns `fallback.json` with a visible notice instead of an error.

## Ideas for later

- Batch CSV upload of several stories
- Excel or TestRail/Jira import formats
