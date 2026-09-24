// Pulls a stipend or salary out of free text. Returns null when nothing is mentioned.
// Result: { text, min, max, period } where min/max are rupees (or null) and period is
// month / year / week / day / hour (or null).

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`\s*(k|lakhs?|lacs?|l)?\b`;
const CUR = String.raw`(?:₹|rs\.?|inr)`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to)\s*`;

const LPA_RE = new RegExp(
  String.raw`(?:${CUR}\s*)?${NUM}(?:${RANGE_SEP}${NUM})?\s*(?:lpa\b|l\.p\.a\.?|(?:lakhs?|lacs?)\s*(?:per annum|p\.?\s?a\b\.?|\/\s*annum|a year|per year))`,
  'i',
);
const CURRENCY_RE = new RegExp(
  String.raw`${CUR}\s*${NUM}${UNIT}(?:\s*\/-)?(?:${RANGE_SEP}(?:${CUR}\s*)?${NUM}${UNIT}(?:\s*\/-)?)?`,
  'i',
);
const STIPEND_AMOUNT_RE = new RegExp(String.raw`stipend[^\n.]{0,40}?${NUM}${UNIT}(?:${RANGE_SEP}${NUM}${UNIT})?`, 'i');
const AMOUNT_STIPEND_RE = new RegExp(String.raw`${NUM}${UNIT}(?:${RANGE_SEP}${NUM}${UNIT})?\s*(?:\/-\s*)?(?:monthly\s+)?stipend`, 'i');
// Bare amounts with an explicit period: "15K–25K a month", "12,000 per month", "3,00,000 a year".
const PER_PERIOD_RE = new RegExp(
  String.raw`${NUM}${UNIT}(?:${RANGE_SEP}${NUM}${UNIT})?\s*(?:\/|per|an?)\s*(month|year|annum|week|day|hour)\b`,
  'i',
);
const PERIOD_WORD = { month: 'month', year: 'year', annum: 'year', week: 'week', day: 'day', hour: 'hour' };
const STIPEND_ONLY_RE = /\b(paid internship|stipend(?:\s+(?:will be|is|shall be))?\s+(?:provided|offered|applicable|given)|performance[- ]based stipend)\b/i;

function toRupees(raw, unit) {
  if (raw == null) return null;
  let n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'k') n *= 1_000;
  else if (u.startsWith('lakh') || u.startsWith('lac') || u === 'l') n *= 100_000;
  return Math.round(n);
}

function detectPeriod(following) {
  const t = following.toLowerCase();
  if (/^\s*(?:\/-)?\s*(?:per\s*month|\/\s*month|\/\s*mo\b|p\.?\s?m\b|a month|monthly|pm\b)/.test(t)) return 'month';
  if (/^\s*(?:\/-)?\s*(?:per\s*annum|\/\s*annum|p\.?\s?a\b|per\s*year|\/\s*year|\/\s*yr|a year|annually|yearly|ctc)/.test(t)) return 'year';
  if (/^\s*(?:\/-)?\s*(?:per\s*week|\/\s*week|weekly)/.test(t)) return 'week';
  if (/^\s*(?:\/-)?\s*(?:per\s*day|\/\s*day|daily)/.test(t)) return 'day';
  if (/^\s*(?:\/-)?\s*(?:per\s*hour|\/\s*hour|\/\s*hr|hourly)/.test(t)) return 'hour';
  return null;
}

function snippet(text, start, end) {
  const periodTail = text.slice(end, end + 16).match(/^\s*(?:\/-)?\s*(?:per\s+\w+|an?\s+(?:month|year|week|day|hour)|\/\s*\w+|p\.?\s?[am]\.?|monthly|annually|ctc)/i);
  const stop = end + (periodTail ? periodTail[0].length : 0);
  return text.slice(start, stop).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function build(text, match, nums, fixedPeriod) {
  const [a, b] = nums;
  let min = toRupees(a.raw, a.unit);
  let max = b ? toRupees(b.raw, b.unit ?? a.unit) : min;
  // "10-15k" means both ends are thousands.
  if (b && !a.unit && b.unit) min = toRupees(a.raw, b.unit);
  if (min && max && min > max) [min, max] = [max, min];
  const end = match.index + match[0].length;
  let period = fixedPeriod || detectPeriod(text.slice(end, end + 20));
  if (!period && max) period = max >= 100_000 ? 'year' : 'month';
  return { text: snippet(text, match.index, end), min, max, period };
}

export function parseSalary(input) {
  const text = String(input ?? '');
  if (!text.trim()) return null;

  let m = text.match(LPA_RE);
  if (m) {
    const min = Math.round(Number(m[1]) * 100_000);
    const max = m[2] ? Math.round(Number(m[2]) * 100_000) : min;
    return { text: snippet(text, m.index, m.index + m[0].length), min, max, period: 'year' };
  }

  m = text.match(CURRENCY_RE);
  if (m) {
    const nums = [{ raw: m[1], unit: m[2] }];
    if (m[3]) nums.push({ raw: m[3], unit: m[4] });
    const result = build(text, m, nums);
    if (result.max && result.max >= 500) return result;
  }

  m = text.match(PER_PERIOD_RE);
  if (m) {
    const nums = [{ raw: m[1], unit: m[2] }];
    if (m[3]) nums.push({ raw: m[3], unit: m[4] });
    const result = build(text, m, nums, PERIOD_WORD[m[5].toLowerCase()]);
    if (result.max && result.max >= 500) return result;
  }

  m = text.match(STIPEND_AMOUNT_RE);
  if (m) {
    const nums = [{ raw: m[1], unit: m[2] }];
    if (m[3]) nums.push({ raw: m[3], unit: m[4] });
    const result = build(text, m, nums);
    if (result.max && result.max >= 500) return result;
  }

  m = text.match(AMOUNT_STIPEND_RE);
  if (m) {
    const nums = [{ raw: m[1], unit: m[2] }];
    if (m[3]) nums.push({ raw: m[3], unit: m[4] });
    const result = build(text, m, nums);
    if (result.max && result.max >= 500) return result;
  }

  m = text.match(STIPEND_ONLY_RE);
  if (m) return { text: m[0].charAt(0).toUpperCase() + m[0].slice(1), min: null, max: null, period: null };

  return null;
}
