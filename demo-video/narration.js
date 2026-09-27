// Narration for the demo video, one entry per scene in record.js (same order).
// Edit the text freely; each scene on screen lasts at least as long as its narration.

// The "results" line quotes the first test case Bob actually generated in this run.
function resultsText({ scenario, priority, reason }) {
  const example = scenario ? `For example, Bob wrote: "${scenario}". ` : 'Here are the test cases Bob wrote. ';
  const why = priority ? `It's marked ${priority} priority${reason ? `, because ${reason}` : ''}. ` : '';
  return (
    example +
    why +
    'Every test case comes with steps, test data and the expected result, across happy paths, negative cases and edge cases.'
  );
}

module.exports = [
  {
    id: 'intro',
    text: "This is the AI Test-Case Generator, powered by IBM Bob 2.0. Let's give it a real user story: a bank transfer, with five acceptance criteria."
  },
  {
    id: 'problem', // plays while Bob is generating
    text:
      'When we click Generate, the story goes to IBM Bob. ' +
      'Before anything ships, a QA team has to turn stories like this into test cases, by hand, for every single story. ' +
      'Under deadline pressure, the tests people forget are the dangerous ones: ' +
      'like sending a negative amount of money, such as minus five thousand pesos, ' +
      'or sending exactly the fifty-thousand-peso daily limit. ' +
      'And often the story itself is incomplete, so nobody notices the gap until it breaks in production, ' +
      "when it's the most expensive to fix."
  },
  {
    id: 'bob',
    text: "Here's the answer. Our backend runs IBM Bob Shell 2.0 as a live agent, and the badge shows the exact version, how long Bob took, and what the run cost."
  },
  {
    id: 'results', // written after Bob answers, from the first test case on screen; see resultsText below
    dynamic: true
  },
  {
    id: 'priority',
    text:
      'Every test case is ranked by risk, with a reason. Click High priority, and the list now shows only the high-priority tests: ' +
      'the most important ones, to run first when time is short.'
  },
  {
    id: 'coverage',
    text:
      'Every acceptance criterion is mapped to the tests that verify it. ' +
      "The coverage list is built from your own criteria, not from the AI's report, " +
      "so if Bob misses a requirement, you'll see it marked as not covered. " +
      'Click a test, and it jumps right to it.'
  },
  {
    id: 'gaps', // skipped automatically if Bob found no gaps this run
    text:
      "Here's what makes it different. Bob also reviews the story itself, like a senior QA engineer, " +
      'and flags requirements that are unclear or missing. ' +
      'One click adds the suggested fix to the story, so the next run tests it too.'
  },
  {
    id: 'edit',
    text:
      'You stay in control of every test case. Click Edit to change any detail, then save it, and it is marked as edited. ' +
      "Don't need a test? For example, this one: click Delete, and it's removed, with the coverage updated automatically. " +
      'Changed your mind? One click on Undo brings it back.'
  },
  {
    id: 'export', // only reached if both files really downloaded (record.js checks the files on disk)
    text:
      'And it all exports in one click: a CSV file for spreadsheets and test tools, ' +
      'and a Gherkin file for Cucumber, with every test already written as Given, When, Then. ' +
      'Both files downloaded successfully.'
  },
  {
    id: 'close',
    text: 'IBM Bob 2.0 turns a user story into prioritized, verified test cases, and catches the gaps before they become bugs. Thanks for watching.'
  }
];

module.exports.resultsText = resultsText;
