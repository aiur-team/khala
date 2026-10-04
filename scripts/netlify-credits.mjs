#!/usr/bin/env node
// Estimates this billing period's Netlify credit use for the team account from
// the only metered items that matter here: production deploys (15 credits each)
// and bandwidth (20 credits per GB). Web requests (2 per 10k) and function
// compute are not exposed by the API and are small at our traffic; they are why
// the guard thresholds leave headroom. Prints JSON; exits 2 when `--max`
// (credits, after adding `--plus`) would be exceeded.
//   NETLIFY_AUTH_TOKEN=… node scripts/netlify-credits.mjs [--plus 15] [--max 750]
const ACCOUNT = process.env.NETLIFY_ACCOUNT_ID ?? '6837573391856753101881a9';
const ALLOWANCE = Number(process.env.NETLIFY_CREDIT_ALLOWANCE ?? 1000);
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!token) { console.error('NETLIFY_AUTH_TOKEN is required'); process.exit(1); }
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const plus = arg('--plus', 0);
const max = arg('--max', Infinity);
// Hard cap on production deploys this period (the exact, dominant cost).
const maxDeploys = arg('--max-deploys', Infinity);

async function api(path) {
  const res = await fetch(`https://api.netlify.com/api/v1/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const bandwidth = await api(`accounts/${ACCOUNT}/bandwidth`);
const periodStart = new Date(bandwidth.period_start_date);
const sites = await api(`${ACCOUNT}/sites?per_page=100`).catch(() => api('sites?per_page=100&filter=all'));
let prodDeploys = 0;
for (const site of sites) {
  for (let page = 1; page < 20; page++) {
    const deploys = await api(`sites/${site.id}/deploys?per_page=100&page=${page}`);
    const inPeriod = deploys.filter(d => new Date(d.created_at) >= periodStart);
    prodDeploys += inPeriod.filter(d => d.context === 'production' && d.state === 'ready').length;
    if (deploys.length < 100 || inPeriod.length < deploys.length) break;
  }
}
const bandwidthGb = bandwidth.used / 1e9;
const estimated = Math.round(prodDeploys * 15 + bandwidthGb * 20);
const out = {
  periodStart: bandwidth.period_start_date, periodEnd: bandwidth.period_end_date,
  prodDeploys, bandwidthGb: Number(bandwidthGb.toFixed(3)), estimatedCredits: estimated,
  allowance: ALLOWANCE, percent: Math.round((estimated / ALLOWANCE) * 100),
  afterPlus: estimated + plus, max: Number.isFinite(max) ? max : null,
  maxDeploys: Number.isFinite(maxDeploys) ? maxDeploys : null,
};
console.log(JSON.stringify(out));
if (estimated + plus > max) { console.error(`over budget: ${estimated + plus} > ${max} credits`); process.exit(2); }
if (prodDeploys >= maxDeploys) { console.error(`deploy cap reached: ${prodDeploys} >= ${maxDeploys} production deploys this period`); process.exit(2); }
