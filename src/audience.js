// Works out who a page is for from what is on it. Deterministic: every point is a named
// piece of evidence, so the UI can show exactly why an audience was picked.

export const AUDIENCES = {
  enterprise: { label: "Enterprise buyer", blurb: "Evaluating a vendor for their company; needs proof and a path to sales." },
  self_serve: { label: "Self-serve user", blurb: "Wants to try or buy on their own, right now, with as little friction as possible." },
  learner: { label: "Learner", blurb: "Here to read, watch or learn; the conversion is a soft one (register, watch, download)." },
};

const LEARN_PATH = /\/(blog|resources?|webinars?|events?|guides?|ebooks?|whitepapers?|reports?|learn|academy|podcasts?|library|insights|articles?|news)(\/|$)/i;
const LEARN_SCHEMA = /^(Article|BlogPosting|NewsArticle|TechArticle|Event|VideoObject|HowTo|Course|PodcastEpisode)$/;
const ENTERPRISE_TERMS = /\b(enterprise|integrations?|security|compliance|ROI|implementation|SSO|governance|Fortune 500|CIO|CHRO|CFO|CISO|procurement|scal(e|able))\b/gi;

export function detectAudience(f) {
  const ev = { enterprise: [], self_serve: [], learner: [] };
  const add = (aud, pts, why) => ev[aud].push({ pts, why });

  // Calls to action are the strongest tell: they show what the page wants the visitor to do
  const byIntent = (i) => f.ctas.filter((c) => c.intent === i);
  const heroIntent = (i) => f.ctas.some((c) => c.intent === i && c.hero);
  if (byIntent("sales").length) add("enterprise", 3, `Sales CTA: "${byIntent("sales")[0].text}"`);
  if (heroIntent("sales")) add("enterprise", 2, "Sales CTA is in the hero");
  if (byIntent("trial").length) add("self_serve", 3, `Self-serve CTA: "${byIntent("trial")[0].text}"`);
  if (heroIntent("trial")) add("self_serve", 2, "Sign-up / trial CTA is in the hero");
  if (byIntent("content").length) add("learner", 2, `Content CTA: "${byIntent("content")[0].text}"`);
  if (heroIntent("content") && f.ctaSummary.primaryIntent === "content") add("learner", 2, "The primary hero CTA is a content action");

  // Enterprise vocabulary and trust marks
  const terms = [...new Set(((f.text + " " + f.headings.h2s.join(" ") + " " + f.head.metaDescription).match(ENTERPRISE_TERMS) || []).map((t) => t.toLowerCase()))];
  if (terms.length) add("enterprise", Math.min(2, terms.length * 0.5), `Enterprise vocabulary: ${terms.slice(0, 4).join(", ")}`);
  if (f.trust.compliance.length) add("enterprise", 0.5, `Compliance marks: ${f.trust.compliance.join(", ")}`);

  // Self-serve: visible prices, free plans
  if (f.selfServe.priceMentions) add("self_serve", 2, `${f.selfServe.priceMentions} visible price(s) like "$X/mo"`);
  if (f.selfServe.freeMarkers) add("self_serve", 2, `"Free trial / no credit card" language (${f.selfServe.freeMarkers}x)`);

  // Learner: URL, structured data, event/article cues
  if (LEARN_PATH.test(f.path)) add("learner", 3, `URL is a content path (${f.path.match(LEARN_PATH)[0]})`);
  const learnSchema = f.schemaTypes.filter((t) => LEARN_SCHEMA.test(t));
  if (learnSchema.length) add("learner", 3, `Structured data says ${learnSchema.join(", ")}`);
  const cues = f.learning.eventMarkers + f.learning.articleMarkers;
  if (cues) add("learner", Math.min(2, cues * 0.5), `Event / article cues in copy (${cues}x)`);
  if (f.content.wordCount > 1500 && f.ctaSummary.total <= 2) add("learner", 1, `Long read (${f.content.wordCount} words) with few CTAs`);

  const totals = Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, v.reduce((n, e) => n + e.pts, 0)]));
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  // With no evidence at all, assume the B2B default (most landing pages are lead-gen)
  const shares = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, sum ? v / sum : k === "enterprise" ? 1 : 0]));
  const detected = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0];
  return { detected, label: AUDIENCES[detected].label, confidence: shares[detected], shares, evidence: ev };
}
