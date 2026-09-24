// Small CSV parser (quotes, escaped quotes, commas/newlines inside quotes).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some(Boolean));
}

const HEADER_ALIASES = {
  name: ['name', 'firm', 'firm name', 'company', 'studio'],
  city: ['city', 'location'],
  type: ['type', 'category'],
  website: ['website', 'site', 'url', 'web'],
  contact_email: ['email', 'contact email', 'contact_email', 'e-mail', 'mail'],
  notes: ['notes', 'note', 'comments'],
};
const DEFAULT_ORDER = ['name', 'city', 'type', 'website', 'contact_email', 'notes'];

// CSV text -> [{ name, city, type, website, contact_email, notes }]
export function firmsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  const mapped = header.map((h) => Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].includes(h)));
  const hasHeader = mapped.includes('name');
  const columns = hasHeader ? mapped : DEFAULT_ORDER;
  return rows
    .slice(hasHeader ? 1 : 0)
    .map((r) => Object.fromEntries(columns.map((key, i) => [key, r[i] || '']).filter(([key]) => key)))
    .filter((f) => f.name);
}
