#!/usr/bin/env node
/**
 * flight-zero-hunter.js v5A
 *
 * Focus: accuracy improvements
 * - source-specific parser profiles
 * - stronger route evidence extraction
 * - less false positive scoring for aggregators / vague pages
 * - clearer evidence in output
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SOURCES_PATH = path.join(ROOT, 'flight-zero-sources.json');
const CACHE_PATH = path.join(ROOT, '.flight-zero-cache.json');
const DEFAULT_WATCHLIST_PATH = path.join(ROOT, 'flight-zero-watchlist.json');

const ZERO_PATTERNS = [
  /\b0\s*đ\b/iu,
  /\b0d\b/iu,
  /zero\s*fare/iu,
  /0\s*vnđ/iu,
  /0\s*vnd/iu,
  /vé\s*0\s*đ/iu,
  /giá\s*0\s*đ/iu,
  /đồng\s*giá\s*0\s*đ/iu,
];

const PROMO_PATTERNS = [
  /siêu\s*khuyến\s*mãi/iu,
  /super\s*sale/iu,
  /flash\s*sale/iu,
  /khuyến\s*mãi/iu,
  /ưu\s*đãi/iu,
  /promotion/iu,
  /promo/iu,
];

const DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/g,
  /(\d{2})\/(\d{2})\/(\d{4})/g,
  /(\d{2})-(\d{2})-(\d{4})/g,
];

function parseArgs(argv) {
  const args = { saveCache: true, watchEverySec: 300, minScore: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--from-airport') args.fromAirport = normalizeAirport(argv[++i]);
    else if (a === '--to-airport') args.toAirport = normalizeAirport(argv[++i]);
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--all-profiles') args.allProfiles = true;
    else if (a === '--watchlist') args.watchlist = argv[++i];
    else if (a === '--watch') args.watch = true;
    else if (a === '--watch-every') args.watchEverySec = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--only-new') args.onlyNew = true;
    else if (a === '--no-cache') args.saveCache = false;
    else if (a === '--alert-file') args.alertFile = argv[++i];
    else if (a === '--min-score') args.minScore = Number(argv[++i]);
    else if (a === '--airline') args.airline = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`flight-zero-hunter v5A\n\nUsage:\n  node flight-zero-hunter.js --profile dad-sgn-april\n  node flight-zero-hunter.js --all-profiles --watchlist flight-zero-watchlist.json --min-score 8\n\nAccuracy upgrades:\n  - source-specific parsers\n  - stricter route evidence\n  - lower false positives for generic aggregators\n`);
}

function normalizeAirport(s) { return (s || '').trim().toUpperCase(); }
function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function toDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const [, y, mo, da] = m;
  const d = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da)));
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatDate(d) { return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-'); }
function expandDateRange(from, to) {
  const start = toDate(from), end = toDate(to);
  if (!start || !end || start > end) throw new Error('Invalid date range');
  const out = []; const cur = new Date(start);
  while (cur <= end) { out.push(formatDate(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractDates(text) {
  const out = new Set();
  for (const pat of DATE_PATTERNS) {
    let m; while ((m = pat.exec(text)) !== null) {
      let yyyy, mm, dd;
      if (m[1].length === 4) { yyyy = m[1]; mm = m[2]; dd = m[3]; }
      else { dd = m[1]; mm = m[2]; yyyy = m[3]; }
      const iso = `${yyyy}-${mm}-${dd}`;
      if (isIsoDate(iso)) out.add(iso);
    }
  }
  return [...out].sort();
}
function buildWindows(dates) {
  if (!dates.length) return [];
  const sorted = dates.map((d) => ({ raw: d, date: toDate(d) })).filter((x) => x.date).sort((a, b) => a.date - b.date);
  if (!sorted.length) return [];
  const windows = []; let start = sorted[0].raw; let prev = sorted[0].date;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i].date; const deltaDays = Math.round((cur - prev) / 86400000);
    if (deltaDays > 1) { windows.push({ from: start, to: sorted[i - 1].raw }); start = sorted[i].raw; }
    prev = cur;
  }
  windows.push({ from: start, to: sorted[sorted.length - 1].raw });
  return windows;
}
function intersects(inputDates, promoWindows) {
  const matches = [];
  for (const day of inputDates) {
    const d = toDate(day);
    for (const w of promoWindows) {
      const a = toDate(w.from), b = toDate(w.to);
      if (a && b && d >= a && d <= b) { matches.push(day); break; }
    }
  }
  return matches;
}
function loadJson(filePath, fallback = null) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function loadSources() { return loadJson(SOURCES_PATH, []); }
function loadCache() { return loadJson(CACHE_PATH, { seen: {} }); }
function saveCache(cache) { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }
function loadWatchlist(filePath) {
  const resolved = filePath ? path.resolve(filePath) : DEFAULT_WATCHLIST_PATH;
  const data = loadJson(resolved, null); if (!data) throw new Error(`Watchlist file not found: ${resolved}`);
  return { path: resolved, data };
}
function applyProfile(args, profileName) {
  if (!profileName) return args;
  const { data } = loadWatchlist(args.watchlist);
  const profile = (data.profiles || []).find((p) => p.name === profileName);
  if (!profile) throw new Error(`Profile not found: ${profileName}`);
  return {
    ...args,
    profile: profileName,
    from: args.from || profile.from,
    to: args.to || profile.to,
    date: args.date || profile.date,
    fromAirport: args.fromAirport || normalizeAirport(profile.fromAirport),
    toAirport: args.toAirport || normalizeAirport(profile.toAirport),
    onlyNew: args.onlyNew ?? Boolean(profile.onlyNew),
    minScore: args.minScore ?? profile.minScore ?? 0,
    airline: args.airline || profile.airline,
    source: args.source || profile.source,
    profileMeta: profile,
  };
}
async function fetchText(url) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; flight-zero-hunter/5A)', 'accept-language': 'vi,en;q=0.9' } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally { clearTimeout(timeout); }
}

function extractRouteMentions(text, airports) {
  const upper = text.toUpperCase();
  const found = [];
  for (const code of airports || []) {
    if (upper.includes(code)) found.push(code);
  }
  const pairs = [];
  const pairRegex = /\b([A-Z]{3})\s*(?:-|–|—|TO|→|>|→|\/|\sTO\s)\s*([A-Z]{3})\b/g;
  let m;
  while ((m = pairRegex.exec(upper)) !== null) pairs.push([m[1], m[2]]);
  return { found: [...new Set(found)], pairs };
}

function detectZeroEvidence(text, source) {
  const snippets = [];
  for (const p of ZERO_PATTERNS) {
    const m = text.match(p);
    if (m) snippets.push(m[0]);
  }
  const promo = PROMO_PATTERNS.some((p) => p.test(text));
  const hasZero = snippets.length > 0;
  const parser = source.parser || 'generic';
  let confidence = hasZero ? 3 : 0;
  if (hasZero && promo) confidence += 1;
  if (parser === 'aggregator-generic') confidence -= 2;
  return {
    hasZero,
    promo,
    confidence: Math.max(0, confidence),
    snippets: [...new Set(snippets)].slice(0, 5),
  };
}

function routeSignal(text, source, fromAirport, toAirport) {
  if (!fromAirport && !toAirport) return { matched: true, score: 0, reasons: [], evidence: [] };
  const mentions = extractRouteMentions(text, source.routeHints || []);
  const reasons = [];
  const evidence = [];
  let score = 0;
  let ok = true;

  const upper = text.toUpperCase();
  const pairMatch = mentions.pairs.some(([a, b]) => (!fromAirport || a === fromAirport) && (!toAirport || b === toAirport));
  if (pairMatch) {
    score += 4;
    reasons.push('pair-match');
    evidence.push(`${fromAirport || '*'}->${toAirport || '*'}`);
  }

  if (fromAirport) {
    const matched = upper.includes(fromAirport);
    if (matched) {
      score += 1;
      reasons.push(`from:${fromAirport}`);
      evidence.push(fromAirport);
    } else if (source.strictRoute) {
      ok = false;
    }
  }
  if (toAirport) {
    const matched = upper.includes(toAirport);
    if (matched) {
      score += 1;
      reasons.push(`to:${toAirport}`);
      evidence.push(toAirport);
    } else if (source.strictRoute) {
      ok = false;
    }
  }

  if (source.strictRoute && fromAirport && toAirport && !pairMatch && score < 2) ok = false;
  return { matched: ok, score, reasons: [...new Set(reasons)], evidence: [...new Set(evidence)] };
}

function scoreCandidate({ zeroEvidence, matchedDates, routeScore, windows, source }) {
  let score = 0;
  score += zeroEvidence.confidence * 2;
  score += Math.min(4, matchedDates.length);
  score += routeScore;
  if (windows.length) score += 1;
  score -= Number(source.qualityPenalty || 0);
  return Math.max(0, score);
}

function candidateKey(c) {
  return [c.source, c.url, c.matchingDates.join(','), c.promoWindows.map((w) => `${w.from}..${w.to}`).join(','), c.zeroSignal, c.profile || ''].join('|');
}

async function inspectSource(source, args, inputDates) {
  try {
    const res = await fetchText(source.url);
    const raw = res.text;
    const clean = stripTags(raw);
    const zeroEvidence = detectZeroEvidence(clean, source);
    const dates = extractDates(clean);
    const windows = buildWindows(dates);
    const matchedDates = intersects(inputDates, windows);
    const route = routeSignal(clean, source, args.fromAirport, args.toAirport);
    const score = scoreCandidate({ zeroEvidence, matchedDates, routeScore: route.score, windows, source });
    return {
      source: source.name,
      airline: source.airline || null,
      url: source.url,
      ok: res.ok,
      status: res.status,
      parser: source.parser || 'generic',
      zeroSignal: zeroEvidence.hasZero,
      zeroConfidence: zeroEvidence.confidence,
      zeroEvidence: zeroEvidence.snippets,
      promoSignal: zeroEvidence.promo,
      dates,
      windows,
      matchedDates,
      routeMatched: route.matched,
      routeReasons: route.reasons,
      routeEvidence: route.evidence,
      score,
      snippet: clean.slice(0, 700),
    };
  } catch (error) {
    return {
      source: source.name,
      airline: source.airline || null,
      url: source.url,
      ok: false,
      status: 0,
      parser: source.parser || 'generic',
      zeroSignal: false,
      zeroConfidence: 0,
      zeroEvidence: [],
      promoSignal: false,
      dates: [],
      windows: [],
      matchedDates: [],
      routeMatched: false,
      routeReasons: [],
      routeEvidence: [],
      score: 0,
      error: error.message,
    };
  }
}

function summarize(inspections, args, cache) {
  let candidates = inspections.filter((item) => item.ok)
    .filter((item) => !args.fromAirport && !args.toAirport ? true : item.routeMatched)
    .filter((item) => item.zeroSignal && item.zeroConfidence >= 2)
    .map((item) => ({
      source: item.source,
      airline: item.airline,
      url: item.url,
      parser: item.parser,
      matchedDates: item.matchedDates,
      promoWindows: item.windows,
      zeroSignal: item.zeroSignal,
      zeroConfidence: item.zeroConfidence,
      zeroEvidence: item.zeroEvidence,
      routeReasons: item.routeReasons,
      routeEvidence: item.routeEvidence,
      score: item.score,
      status: item.status,
      profile: args.profile || null,
    }))
    .filter((c) => c.score >= Number(args.minScore || 0))
    .filter((c) => !args.airline || (c.airline || '').toLowerCase().includes(String(args.airline).toLowerCase()))
    .filter((c) => !args.source || (c.source || '').toLowerCase().includes(String(args.source).toLowerCase()))
    .sort((a, b) => b.score - a.score);

  const seen = cache.seen || {};
  candidates = candidates.map((c) => {
    const key = candidateKey({ source: c.source, url: c.url, matchingDates: c.matchedDates, promoWindows: c.promoWindows, zeroSignal: c.zeroSignal, profile: c.profile });
    return { ...c, key, isNew: !seen[key] };
  });
  if (args.onlyNew) candidates = candidates.filter((c) => c.isNew);
  return candidates;
}

function updateCache(cache, candidates) {
  cache.seen ||= {};
  for (const c of candidates) cache.seen[c.key] = { seenAt: new Date().toISOString(), source: c.source, url: c.url, profile: c.profile };
  return cache;
}
function buildInputDates(args) { if (args.date) return [args.date]; if (args.from && args.to) return expandDateRange(args.from, args.to); throw new Error('Need --date or --from/--to (or a profile providing them)'); }
function appendAlerts(alertFile, output) {
  if (!alertFile) return;
  const payload = { emittedAt: new Date().toISOString(), version: output.version, profile: output.profile || null, route: output.route, requestedDates: output.requestedDates, candidates: output.candidates.filter((c) => c.isNew) };
  if (!payload.candidates.length) return;
  fs.appendFileSync(path.resolve(alertFile), JSON.stringify(payload) + '\n');
}
async function runSingleScan(baseArgs, profileName = null) {
  const args = applyProfile(baseArgs, profileName || baseArgs.profile);
  if (args.date && !isIsoDate(args.date)) throw new Error('--date must be YYYY-MM-DD');
  if (args.from && !isIsoDate(args.from)) throw new Error('--from must be YYYY-MM-DD');
  if (args.to && !isIsoDate(args.to)) throw new Error('--to must be YYYY-MM-DD');
  const inputDates = buildInputDates(args); const sources = loadSources(); const cache = loadCache(); const inspections = await Promise.all(sources.map((source) => inspectSource(source, args, inputDates))); const candidates = summarize(inspections, args, cache); if (args.saveCache) saveCache(updateCache(cache, candidates));
  const output = { version: '5A', profile: args.profile || null, profileMeta: args.profileMeta || null, requestedDates: inputDates, route: { fromAirport: args.fromAirport || null, toAirport: args.toAirport || null }, found: candidates.length > 0, candidates, inspected: inspections.map((x) => ({ source: x.source, airline: x.airline, parser: x.parser, url: x.url, status: x.status, zeroSignal: x.zeroSignal, zeroConfidence: x.zeroConfidence, zeroEvidence: x.zeroEvidence, routeMatched: x.routeMatched, routeReasons: x.routeReasons, routeEvidence: x.routeEvidence, promoWindows: x.windows, error: x.error })), disclaimer: 'v5A is stricter: pages need clearer 0đ evidence and stronger route proof before becoming alerts.' };
  appendAlerts(args.alertFile, output); return output;
}
async function runScan(args) {
  if (!args.allProfiles) return runSingleScan(args, args.profile || null);
  const { data } = loadWatchlist(args.watchlist); const profiles = (data.profiles || []).map((p) => p.name);
  const results = []; for (const name of profiles) results.push(await runSingleScan(args, name));
  return { version: '5A', mode: 'all-profiles', profiles: results, found: results.some((r) => r.found) };
}
function printOne(output) {
  console.log(`Requested dates: ${output.requestedDates.join(', ')}`);
  if (output.profile) console.log(`Profile: ${output.profile}`);
  if (output.route.fromAirport || output.route.toAirport) console.log(`Route filter: ${output.route.fromAirport || '*'} -> ${output.route.toAirport || '*'}`);
  console.log('');
  if (!output.candidates.length) console.log('No sufficiently strong 0đ promo evidence matched the requested filter.');
  else {
    console.log('Potential 0đ matches:');
    for (const c of output.candidates) {
      console.log(`- ${c.source}${c.airline ? ` (${c.airline})` : ''}`);
      console.log(`  URL: ${c.url}`);
      console.log(`  Parser: ${c.parser}`);
      console.log(`  Score: ${c.score}`);
      console.log(`  Zero confidence: ${c.zeroConfidence}`);
      console.log(`  Zero evidence: ${c.zeroEvidence.length ? c.zeroEvidence.join(', ') : '(none)'}`);
      console.log(`  Route evidence: ${c.routeEvidence.length ? c.routeEvidence.join(', ') : '(none)'}`);
      console.log(`  Matching dates: ${c.matchedDates.length ? c.matchedDates.join(', ') : '(none directly extracted)'}`);
      console.log(`  Promo windows: ${c.promoWindows.length ? c.promoWindows.map((w) => `${w.from}..${w.to}`).join('; ') : '(none extracted)'}`);
      console.log(`  New: ${c.isNew ? 'yes' : 'no'}`);
    }
  }
  console.log(''); console.log(output.disclaimer);
}
function printOutput(output, asJson) {
  if (asJson) { console.log(JSON.stringify(output, null, 2)); return; }
  if (output.mode === 'all-profiles') { for (const p of output.profiles) { console.log(`\n=== profile ${p.profile} ===`); printOne(p); } return; }
  printOne(output);
}
async function watchLoop(args) {
  const sec = Number(args.watchEverySec); if (!Number.isFinite(sec) || sec < 30) throw new Error('--watch-every must be a number >= 30 seconds');
  while (true) { const started = new Date().toISOString(); const output = await runScan(args); console.log(`\n=== scan @ ${started} ===`); printOutput(output, args.json); await new Promise((resolve) => setTimeout(resolve, sec * 1000)); }
}
async function main() {
  const args = parseArgs(process.argv.slice(2)); if (args.help) { usage(); process.exit(0); }
  if (!args.date && !(args.from && args.to) && !args.profile && !args.allProfiles) { usage(); process.exit(1); }
  if (args.watch) return await watchLoop(args);
  const output = await runScan(args); printOutput(output, args.json);
}
main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
