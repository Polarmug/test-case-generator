// Voice-over for the animated intro (ad.js). Each id matches a section in ad/ad.html, played in this order;
// every section lasts as long as its line. Edit the text freely.
module.exports = [
  { id: 'prompt', text: 'This bug passed every test. So what did your tests miss?' },
  { id: 'premise1', text: 'Every feature starts as a user story.' },
  { id: 'premise2', text: 'And every story has to become test cases. Written by hand.' },
  {
    id: 'problem',
    text:
      'Under deadline pressure, it gets messy. ' +
      'Every tester writes test cases differently: some vague, some duplicated, some never finished. ' +
      'Edge cases get skipped, requirements stay unclear, and the bugs slip into production.'
  },
  { id: 'better', text: "There's a better way." },
  { id: 'brand', text: 'Meet the AI Test-Case Generator, powered by IBM Bob 2.0.' }
];
