// Orchestrates one grading run: fetch the live page, run PageSpeed in parallel, extract facts,
// detect the audience and score it with the chosen rubric.
import { fetchPage, normalizeUrl } from "./fetchPage.js";
import { extractFacts } from "./extract.js";
import { runPageSpeed } from "./psi.js";
import { detectAudience, AUDIENCES } from "./audience.js";
import { scorePage, RUBRICS, DEFAULT_RUBRIC } from "./rubric.js";

export async function gradeUrl(input, { psiKey, rubric = DEFAULT_RUBRIC, audience: forcedAudience, skipPsi = false, psiResult } = {}) {
  const url = normalizeUrl(input);
  const psiPromise = psiResult ? Promise.resolve(psiResult) : skipPsi ? Promise.resolve({ ok: false, reason: "PageSpeed skipped" }) : runPageSpeed(url, { apiKey: psiKey });
  const page = await fetchPage(url);
  const facts = extractFacts(page.html, page.finalUrl);
  const psi = await psiPromise;
  const detection = detectAudience(facts);
  const audience = AUDIENCES[forcedAudience] ? forcedAudience : detection.detected;
  // Forcing an audience means judging the page purely for that audience
  const shares = audience === detection.detected && !forcedAudience ? detection.shares : { [audience]: 1 };
  const score = scorePage(facts, psi, audience, rubric, shares);
  // What the same page would score if it were purely for each audience, to make the weighting visible
  const byAudience = Object.fromEntries(Object.keys(AUDIENCES).map((a) => [a, scorePage(facts, psi, a, rubric, { [a]: 1 }).total]));

  const { text, ...publicFacts } = facts;
  return {
    url,
    finalUrl: page.finalUrl,
    fetchedAt: new Date().toISOString(),
    fetchMs: page.fetchMs,
    audience: { ...detection, used: audience, forced: audience !== detection.detected },
    score,
    byAudience,
    psi,
    facts: publicFacts,
    rubrics: Object.values(RUBRICS).map((r) => ({ id: r.id, name: r.name })),
  };
}
