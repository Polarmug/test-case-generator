import { useState } from 'react';
import axios from 'axios';
import { toGherkin } from './gherkin';
import './App.css';

type TestType = 'Happy Path' | 'Negative' | 'Edge Case' | 'Other';
type Priority = 'High' | 'Medium' | 'Low';

interface TestCase {
  testCaseId: string;
  scenario: string;
  type: TestType;
  priority: Priority;
  priorityReason: string;
  criteria: number[]; // 1-based numbers of the acceptance criteria this test case verifies
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
  storyId: string;
  edited?: boolean;
}

// Form state for the row being edited; steps are edited as one step per line.
interface Draft {
  index: number;
  scenario: string;
  type: TestType;
  priority: Priority;
  preconditions: string;
  stepsText: string;
  testData: string;
  expectedResult: string;
}

interface Coverage {
  criterion: string;
  testCaseIds: string[];
}

// Story review finding: an existing criterion that is ambiguous, or something the story doesn't cover.
interface Gap {
  kind: 'Unclear' | 'Missing';
  criterion: number | null; // 1-based; set for Unclear gaps
  title: string;
  questions: string[];
  suggestion: string;
}

interface GenerateResponse {
  testCases: TestCase[];
  coverage: Coverage[];
  gaps?: Gap[];
  provider: string;
  model: string;
  stats?: { durationMs?: number; cost?: number }; // reported by Bob Shell for its run
  fallback: boolean;
  notice?: string;
  storyId?: string;
  story?: string;
}

function downloadFile(content: string, filename: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// In dev the backend runs separately on :3001; in production it serves this page, so use the same origin.
const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

const TYPES: TestType[] = ['Happy Path', 'Negative', 'Edge Case'];

const PRIORITIES: Priority[] = ['High', 'Medium', 'Low'];

// Sort rank; anything unexpected sorts with Medium.
const priorityRank = (p: string) => {
  const rank = PRIORITIES.indexOf(p as Priority);
  return rank === -1 ? 1 : rank;
};

// High -> Medium -> Low, keeping the original order within each priority.
const byPriority = <T extends { priority: string }>(list: T[]): T[] =>
  list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority) || a.index - b.index)
    .map(({ item }) => item);

const PROVIDER_LABELS: Record<string, string> = {
  bob: 'IBM Bob',
  watsonx: 'IBM watsonx.ai',
  groq: 'Groq',
  gemini: 'Google Gemini',
  fallback: 'Saved example'
};

interface Example {
  label: string;
  storyId: string;
  story: string;
  criteria: string[];
}

const EXAMPLES: Example[] = [
  {
    label: 'Login',
    storyId: '001',
    story: 'As a user, I want to log in so that I can access my account.',
    criteria: [
      'valid credentials grant access',
      'wrong password is rejected',
      'account locks after 5 failed attempts'
    ]
  },
  {
    label: 'Password reset',
    storyId: '002',
    story: 'As a registered user, I want to reset my password via email so that I can regain access if I forget it.',
    criteria: [
      'user can request a reset link by entering their registered email',
      'reset link expires after 30 minutes',
      'reset link can only be used once',
      'new password must be at least 8 characters and include a number',
      'unregistered emails show the same confirmation message as registered ones'
    ]
  },
  {
    label: 'Discount code',
    storyId: '003',
    story: 'As a shopper, I want to apply a discount code at checkout so that I can pay a lower price.',
    criteria: [
      'a valid code reduces the order total by its percentage',
      'expired codes are rejected with an error message',
      'only one code can be applied per order',
      'discount cannot reduce the total below 0',
      'code is case-insensitive'
    ]
  },
  {
    label: 'Assignment upload',
    storyId: '004',
    story: 'As a student, I want to upload my assignment as a PDF so that my teacher can grade it.',
    criteria: [
      'only PDF files are accepted',
      'maximum file size is 10 MB',
      'student can replace the file before the deadline',
      'uploads after the deadline are blocked',
      'student sees a confirmation with the file name and upload time'
    ]
  },
  {
    label: 'Bank transfer',
    storyId: '005',
    story: 'As a bank customer, I want to transfer money to another account so that I can pay people quickly.',
    criteria: [
      'transfer succeeds when the balance is sufficient',
      'transfer is blocked when the balance is insufficient',
      'daily transfer limit is 50,000 PHP',
      'recipient account number must be 12 digits',
      'user must confirm with a one-time PIN before the transfer is sent'
    ]
  }
];

// Greyed-out hints shown in the empty fields.
const PLACEHOLDERS = {
  storyId: 'e.g. 005',
  story: 'e.g. As a bank customer, I want to transfer money to another account so that I can pay people quickly.',
  criteria: [
    'One criterion per line, e.g.',
    'transfer succeeds when the balance is sufficient',
    'transfer is blocked when the balance is insufficient',
    'daily transfer limit is 50,000 PHP'
  ].join('\n')
};

// Same rules as the backend: one criterion per line, bullets and numbering dropped.
const parseCriteria = (text: string) =>
  text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

const slug = (text: string) => text.toLowerCase().replace(/\s+/g, '-');

const criteriaLabel = (refs: number[]) => refs.map(n => `AC${n}`).join(', ');

// "24.3 s · 0.041 bobcoins" from the stats Bob Shell reports; empty for other providers.
function formatBobStats(stats: GenerateResponse['stats']): string {
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.durationMs !== undefined) parts.push(`${(stats.durationMs / 1000).toFixed(1)} s`);
  if (stats.cost !== undefined) parts.push(`${stats.cost < 0.001 ? '<0.001' : stats.cost.toFixed(3)} bobcoins`);
  return parts.join(' · ');
}

type Theme = 'light' | 'dark';

// index.html sets data-theme before the first paint (saved choice, else the system setting).
const initialTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [storyId, setStoryId] = useState('');
  const [story, setStory] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<TestType | null>(null);
  const [highOnly, setHighOnly] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lastDeleted, setLastDeleted] = useState<{ testCase: TestCase; index: number; coverage: Coverage[] } | null>(null);
  const [addedGaps, setAddedGaps] = useState<number[]>([]); // indexes of gaps whose suggestion was added

  const criteriaList = parseCriteria(criteriaText);
  const canGenerate = !loading && story.trim() !== '' && criteriaList.length > 0;

  const loadExample = (label: string) => {
    const example = EXAMPLES.find(e => e.label === label);
    if (!example) return;
    setStoryId(example.storyId);
    setStory(example.story);
    setCriteriaText(example.criteria.join('\n'));
  };

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    // Only an explicit choice is saved, so the system setting keeps applying until the user picks one.
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Storage can be blocked (private mode); the toggle still works for this visit.
    }
  };

  const onCtrlEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
  };

  const testCases = result?.testCases ?? [];
  const coverage = result?.coverage ?? [];
  const resultStoryId = result?.storyId || testCases[0]?.storyId || '001';
  // Keep each row's position in the full list so edits/deletes work while a filter is on.
  // Rows are shown High -> Medium -> Low, keeping the generated order within each priority.
  const visible = testCases
    .map((tc, index) => ({ tc, index }))
    .filter(({ tc }) => !filter || tc.type === filter)
    .filter(({ tc }) => !highOnly || tc.priority === 'High')
    .sort((a, b) => priorityRank(a.tc.priority) - priorityRank(b.tc.priority) || a.index - b.index);
  const coveredCount = coverage.filter(c => c.testCaseIds.length > 0).length;
  const countOf = (type: TestType) => testCases.filter(tc => tc.type === type).length;
  const highCount = testCases.filter(tc => tc.priority === 'High').length;
  const gaps = result?.gaps ?? [];

  // Append a gap's suggested criterion to the criteria box so the next Generate covers it.
  const addGapToCriteria = (gapIndex: number) => {
    const suggestion = gaps[gapIndex]?.suggestion.trim();
    if (!suggestion) return;
    const alreadyThere = criteriaList.some(c => c.toLowerCase() === suggestion.toLowerCase());
    if (!alreadyThere) {
      setCriteriaText(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${suggestion}` : suggestion));
    }
    setAddedGaps(prev => (prev.includes(gapIndex) ? prev : [...prev, gapIndex]));
  };

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError('');
    setFilter(null);
    setHighOnly(false);
    setHighlighted(null);
    setDraft(null);
    setLastDeleted(null);
    const started = performance.now();
    try {
      const res = await axios.post<GenerateResponse>(`${API_URL}/api/generate`, {
        storyId: storyId.trim(),
        story: story.trim(),
        criteria: criteriaList
      });
      setResult(res.data);
      setAddedGaps([]);
      setElapsed((performance.now() - started) / 1000);
    } catch (err) {
      const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      setError(message ?? 'Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const jumpTo = (id: string) => {
    setFilter(null);
    setHighOnly(false);
    setHighlighted(id);
    setTimeout(() => {
      document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const startEdit = (index: number) => {
    const tc = testCases[index];
    setDraft({
      index,
      scenario: tc.scenario,
      type: tc.type,
      priority: tc.priority,
      preconditions: tc.preconditions,
      stepsText: tc.steps.join('\n'),
      testData: tc.testData,
      expectedResult: tc.expectedResult
    });
  };

  const saveEdit = () => {
    if (!draft || !result) return;
    const { index, stepsText, ...fields } = draft;
    const steps = stepsText.split('\n').map(s => s.trim()).filter(Boolean);
    setResult({
      ...result,
      testCases: result.testCases.map((tc, i) => (i === index ? { ...tc, ...fields, steps, edited: true } : tc))
    });
    setDraft(null);
  };

  const deleteRow = (index: number) => {
    if (!result) return;
    const removed = result.testCases[index];
    const remaining = result.testCases.filter((_, i) => i !== index);
    // Drop the ID from coverage unless another row still uses it.
    const idStillUsed = remaining.some(tc => tc.testCaseId === removed.testCaseId);
    const newCoverage = idStillUsed
      ? result.coverage
      : result.coverage.map(c => ({ ...c, testCaseIds: c.testCaseIds.filter(id => id !== removed.testCaseId) }));
    setLastDeleted({ testCase: removed, index, coverage: result.coverage });
    setResult({ ...result, testCases: remaining, coverage: newCoverage });
    setDraft(null);
  };

  const undoDelete = () => {
    if (!lastDeleted || !result) return;
    const restored = [...result.testCases];
    restored.splice(lastDeleted.index, 0, lastDeleted.testCase);
    setResult({ ...result, testCases: restored, coverage: lastDeleted.coverage });
    setLastDeleted(null);
  };

  const exportCSV = () => {
    const headers = [
      'Test Case ID', 'Scenario', 'Type', 'Priority', 'Priority Reason', 'Covers', 'Preconditions', 'Steps',
      'Test Data', 'Expected Result', 'Story ID'
    ];
    const rows = byPriority(testCases).map(tc => [
      tc.testCaseId, tc.scenario, tc.type, tc.priority, tc.priorityReason, criteriaLabel(tc.criteria ?? []), tc.preconditions,
      tc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), tc.testData, tc.expectedResult, tc.storyId
    ]);
    const escape = (c: unknown) => `"${String(c ?? '').replace(/"/g, '""')}"`;
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
    // BOM so Excel opens the file as UTF-8
    downloadFile('﻿' + csv, `test-cases-${resultStoryId}.csv`, 'text/csv;charset=utf-8');
  };

  const exportGherkin = () => {
    const feature = toGherkin({
      storyId: resultStoryId,
      story: result?.story ?? '',
      criteria: coverage.map(c => c.criterion),
      testCases: byPriority(testCases),
      gaps
    });
    downloadFile(feature, `test-cases-${resultStoryId}.feature`, 'text/plain;charset=utf-8');
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>AI Test-Case Generator</h1>
          <p className="tagline">Turn a user story into ready-to-run test cases in seconds.</p>
        </div>
        <div className="header-right">
          {result && (
            <span className="provider">
              Powered by {PROVIDER_LABELS[result.provider] ?? result.provider}
              {result.model && <span className="muted"> · {result.model}</span>}
              {formatBobStats(result.stats) && (
                <span className="muted" title="Run time and cost reported by Bob Shell">
                  {' · '}{formatBobStats(result.stats)}
                </span>
              )}
            </span>
          )}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
        </div>
      </header>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Your user story</h2>
          <select
            className="example-select"
            aria-label="Load an example story"
            value=""
            onChange={e => loadExample(e.target.value)}
            disabled={loading}
          >
            <option value="" disabled>Load example…</option>
            {EXAMPLES.map(e => <option key={e.label} value={e.label}>{e.label}</option>)}
          </select>
        </div>

        <div className="field field-short">
          <label htmlFor="story-id">Story ID <span className="optional">(optional)</span></label>
          <input
            id="story-id"
            value={storyId}
            onChange={e => setStoryId(e.target.value)}
            onKeyDown={onCtrlEnter}
            placeholder={PLACEHOLDERS.storyId}
            maxLength={20}
          />
        </div>

        <div className="field">
          <label htmlFor="story">User story</label>
          <textarea
            id="story"
            value={story}
            onChange={e => setStory(e.target.value)}
            onKeyDown={onCtrlEnter}
            placeholder={PLACEHOLDERS.story}
            rows={3}
          />
        </div>

        <div className="field">
          <label htmlFor="criteria">
            Acceptance criteria <span className="optional">(one per line)</span>
          </label>
          <textarea
            id="criteria"
            value={criteriaText}
            onChange={e => setCriteriaText(e.target.value)}
            onKeyDown={onCtrlEnter}
            placeholder={PLACEHOLDERS.criteria}
            rows={6}
          />
          <div className="hint">
            {criteriaList.length === 0
              ? 'Add at least one criterion.'
              : `${criteriaList.length} ${criteriaList.length === 1 ? 'criterion' : 'criteria'} detected`}
          </div>
        </div>

        <div className="actions">
          <button className="primary" onClick={generate} disabled={!canGenerate}>
            {loading ? <><span className="spinner" /> Generating…</> : 'Generate test cases'}
          </button>
          <span className="hint">Ctrl + Enter</span>
          {testCases.length > 0 && (
            <div className="export-buttons">
              <button className="secondary" onClick={exportCSV}>Export CSV</button>
              <button className="secondary" onClick={exportGherkin} title="Download a Gherkin .feature file (Given / When / Then)">
                Export Gherkin
              </button>
            </div>
          )}
        </div>
      </section>

      {error && <div className="banner banner-error">{error}</div>}
      {result?.notice && <div className="banner banner-warn">{result.notice}</div>}

      {testCases.length > 0 && (
        <>
          <section className="summary">
            <button
              className={`stat ${filter === null && !highOnly ? 'active' : ''}`}
              onClick={() => { setFilter(null); setHighOnly(false); }}
            >
              <strong>{testCases.length}</strong> total
            </button>
            {TYPES.map(type => (
              <button
                key={type}
                className={`stat stat-${slug(type)} ${filter === type ? 'active' : ''}`}
                onClick={() => setFilter(filter === type ? null : type)}
              >
                <strong>{countOf(type)}</strong> {type}
              </button>
            ))}
            <button
              className={`stat stat-priority-high ${highOnly ? 'active' : ''}`}
              onClick={() => setHighOnly(!highOnly)}
              title="Show only High priority test cases: run these first"
            >
              <strong>{highCount}</strong> High priority
            </button>
            {!result?.fallback && <span className="elapsed">Generated in {elapsed.toFixed(1)}s</span>}
          </section>

          {gaps.length > 0 && (
            <section className="card gaps-card">
              <h2>
                Story review
                <span className="gap-count">
                  {gaps.length} {gaps.length === 1 ? 'gap' : 'gaps'} found
                </span>
              </h2>
              <p className="gaps-intro">
                Unclear or missing acceptance criteria. Add a suggestion to your criteria, then generate again to cover it.
              </p>
              <ul className="gaps">
                {gaps.map((gap, i) => {
                  const added = addedGaps.includes(i);
                  const criterionText = gap.criterion ? coverage[gap.criterion - 1]?.criterion : undefined;
                  return (
                    <li key={i} className="gap">
                      <div className="gap-head">
                        <span className={`gap-kind gap-kind-${gap.kind.toLowerCase()}`}>{gap.kind}</span>
                        {gap.criterion && <span className="ac-num">AC{gap.criterion}</span>}
                        <strong className="gap-title">{gap.title}</strong>
                      </div>
                      {criterionText && <div className="gap-criterion">“{criterionText}”</div>}
                      {gap.questions.length > 0 && (
                        <ul className="gap-questions">
                          {gap.questions.map((q, qi) => <li key={qi}>{q}</li>)}
                        </ul>
                      )}
                      {gap.suggestion && (
                        <div className="gap-suggestion">
                          <div>
                            <span className="gap-suggestion-label">Suggested criterion</span>
                            {gap.suggestion}
                          </div>
                          <button
                            className={added ? 'ghost small' : 'secondary small'}
                            onClick={() => addGapToCriteria(i)}
                            disabled={added || loading}
                          >
                            {added ? '✓ Added' : '+ Add to criteria'}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {addedGaps.length > 0 && (
                <div className="gaps-next">
                  {addedGaps.length} {addedGaps.length === 1 ? 'criterion' : 'criteria'} added to your story.
                  <button className="link-btn" onClick={generate} disabled={!canGenerate}>
                    Generate again
                  </button>
                </div>
              )}
            </section>
          )}

          {coverage.length > 0 && (
            <section className="card">
              <h2>
                Acceptance criteria coverage
                <span className={`coverage-score ${coveredCount === coverage.length ? 'full' : 'partial'}`}>
                  {coveredCount}/{coverage.length} covered
                </span>
              </h2>
              <ul className="coverage">
                {coverage.map((c, i) => (
                  <li key={i} className={c.testCaseIds.length ? 'covered' : 'uncovered'}>
                    <span className="check">{c.testCaseIds.length ? '✓' : '!'}</span>
                    <span className="criterion"><span className="ac-num">AC{i + 1}</span> {c.criterion}</span>
                    <span className="ids">
                      {c.testCaseIds.length
                        ? c.testCaseIds.map(id => (
                            <button key={id} className="chip" onClick={() => jumpTo(id)}>{id}</button>
                          ))
                        : <em>Not covered</em>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {lastDeleted && (
            <div className="banner banner-info">
              Deleted <strong>{lastDeleted.testCase.testCaseId}</strong>.
              <button className="link-btn" onClick={undoDelete}>Undo</button>
            </div>
          )}

          <section className="card table-card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Scenario</th>
                    <th>Type / priority</th>
                    <th>Steps</th>
                    <th>Test data</th>
                    <th>Expected result</th>
                    <th className="actions-col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ tc, index }) =>
                    draft?.index === index ? (
                      <tr key={`${tc.testCaseId}-${index}`} className="editing">
                        <td className="mono id-cell">{tc.testCaseId}</td>
                        <td>
                          <label className="field-label" htmlFor="edit-scenario">Scenario</label>
                          <input
                            id="edit-scenario"
                            value={draft.scenario}
                            onChange={e => setDraft({ ...draft, scenario: e.target.value })}
                            autoFocus
                          />
                          <label className="field-label" htmlFor="edit-pre">Preconditions</label>
                          <textarea
                            id="edit-pre"
                            rows={2}
                            value={draft.preconditions}
                            onChange={e => setDraft({ ...draft, preconditions: e.target.value })}
                          />
                        </td>
                        <td className="type-cell">
                          <select
                            aria-label="Type"
                            value={draft.type}
                            onChange={e => setDraft({ ...draft, type: e.target.value as TestType })}
                          >
                            {[...TYPES, 'Other'].map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <label className="field-label" htmlFor="edit-priority">Priority</label>
                          <select
                            id="edit-priority"
                            value={draft.priority}
                            onChange={e => setDraft({ ...draft, priority: e.target.value as Priority })}
                          >
                            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </td>
                        <td data-label="Steps">
                          <textarea
                            aria-label="Steps, one per line"
                            rows={5}
                            value={draft.stepsText}
                            onChange={e => setDraft({ ...draft, stepsText: e.target.value })}
                          />
                          <div className="hint">One step per line</div>
                        </td>
                        <td data-label="Test data">
                          <textarea
                            aria-label="Test data"
                            rows={3}
                            value={draft.testData}
                            onChange={e => setDraft({ ...draft, testData: e.target.value })}
                          />
                        </td>
                        <td data-label="Expected result">
                          <textarea
                            aria-label="Expected result"
                            rows={3}
                            value={draft.expectedResult}
                            onChange={e => setDraft({ ...draft, expectedResult: e.target.value })}
                          />
                        </td>
                        <td className="row-actions">
                          <button className="primary small" onClick={saveEdit}>Save</button>
                          <button className="ghost small" onClick={() => setDraft(null)}>Cancel</button>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={`${tc.testCaseId}-${index}`}
                        id={`row-${tc.testCaseId}`}
                        className={highlighted === tc.testCaseId ? 'highlight' : ''}
                      >
                        <td className="mono id-cell">
                          {tc.testCaseId}
                          {tc.criteria?.length > 0 && <div className="covers">Covers {criteriaLabel(tc.criteria)}</div>}
                          {tc.edited && <div className="edited-tag">edited</div>}
                        </td>
                        <td data-label="Scenario">
                          <div className="scenario">{tc.scenario}</div>
                          {tc.preconditions && (
                            <div className="sub"><span>Preconditions:</span> {tc.preconditions}</div>
                          )}
                          {tc.priorityReason && (
                            <div className="sub"><span>Why {tc.priority}:</span> {tc.priorityReason}</div>
                          )}
                        </td>
                        <td className="type-cell">
                          <span className={`badge badge-${slug(tc.type)}`}>{tc.type}</span>
                          <span
                            className={`priority priority-${(tc.priority ?? 'Medium').toLowerCase()}`}
                            title={tc.priorityReason || undefined}
                          >
                            {tc.priority ?? 'Medium'}
                          </span>
                        </td>
                        <td data-label="Steps">
                          <ol className="steps">
                            {tc.steps.map((s, i) => <li key={i}>{s}</li>)}
                          </ol>
                        </td>
                        <td data-label="Test data" className="test-data">{tc.testData || '—'}</td>
                        <td data-label="Expected result">{tc.expectedResult}</td>
                        <td className="row-actions">
                          <button className="ghost small" onClick={() => startEdit(index)} disabled={draft !== null}>
                            Edit
                          </button>
                          <button
                            className="ghost small danger"
                            onClick={() => deleteRow(index)}
                            disabled={draft !== null}
                            aria-label={`Delete ${tc.testCaseId}`}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default App;
