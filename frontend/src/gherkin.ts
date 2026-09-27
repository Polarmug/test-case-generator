// Turns the generated test cases into a Gherkin .feature file (Given / When / Then).

export interface GherkinTestCase {
  testCaseId: string;
  scenario: string;
  type: string;
  priority?: string;
  criteria?: number[];
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
}

export interface GherkinInput {
  storyId: string;
  story: string;
  criteria: string[];
  testCases: GherkinTestCase[];
}

// Gherkin lines can't contain line breaks.
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ').trim();

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const tag = (text: string) => '@' + text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Words that already make a step read as a sentence, e.g. "the user enters…", "I click…".
const SUBJECT_WORDS = new Set(['i', 'the', 'a', 'an', 'user', 'users', 'system', 'admin', 'customer', 'they', 'it']);

// AI steps are usually imperative ("Enter a password"); Gherkin reads better as "I enter a password".
function asFirstPerson(step: string): string {
  const text = oneLine(step);
  const firstWord = text.split(/\s+/)[0]?.toLowerCase() ?? '';
  return SUBJECT_WORDS.has(firstWord) ? text : `I ${lowerFirst(text)}`;
}

// "As a user, I want to log in so that…" -> "Log in"
function featureTitle(story: string): string {
  const match = story.match(/\bI want to\s+(.+?)(?:\s+so that\b|[.,;]|$)/i);
  if (!match) return '';
  const action = match[1].trim();
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export function toGherkin({ storyId, story, criteria, testCases }: GherkinInput): string {
  const title = featureTitle(story);
  const lines: string[] = [`Feature: Story ${storyId}${title ? ` - ${title}` : ''}`];
  if (story.trim()) lines.push(`  ${oneLine(story)}`);

  if (criteria.length > 0) {
    lines.push('', '  # Acceptance criteria:');
    criteria.forEach((c, i) => lines.push(`  #   AC${i + 1}: ${oneLine(c)}`));
  }

  for (const tc of testCases) {
    const idTag = '@' + tc.testCaseId.replace(/[^A-Za-z0-9_-]+/g, '-');
    const tags = [
      idTag,
      tag(tc.type),
      ...(tc.priority ? [tag(`priority ${tc.priority}`)] : []),
      ...(tc.criteria ?? []).map(n => `@AC${n}`)
    ];
    lines.push('', `  ${tags.join(' ')}`, `  Scenario: ${oneLine(tc.scenario) || tc.testCaseId}`);

    if (tc.preconditions.trim()) lines.push(`    Given ${lowerFirst(oneLine(tc.preconditions))}`);
    tc.steps.forEach((step, i) => lines.push(`    ${i === 0 ? 'When' : 'And'} ${asFirstPerson(step)}`));
    if (tc.expectedResult.trim()) lines.push(`    Then ${lowerFirst(oneLine(tc.expectedResult))}`);
    if (tc.testData.trim()) lines.push(`    # Test data: ${oneLine(tc.testData)}`);
  }

  return lines.join('\n') + '\n';
}
