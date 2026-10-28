// The "apply by" date in a posting: "Last date to apply: 20 Oct 2026", "Apply before 31/10/2026",
// "Deadline - October 30". Returns the end of that day in IST, or null when the posting doesn't
// say (most don't) or the date makes no sense next to when it was posted.

import { DAY_MS } from './time.js';

// SQL: a job (alias j) that can still be applied to. Not closed, and its "apply by" date (if any)
// not passed, so a posting leaves every list the moment its date passes, not only when the
// twice-daily clean-up closes it. Dates are stored in UTC (db/pool.js).
export const STILL_OPEN = '(j.closed_at IS NULL AND (j.deadline_at IS NULL OR j.deadline_at > UTC_TIMESTAMP()))';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const LEAD =
  '(?:last date(?: (?:to|for|of) (?:apply(?:ing)?|application|applications|submission))?|apply (?:by|before|on or before|latest by)|' +
  'deadline(?: (?:to apply|for applications?|for submission))?|applications? (?:close[sd]?|due)(?: on| by)?|closing date|' +
  'submit (?:your )?(?:application|portfolio|cv|resume)s? (?:by|before))';

// One date, in the forms Indian postings use.
const DATE_FORMS = [
  // 20 Oct 2026, 20th October, 2026, 20-Oct-26, 20 Oct
  { re: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-.]*(?:of\\s+)?${MONTH}[\\s\\-.,]*(\\d{4}|\\d{2})?\\b`, 'i'), d: 1, m: 2, y: 3 },
  // October 20, 2026 / Oct 20
  { re: new RegExp(`${MONTH}[\\s\\-.]*(\\d{1,2})(?:st|nd|rd|th)?\\b,?\\s*(\\d{4})?`, 'i'), m: 1, d: 2, y: 3 },
  // 2026-10-20
  { re: /(\d{4})-(\d{1,2})-(\d{1,2})/, y: 1, m: 2, d: 3, numeric: true },
  // 20/10/2026, 20.10.26, 20-10-2026 (day first, as in India)
  { re: /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, d: 1, m: 2, y: 3, numeric: true },
];

function monthIndex(word) {
  return MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
}

// End of the day in IST (23:59:59 IST = 18:29:59 UTC).
const endOfIstDay = (y, m, d) => new Date(Date.UTC(y, m, d, 18, 29, 59));

export function parseDeadline(text, reference = new Date()) {
  const body = String(text || '');
  const lead = body.match(new RegExp(`${LEAD}\\s*(?:is|:|-|–|—)?\\s*`, 'i'));
  if (!lead) return null;
  const after = body.slice(lead.index + lead[0].length, lead.index + lead[0].length + 40);
  const ref = new Date(reference);

  for (const form of DATE_FORMS) {
    const m = after.match(form.re);
    // The date must follow the words, not sit somewhere later in the sentence.
    if (!m || m.index > 4) continue;
    const day = Number(m[form.d]);
    const month = form.numeric ? Number(m[form.m]) - 1 : monthIndex(m[form.m]);
    let year = m[form.y] ? Number(m[form.y]) : null;
    if (year != null && year < 100) year += 2000;
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    if (year == null) {
      // "Apply by 20 Oct": the next 20 Oct on or after the posting date.
      year = ref.getUTCFullYear();
      if (endOfIstDay(year, month, day) < new Date(ref.getTime() - DAY_MS)) year += 1;
    }
    const date = endOfIstDay(year, month, day);
    if (date.getUTCDate() !== day) return null; // 31 Nov and the like
    // A deadline well before the posting date, or over a year after it, is a misread.
    if (date < new Date(ref.getTime() - 7 * DAY_MS) || date > new Date(ref.getTime() + 366 * DAY_MS)) return null;
    return date;
  }
  return null;
}
