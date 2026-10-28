// Runs every rubric on every page in data/pages.json and compares the grader's ranking with
// real conversion. Writes reports/validation.md and reports/validation.json (both gitignored,
// because they contain Leena's confidential numbers).
//
// Usage: PSI_API_KEY=... npm run validate        (PageSpeed is skipped without a key)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gradeUrl } from "../src/grade.js";
import { runPageSpeed } from "../src/psi.js";
import { RUBRICS } from "../src/rubric.js";
import { spearman, kendall, pearson, wilson, twoProportionP, mulberry32 } from "./stats.mjs";

if (!existsSync("data/pages.json")) {
  console.error('data/pages.json not found. Run: npm run import-data -- "path/to/Website Data - Summary.xlsx"');
  process.exit(1);
}
const pages = JSON.parse(readFileSync("data/pages.json", "utf8"));
const psiKey = process.env.PSI_API_KEY;
const rubricIds = Object.keys(RUBRICS);

// ---- 1. Grade every page with every rubric (PSI fetched once per page and shared) ----
const rows = [];
for (const p of pages) {
  process.stdout.write(`Grading ${p.url} ... `);
  const psi = psiKey ? await runPageSpeed(p.url, { apiKey: psiKey }) : { ok: false, reason: "No PSI_API_KEY set" };
  const row = { ...p, psi: psi.ok ? { performance: psi.performance, lcpMs: psi.lcpMs, cls: psi.cls } : { error: psi.reason }, grades: {} };
  for (const id of rubricIds) {
    const g = await gradeUrl(p.url, { rubric: id, psiResult: psi });
    row.grades[id] = {
      total: g.score.total,
      audience: g.audience.used,
      shares: g.audience.shares,
      categories: Object.fromEntries(g.score.categories.map((c) => [c.id, c.pct == null ? null : Math.round(c.pct * 100)])),
      signals: Object.fromEntries(g.score.signals.map((s) => [s.id, s.score == null ? null : +s.score.toFixed(2)])),
    };
  }
  rows.push(row);
  console.log(rubricIds.map((id) => `${id}=${row.grades[id].total}`).join(" "), psi.ok ? "" : `(PSI: ${psi.reason})`);
}

// ---- 2. How much of the conversion data can we trust? ----
for (const r of rows) r.ci = wilson(r.formFills, r.sessions);
const pairs = [];
for (let i = 0; i < rows.length; i++)
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j];
    pairs.push({ a: i, b: j, p: twoProportionP(a.formFills, a.sessions, b.formFills, b.sessions) });
  }

// ---- 3. Traffic-mix adjustment ----
// Raw conversion mixes page quality with traffic intent: paid social clicks convert far worse
// than branded direct visits whatever the page looks like. We don't know Leena's per-channel
// rates (3 pages can't identify 6 unknowns), so we sample plausible *relative* intents
// (direct = 1) from wide ranges and check how often each conclusion survives.
const INTENT_RANGES = {
  direct: [1, 1],
  organic_search: [0.5, 1.2],
  paid_search: [0.6, 1.5],
  paid_social: [0.05, 0.5],
  email: [0.3, 1.2],
  others: [0.3, 1.0],
};
const expectedIntent = (traffic, w) => Object.entries(traffic).reduce((n, [ch, share]) => n + share * (w[ch] ?? 0.6), 0);
const midpoint = Object.fromEntries(Object.entries(INTENT_RANGES).map(([k, [lo, hi]]) => [k, (lo + hi) / 2]));
for (const r of rows) r.adjCvrMid = r.cvr / expectedIntent(r.traffic, midpoint);

const rand = mulberry32(42);
const DRAWS = 5000;
const sens = Object.fromEntries(rubricIds.map((id) => [id, []]));
const adjOrderCounts = {};
for (let d = 0; d < DRAWS; d++) {
  const w = Object.fromEntries(Object.entries(INTENT_RANGES).map(([k, [lo, hi]]) => [k, lo + rand() * (hi - lo)]));
  const adj = rows.map((r) => r.cvr / expectedIntent(r.traffic, w));
  const order = adj.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).map(([, i]) => i).join(">");
  adjOrderCounts[order] = (adjOrderCounts[order] || 0) + 1;
  for (const id of rubricIds) sens[id].push(spearman(rows.map((r) => r.grades[id].total), adj));
}
const quantile = (arr, q) => [...arr].sort((a, b) => a - b)[Math.floor(q * (arr.length - 1))];

// ---- 4. Agreement metrics per rubric ----
const cvr = rows.map((r) => r.cvr);
const metrics = {};
for (const id of rubricIds) {
  const s = rows.map((r) => r.grades[id].total);
  const concord = pairs.map(({ a, b, p }) => ({ a, b, p, agree: Math.sign(s[a] - s[b]) === Math.sign(cvr[a] - cvr[b]), tie: s[a] === s[b] }));
  const sig = concord.filter((c) => c.p < 0.05);
  metrics[id] = {
    spearman: spearman(s, cvr),
    kendall: kendall(s, cvr),
    pearson: pearson(s, cvr),
    pairwise: `${concord.filter((c) => c.agree).length}/${concord.length}`,
    significantPairs: `${sig.filter((c) => c.agree).length}/${sig.length}`,
    spearmanAdjMid: spearman(s, rows.map((r) => r.adjCvrMid)),
    spearmanAdjMedian: quantile(sens[id], 0.5),
    spearmanAdjP10: quantile(sens[id], 0.1),
    spearmanAdjP90: quantile(sens[id], 0.9),
    concord,
  };
}

// ---- 5. Report ----
const short = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") || u;
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const f2 = (x) => (x >= 0 ? " " : "") + x.toFixed(2);
let md = `# Validation report\n\nGenerated ${new Date().toISOString()} · ${rows.length} pages · PageSpeed: ${psiKey ? "on" : "**off** (no PSI_API_KEY; performance signals were dropped and weights renormalised)"}\n\n`;
md += `## Grader vs. reality\n\n| Page | Sessions | Form fills | CVR (95% CI) | Traffic-adjusted CVR* | ${rubricIds.map((id) => `${id} score (audience)`).join(" | ")} |\n|---|---:|---:|---|---:|${rubricIds.map(() => "---|").join("")}\n`;
for (const r of rows)
  md += `| ${short(r.url)} | ${r.sessions.toLocaleString()} | ${r.formFills} | ${pct(r.cvr)} (${pct(r.ci[0])}–${pct(r.ci[1])}) | ${pct(r.adjCvrMid)} | ${rubricIds.map((id) => `**${r.grades[id].total}** (${r.grades[id].audience})`).join(" | ")} |\n`;
md += `\n\\* raw CVR divided by the page's expected traffic intent at the midpoint of the channel ranges below.\n\n## Agreement\n\n| Metric | ${rubricIds.join(" | ")} |\n|---|${rubricIds.map(() => "---:|").join("")}\n`;
const line = (label, fn) => (md += `| ${label} | ${rubricIds.map((id) => fn(metrics[id])).join(" | ")} |\n`);
line("Spearman ρ vs raw CVR", (m) => f2(m.spearman));
line("Kendall τ vs raw CVR", (m) => f2(m.kendall));
line("Pairs ordered correctly (all)", (m) => m.pairwise);
line("Pairs ordered correctly (only statistically real differences, p<0.05)", (m) => m.significantPairs);
line("Spearman ρ vs traffic-adjusted CVR (midpoint)", (m) => f2(m.spearmanAdjMid));
line(`Spearman ρ vs traffic-adjusted CVR (median of ${DRAWS} draws, 10th–90th pct)`, (m) => `${f2(m.spearmanAdjMedian)} (${f2(m.spearmanAdjP10)} to ${f2(m.spearmanAdjP90)})`);
md += `\n## Which conversion differences are real?\n\n| Pair | CVR | p-value (two-proportion z) | Real difference? |\n|---|---|---:|---|\n`;
for (const { a, b, p } of pairs) md += `| ${short(rows[a].url)} vs ${short(rows[b].url)} | ${pct(rows[a].cvr)} vs ${pct(rows[b].cvr)} | ${p < 0.001 ? "<0.001" : p.toFixed(3)} | ${p < 0.05 ? "yes" : "no: within noise"} |\n`;
md += `\n## Traffic-mix sensitivity\n\nRelative channel intent ranges (direct = 1): ${Object.entries(INTENT_RANGES).map(([k, [lo, hi]]) => `${k} ${lo}–${hi}`).join(", ")}.\n\nHow often each true ordering comes out across ${DRAWS} draws:\n\n`;
for (const [order, n] of Object.entries(adjOrderCounts).sort((a, b) => b[1] - a[1])) md += `- ${order.split(">").map((i) => short(rows[i].url)).join(" > ")}: ${pct(n / DRAWS, 1)}\n`;
md += `\n## Signal scores per page\n\n| Signal | ${rows.map((r) => rubricIds.map((id) => `${short(r.url).split("/").pop() || "home"} ${id}`).join(" | ")).join(" | ")} |\n|---|${rows.map(() => rubricIds.map(() => "---:|").join("")).join("")}\n`;
const signalIds = [...new Set(rubricIds.flatMap((id) => Object.keys(rows[0].grades[id].signals)))];
for (const sid of signalIds) md += `| ${sid} | ${rows.map((r) => rubricIds.map((id) => r.grades[id].signals[sid] ?? "–").join(" | ")).join(" | ")} |\n`;

mkdirSync("reports", { recursive: true });
writeFileSync("reports/validation.md", md);
writeFileSync("reports/validation.json", JSON.stringify({ rows, metrics, adjOrderCounts, intentRanges: INTENT_RANGES }, null, 2));
console.log("\n" + md.split("## Which")[0]);
console.log("Full report: reports/validation.md");
