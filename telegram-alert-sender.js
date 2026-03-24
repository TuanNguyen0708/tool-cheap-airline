#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--truncate') args.truncate = true;
  }
  return args;
}

function formatAlert(obj) {
  const header = obj.profile ? `✈️ Flight zero alert: ${obj.profile}` : '✈️ Flight zero alert';
  const route = `${obj.route?.fromAirport || '*'} -> ${obj.route?.toAirport || '*'}`;
  const lines = [header, `Route: ${route}`, `Dates: ${obj.requestedDates?.[0]} .. ${obj.requestedDates?.[obj.requestedDates.length - 1]}`];
  for (const c of obj.candidates || []) {
    lines.push('');
    lines.push(`• ${c.source}${c.airline ? ` (${c.airline})` : ''}`);
    lines.push(`  Score: ${c.score}`);
    lines.push(`  Zero evidence: ${c.zeroEvidence?.length ? c.zeroEvidence.join(', ') : '(none)'}`);
    lines.push(`  Promo windows: ${c.promoWindows?.length ? c.promoWindows.map((w) => `${w.from}..${w.to}`).join('; ') : '(none extracted)'}`);
    lines.push(`  URL: ${c.url}`);
  }
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error('Need --file');
  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) throw new Error(`Alert file not found: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const obj = JSON.parse(line);
    const msg = formatAlert(obj);
    if (args.dryRun) console.log(msg + '\n---');
    else await sendTelegram(msg);
  }
  if (args.truncate) fs.writeFileSync(file, '');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
