// Each firm's own colour and logo, so the Companies page reads as a shelf of brands instead of a
// row of grey cards. Keyed by the slug in server/lib/companies.js.
//
// `color` is the firm's primary brand colour where it publishes one (AECOM green, Gensler red,
// Arcadis orange, CBRE green, Ramboll and Mott MacDonald blue…) and the closest reading of its
// logo where it does not; it is only ever used as a tint, never as the logo itself, so a slightly
// wrong hue is cosmetic. `domain` is the firm's own site, which is where the logo comes from.
// A firm added without an entry here still gets a colour of its own, from its name.
const BRANDS = {
  atkinsrealis: { color: '#0f3cc9', domain: 'atkinsrealis.com' },
  'surbana-jurong': { color: '#e03c31', domain: 'surbanajurong.com' },
  gensler: { color: '#ee3224', domain: 'gensler.com' },
  aecom: { color: '#008768', domain: 'aecom.com' },
  wsp: { color: '#f9423a', domain: 'wsp.com' },
  ramboll: { color: '#009df0', domain: 'ramboll.com' },
  jll: { color: '#d81e05', domain: 'jll.com' },
  'cushman-wakefield': { color: '#e4002b', domain: 'cushmanwakefield.com' },
  cbre: { color: '#006a4d', domain: 'cbre.com' },
  'wework-india': { color: '#1c4dff', domain: 'wework.co.in' },
  benoy: { color: '#c8102e', domain: 'benoy.com' },
  dar: { color: '#006b54', domain: 'dar.com' },
  jacobs: { color: '#00338d', domain: 'jacobs.com' },
  arup: { color: '#d52b1e', domain: 'arup.com' },
  arcadis: { color: '#e76a25', domain: 'arcadis.com' },
  'mott-macdonald': { color: '#0097ff', domain: 'mottmac.com' },
  stantec: { color: '#4a4a4a', domain: 'stantec.com' },
};

// Two letters standing in for the logo until it loads, or when the firm has none to fetch:
// the capitals inside the name ("WeWork" → WW, "AtkinsRéalis" → AR, "Surbana Jurong" → SJ),
// else its first two letters ("Gensler" → Ge).
function monogram(name) {
  const clean = String(name || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(india|group|pvt|ltd|llp|inc|private|limited)\b\.?/gi, ' ')
    .replace(/&/g, ' ')
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const capitals = words[0].replace(/[^A-ZÀ-Þ]/g, '');
  if (capitals.length > 1) return capitals.slice(0, 2);
  return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

// Firms with no entry above: a hue of their own, so the grid stays colour-coded.
function hueFrom(slug) {
  let hash = 0;
  for (const ch of String(slug)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

export function brandOf({ slug, name }) {
  const brand = BRANDS[slug];
  return {
    color: brand ? brand.color : `hsl(${hueFrom(slug)} 62% 45%)`,
    // DuckDuckGo serves the firm's own site icon, and 404s for anything it does not have, which
    // is what puts the monogram back on screen.
    logo: brand ? `https://icons.duckduckgo.com/ip3/${brand.domain}.ico` : null,
    monogram: monogram(name),
  };
}
