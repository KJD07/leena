// The scoring rubric. Each signal reads facts from extract.js / psi.js and returns a 0..1
// score plus the evidence it used. An LLM never touches this: scores are pure functions of the page.
//
// Weights are points out of 100 for a "neutral" page. Audience profiles multiply individual
// signal weights and change targets, then everything is renormalised back to 100.
// Signals that can't be measured (e.g. no PSI data, no visible form) return null and are
// dropped from the denominator instead of being guessed.

// Piecewise-linear helpers: full marks inside [good], zero outside [bad], linear in between.
const rampUp = (x, bad, good) => (x == null ? null : x >= good ? 1 : x <= bad ? 0 : (x - bad) / (good - bad));
const rampDown = (x, good, bad) => (x == null ? null : x <= good ? 1 : x >= bad ? 0 : (bad - x) / (bad - good));
const band = (x, [badLo, goodLo, goodHi, badHi]) => (x == null ? null : Math.min(rampUp(x, badLo, goodLo), rampDown(x, goodHi, badHi)));
const r = (score, evidence) => ({ score: score == null ? null : Math.max(0, Math.min(1, score)), evidence });
const fmt = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []);
const STOP = new Set(["with", "your", "that", "this", "from", "what", "they", "their", "leena", "more", "into", "about"]);

// ------------------------------------------------------------------------------------------
// Signal library. `p` = audience parameters (targets), `f` = page facts, `psi` = PageSpeed.
// ------------------------------------------------------------------------------------------
const S = {
  single_h1: {
    category: "clarity",
    label: "One clear H1 headline",
    score: (f) => {
      const n = f.headings.h1s.length;
      if (!n) return r(0, "No <h1> on the page");
      const len = band(f.headings.h1Words, [1, 3, 12, 20]);
      return r((n === 1 ? 1 : 0.5) * len, `${n} H1${n > 1 ? "s" : ""}; "${f.headings.h1}" (${f.headings.h1Words} words)`);
    },
  },
  subhead: {
    category: "clarity",
    label: "Supporting sub-headline in the hero",
    score: (f) => (f.hero.subhead ? r(1, `"${f.hero.subhead.slice(0, 120)}"`) : r(0, "No supporting paragraph under the H1")),
  },
  title_meta: {
    category: "clarity",
    label: "Title and meta description",
    score: (f) => {
      const t = band(f.head.title.length, [10, 30, 65, 90]);
      const d = band(f.head.metaDescription.length, [0, 70, 160, 250]);
      return r((t + d) / 2, `Title ${f.head.title.length} chars, meta description ${f.head.metaDescription.length} chars`);
    },
  },
  message_match: {
    category: "clarity",
    label: "Headline matches title & description (ad/search scent)",
    score: (f) => {
      const promise = new Set([...tokens(f.head.title), ...tokens(f.head.metaDescription), ...tokens(f.head.ogTitle)]);
      const hero = [...tokens(f.headings.h1 + " " + f.hero.subhead)].filter((w) => !STOP.has(w));
      if (!hero.length) return r(0, "No hero text to compare");
      const shared = hero.filter((w) => promise.has(w));
      return r(rampUp(shared.length / hero.length, 0.05, 0.35), `${shared.length}/${hero.length} hero words appear in title/description${shared.length ? `: ${shared.slice(0, 6).join(", ")}` : ""}`);
    },
  },

  cta_in_hero: {
    category: "cta",
    label: "Call to action in the hero (above the fold)",
    score: (f) => {
      const c = f.ctaSummary;
      if (c.hero) return r(1, `Hero CTA: "${f.ctas.find((x) => x.hero).text}"`);
      if (c.firstCtaWordOffset == null) return r(0, "No call to action in the page content");
      return r(rampDown(c.firstCtaWordOffset, 150, 600), `First CTA "${c.primaryText}" appears ~${c.firstCtaWordOffset} words down the page`);
    },
  },
  cta_intent_fit: {
    category: "cta",
    label: "Primary CTA fits the audience",
    score: (f, p) => {
      const i = f.ctaSummary.primaryIntent;
      if (!i) return r(0, "No recognisable CTA");
      const fit = p.ctaFit[i] ?? 0.3;
      return r(fit, `Primary CTA "${f.ctaSummary.primaryText}" is a ${i} action (fit for this audience: ${Math.round(fit * 100)}%)`);
    },
  },
  cta_repeated: {
    category: "cta",
    label: "CTA repeated down a long page",
    score: (f) => {
      if (f.content.wordCount < 500) return r(null, "Page is short; one CTA is enough");
      const n = f.ctas.filter((c) => c.intent === f.ctaSummary.primaryIntent).length;
      return r(rampUp(n, 1, 2), `Primary CTA appears ${n}x in ${f.content.wordCount} words`);
    },
  },
  cta_focus: {
    category: "cta",
    label: "Few competing CTA types",
    score: (f) => {
      const n = f.ctaSummary.intents.length;
      if (!n) return r(null, "No CTAs");
      return r(rampDown(n, 2, 4), `${n} distinct CTA type${n > 1 ? "s" : ""}: ${f.ctaSummary.intents.join(", ")}`);
    },
  },

  customer_logos: {
    category: "trust",
    label: "Customer logos",
    score: (f) => {
      const n = Math.max(f.trust.logoWallImages, f.trust.logoImages);
      return r(rampUp(n, 0, 6), f.trust.logoWallImages ? `Logo wall with ${f.trust.logoWallImages} images` : `${f.trust.logoImages} logo image(s)`);
    },
  },
  testimonials: {
    category: "trust",
    label: "Customer testimonials",
    score: (f) => {
      const n = f.trust.testimonialBlocks + f.trust.blockquotes;
      return r(rampUp(n, 0, 2), n ? `${n} attributed customer quote(s)` : "No customer quotes found");
    },
  },
  quantified_outcomes: {
    category: "trust",
    label: "Quantified outcomes (numbers, %, $)",
    score: (f) => r(rampUp(f.trust.statCount, 0, 4), f.trust.statCount ? `${f.trust.statCount} figures, e.g. ${f.trust.stats.slice(0, 5).join(", ")}` : "No hard numbers"),
  },
  analyst_validation: {
    category: "trust",
    label: "Analyst / review-site validation",
    score: (f) => r(f.trust.analystMentions.length ? 1 : 0, f.trust.analystMentions.length ? `Mentions ${f.trust.analystMentions.join(", ")}` : "No Gartner / Forrester / G2 etc."),
  },
  compliance: {
    category: "trust",
    label: "Security & compliance marks",
    score: (f) => r(rampUp(f.trust.compliance.length, 0, 2), f.trust.compliance.length ? f.trust.compliance.join(", ") : "No SOC 2 / ISO / GDPR / HIPAA marks"),
  },

  exit_links: {
    category: "friction",
    label: "Few exits / distractions",
    score: (f, p) => r(rampDown(f.links.total, p.maxLinksGood, p.maxLinksBad), `${f.links.total} links on the page (${f.links.inContent} inside the main content)`),
  },
  form_friction: {
    category: "friction",
    label: "Short form",
    score: (f, p) => {
      const n = f.forms.visibleFormFields;
      if (n == null) return r(null, f.forms.providers.length ? `Form loads via ${f.forms.providers.join(", ")} (fields not visible in HTML)` : "No form in the HTML (likely opens in a modal)");
      return r(rampDown(n, p.formFieldsGood, p.formFieldsBad), `Shortest form has ${n} field(s)`);
    },
  },

  readability: {
    category: "content",
    label: "Readable copy",
    score: (f) => {
      const e = f.content.readingEase;
      if (e == null) return r(null, "Too little prose to measure");
      return r(rampUp(e, 20, 55), `Flesch reading ease ${Math.round(e)} (60+ is plain English)`);
    },
  },
  scannability: {
    category: "content",
    label: "Scannable structure",
    score: (f) => {
      const h = band(f.content.headingsPer300Words, [0.3, 1, 8, 15]);
      const para = rampDown(f.content.avgParagraphWords, 40, 90);
      return r(0.7 * h + 0.3 * para, `${f.content.headingsPer300Words.toFixed(1)} headings per 300 words, paragraphs avg ${f.content.avgParagraphWords} words`);
    },
  },
  length_fit: {
    category: "content",
    label: "Page length fits the audience",
    score: (f, p) => r(band(f.content.wordCount, p.wordBand), `${f.content.wordCount} words (target ${Math.round(p.wordBand[1])}–${Math.round(p.wordBand[2])})`),
  },

  psi_performance: {
    category: "performance",
    label: "Lighthouse performance (mobile)",
    score: (f, p, psi) => (psi?.ok && psi.performance != null ? r(rampUp(psi.performance, 0.25, 0.9), `Performance score ${Math.round(psi.performance * 100)}/100`) : r(null, psi?.reason || "PageSpeed data unavailable")),
  },
  lcp: {
    category: "performance",
    label: "Largest Contentful Paint",
    score: (f, p, psi) => (psi?.ok && psi.lcpMs != null ? r(rampDown(psi.lcpMs, 2500, 6000), `LCP ${fmt(psi.lcpMs)} on mobile (good ≤ 2.5s)`) : r(null, psi?.reason || "PageSpeed data unavailable")),
  },
  cls: {
    category: "performance",
    label: "Layout stability (CLS)",
    score: (f, p, psi) => (psi?.ok && psi.cls != null ? r(rampDown(psi.cls, 0.1, 0.4), `CLS ${psi.cls.toFixed(3)} (good ≤ 0.1)`) : r(null, psi?.reason || "PageSpeed data unavailable")),
  },
};

export const CATEGORIES = {
  clarity: "Message clarity",
  cta: "Call to action",
  trust: "Trust & proof",
  friction: "Friction",
  content: "Content",
  performance: "Speed",
};

// ------------------------------------------------------------------------------------------
// v1: my first rubric, written from general CRO best practice before seeing any results.
// Kept unchanged so the comparison with v2 is honest.
// ------------------------------------------------------------------------------------------
const V1 = {
  id: "v1",
  name: "v1 · first draft",
  weights: {
    single_h1: 6, subhead: 4, title_meta: 4, message_match: 6,
    cta_in_hero: 10, cta_intent_fit: 5, cta_repeated: 5, cta_focus: 5,
    customer_logos: 5, testimonials: 5, quantified_outcomes: 4, analyst_validation: 3, compliance: 3,
    exit_links: 5, form_friction: 5,
    readability: 4, scannability: 3, length_fit: 3,
    psi_performance: 8, lcp: 4, cls: 3,
  },
  audiences: {
    enterprise: {
      // Enterprise buyers need risk reduction before they talk to sales: proof outweighs speed
      mult: { compliance: 3, analyst_validation: 2, testimonials: 1.5, customer_logos: 1.5, form_friction: 0.5 },
      params: { ctaFit: { sales: 1, contact: 0.7, content: 0.5, trial: 0.4 }, formFieldsGood: 7, formFieldsBad: 14, wordBand: [300, 600, 2500, 4000], maxLinksGood: 60, maxLinksBad: 180 },
    },
    self_serve: {
      // Self-serve visitors bounce on friction: speed and short forms matter most
      mult: { form_friction: 2, psi_performance: 1.5, lcp: 1.5, compliance: 0.3, analyst_validation: 0.5 },
      params: { ctaFit: { trial: 1, sales: 0.4, contact: 0.3, content: 0.4 }, formFieldsGood: 3, formFieldsBad: 7, wordBand: [100, 200, 1200, 2500], maxLinksGood: 40, maxLinksBad: 140 },
    },
    learner: {
      // Readers judge the content itself; enterprise proof is mostly noise to them
      mult: { readability: 1.5, scannability: 1.5, length_fit: 1.5, compliance: 0.2, analyst_validation: 0.3, customer_logos: 0.5, cta_repeated: 0.5 },
      params: { ctaFit: { content: 1, trial: 0.6, sales: 0.3, contact: 0.3 }, formFieldsGood: 4, formFieldsBad: 8, wordBand: [150, 250, 3000, 6000], maxLinksGood: 60, maxLinksBad: 200 },
    },
  },
};

// ------------------------------------------------------------------------------------------
// v2: changes made after checking v1 against Leena's data. Each one comes from looking at
// *why* a page was mis-ranked, not from fitting weights to three data points.
// ------------------------------------------------------------------------------------------
const V2_SIGNALS = {
  // Change 1. v1 ignored site chrome, so the HR page (sticky blue "Book a demo" in the header,
  // nothing in the hero) scored 0 for "CTA above the fold" yet converts as well as the home page.
  // A sticky header CTA is on screen the whole visit; it earns most of the credit.
  cta_first_screen: {
    category: "cta",
    label: "Call to action visible on the first screen",
    score: (f) => {
      const c = f.ctaSummary;
      if (c.hero) return r(1, `Hero CTA: "${f.ctas.find((x) => x.hero).text}"`);
      const head = f.header?.ctas?.[0];
      if (head && f.header.sticky) return r(0.8, `No hero CTA, but the sticky header keeps "${head.text}" on screen for the whole visit`);
      if (head) return r(0.4, `No hero CTA; header has "${head.text}" but scrolls away`);
      if (c.firstCtaWordOffset == null) return r(0, "No call to action on the page");
      return r(rampDown(c.firstCtaWordOffset, 150, 600), `First CTA "${c.primaryText}" appears ~${c.firstCtaWordOffset} words down the page`);
    },
  },
  // Change 3. The webinar's "Watch now" scrolls to a 4-field form (name, last name, company,
  // email): the content is gated. Readers came for the content; a gate is the biggest
  // friction they meet. Enterprise lead-gen pages are *expected* to gate, so it doesn't count there.
  content_gate: {
    category: "friction",
    label: "Content isn't locked behind a form",
    score: (f) => {
      if (!f.learning.mainContentCta) return r(null, "No content offer on the page");
      return f.learning.gateLikely
        ? r(0.3, `"${f.learning.mainContentCta}" is a script button with no player or file on the page: the content is gated behind a form`)
        : r(1, `"${f.learning.mainContentCta}" opens the content directly`);
    },
  },
  // Change 4. With PageSpeed on, one Lighthouse run moved the HR page's performance between
  // 0.38 and 0.50, enough to swap HR and the webinar. Speed is now read from the median of
  // several lab runs, and LCP / CLS from real Chrome users (CrUX, p75 over 28 days) when Google
  // has data for that URL: that is what visitors actually experienced.
  psi_performance: {
    category: "performance",
    label: "Lighthouse performance (mobile, median of runs)",
    score: (f, p, psi) => {
      const v = psi?.median?.performance;
      if (!psi?.ok || v == null) return r(null, psi?.reason || "PageSpeed data unavailable");
      return r(rampUp(v, 0.25, 0.9), `Performance ${Math.round(v * 100)}/100, ${runSpread(psi, "performance", (x) => Math.round(x * 100))}`);
    },
  },
  lcp: {
    category: "performance",
    label: "Largest Contentful Paint (real users when available)",
    score: (f, p, psi) => {
      if (!psi?.ok) return r(null, psi?.reason || "PageSpeed data unavailable");
      if (psi.fieldLcpMs != null) return r(rampDown(psi.fieldLcpMs, 2500, 6000), `LCP ${fmt(psi.fieldLcpMs)} for real Chrome users (p75, 28 days; good ≤ 2.5s)`);
      const v = psi.median?.lcpMs;
      return v == null ? r(null, "LCP unavailable") : r(rampDown(v, 2500, 6000), `LCP ${fmt(v)} in the lab, ${runSpread(psi, "lcpMs", fmt)}; no real-user data for this URL`);
    },
  },
  cls: {
    category: "performance",
    label: "Layout stability (CLS, real users when available)",
    score: (f, p, psi) => {
      if (!psi?.ok) return r(null, psi?.reason || "PageSpeed data unavailable");
      if (psi.fieldCls != null) return r(rampDown(psi.fieldCls, 0.1, 0.4), `CLS ${psi.fieldCls.toFixed(2)} for real Chrome users (p75, 28 days; good ≤ 0.1)`);
      const v = psi.median?.cls;
      return v == null ? r(null, "CLS unavailable") : r(rampDown(v, 0.1, 0.4), `CLS ${v.toFixed(3)} in the lab, ${runSpread(psi, "cls", (x) => x.toFixed(3))}; no real-user data for this URL`);
    },
  },
};

// "median of 3 runs (38–50)", so the evidence shows how much the lab measurement moved
function runSpread(psi, key, show) {
  const vals = (psi.runs || []).map((x) => x[key]).filter((x) => x != null);
  if (vals.length < 2) return "single run";
  return `median of ${vals.length} runs (${show(Math.min(...vals))}–${show(Math.max(...vals))})`;
}

const V2 = {
  id: "v2",
  name: "v2 · after checking against data",
  // Change 2. Blend audience profiles by detection confidence instead of winner-takes-all.
  // In v1 the webinar was 71% learner / 29% enterprise, and flipping that label moved its
  // score by 16 points (85 vs 69). A paid-social-promoted webinar asking for company name is
  // partly an enterprise lead-gen page, so it is judged partly on enterprise proof.
  blend: true,
  signals: V2_SIGNALS,
  weights: {
    single_h1: 6, subhead: 4, title_meta: 4, message_match: 6,
    cta_first_screen: 10, cta_intent_fit: 5, cta_repeated: 5, cta_focus: 5,
    customer_logos: 5, testimonials: 5, quantified_outcomes: 4, analyst_validation: 3, compliance: 3,
    exit_links: 5, form_friction: 5, content_gate: 4,
    readability: 4, scannability: 3, length_fit: 3,
    psi_performance: 8, lcp: 4, cls: 3,
  },
  audiences: {
    enterprise: { ...V1.audiences.enterprise, mult: { ...V1.audiences.enterprise.mult, content_gate: 0 } },
    self_serve: { ...V1.audiences.self_serve, mult: { ...V1.audiences.self_serve.mult, content_gate: 1 } },
    learner: { ...V1.audiences.learner, mult: { ...V1.audiences.learner.mult, content_gate: 2 } },
  },
};

export const RUBRICS = { v1: V1, v2: V2 };
export const DEFAULT_RUBRIC = "v2";

// Mixes audience profiles by share: numbers average, arrays average element-wise, objects per key.
function blendProfiles(rubric, shares) {
  const entries = Object.entries(shares).filter(([a, w]) => w > 0 && rubric.audiences[a]);
  const mix = (get) => {
    const vals = entries.map(([a, w]) => [get(rubric.audiences[a]), w]);
    const first = vals[0][0];
    if (Array.isArray(first)) return first.map((_, i) => vals.reduce((n, [v, w]) => n + v[i] * w, 0));
    if (first && typeof first === "object") {
      const keys = new Set(vals.flatMap(([v]) => Object.keys(v)));
      return Object.fromEntries([...keys].map((k) => [k, vals.reduce((n, [v, w]) => n + (v[k] ?? 0.3) * w, 0)]));
    }
    return vals.reduce((n, [v, w]) => n + v * w, 0);
  };
  const ids = Object.keys(rubric.weights);
  const paramKeys = Object.keys(Object.values(rubric.audiences)[0].params);
  return {
    mult: Object.fromEntries(ids.map((id) => [id, mix((p) => p.mult[id] ?? 1)])),
    params: Object.fromEntries(paramKeys.map((k) => [k, mix((p) => p.params[k])])),
  };
}

export function scorePage(facts, psi, audience, rubricId = DEFAULT_RUBRIC, shares = null) {
  const rubric = RUBRICS[rubricId] || RUBRICS[DEFAULT_RUBRIC];
  const profile = rubric.blend && shares ? blendProfiles(rubric, shares) : rubric.audiences[audience];
  const signals = [];
  for (const [id, baseWeight] of Object.entries(rubric.weights)) {
    const def = (rubric.signals && rubric.signals[id]) || S[id];
    const weight = baseWeight * (profile.mult[id] ?? 1);
    const { score, evidence } = def.score(facts, profile.params, psi);
    signals.push({ id, category: def.category, label: def.label, baseWeight, weight, score, evidence });
  }
  const scored = signals.filter((s) => s.score != null && s.weight > 0);
  const totalWeight = scored.reduce((n, s) => n + s.weight, 0);
  for (const s of signals) {
    s.maxPoints = s.score == null ? 0 : (s.weight / totalWeight) * 100;
    s.points = s.score == null ? 0 : s.score * s.maxPoints;
  }
  const categories = Object.entries(CATEGORIES).map(([id, label]) => {
    const inCat = signals.filter((s) => s.category === id);
    const max = inCat.reduce((n, s) => n + s.maxPoints, 0);
    const pts = inCat.reduce((n, s) => n + s.points, 0);
    return { id, label, points: pts, maxPoints: max, pct: max ? pts / max : null, skipped: inCat.filter((s) => s.score == null).length };
  });
  const total = scored.reduce((n, s) => n + s.points, 0);
  return {
    rubric: rubric.id,
    rubricName: rubric.name,
    audience,
    blendedWith: rubric.blend && shares ? shares : null,
    total: Math.round(total),
    categories,
    signals,
    skipped: signals.filter((s) => s.score == null).map((s) => s.id),
  };
}

// Exposed for v2 and for docs/tests
export { S as SIGNALS, rampUp, rampDown, band, r };
