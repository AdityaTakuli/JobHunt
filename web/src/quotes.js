// Short lines for the welcome screen, slow loads and the end of the feed. Kept brief so they
// encourage without pulling attention away from the job list.
export const QUOTES = [
  { text: 'The details are not the details. They make the design.', by: 'Charles Eames' },
  { text: 'Less is more.', by: 'Ludwig Mies van der Rohe' },
  { text: 'Even a brick wants to be something.', by: 'Louis Kahn' },
  { text: 'Architecture starts when you carefully put two bricks together.', by: 'Ludwig Mies van der Rohe' },
  { text: 'Every sketch you drew got you here. One application at a time.' },
  { text: 'Great studios were once small studios that said yes to a first intern.' },
  { text: 'A portfolio opens doors. Persistence walks through them.' },
  { text: 'Foundations take the longest. Everything after rises faster.' },
  { text: 'One good Revit model beats a hundred perfect intentions.' },
  { text: 'Rejections are just site constraints. Design around them.' },
  { text: 'Send the email. The worst answer is the one you never asked for.' },
  { text: 'Every building you love started as a rough line on paper.' },
];

// A different quote each call, never the same one twice in a row.
let last = -1;
export function randomQuote() {
  let i = Math.floor(Math.random() * QUOTES.length);
  if (i === last) i = (i + 1) % QUOTES.length;
  last = i;
  return QUOTES[i];
}

// The same quote all day, so the feed footer does not change on every visit.
export function quoteOfTheDay(date = new Date()) {
  const day = Math.floor((date.getTime() + 330 * 60_000) / 86_400_000); // IST day number
  return QUOTES[day % QUOTES.length];
}
