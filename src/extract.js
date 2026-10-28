// Turns raw HTML into plain facts about the page. No scoring happens here: every number
// the rubric uses comes from this file, so each point can be traced to an element on the page.
import { parse } from "node-html-parser";

const CHROME_SELECTORS = "header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]";
const NOISE_SELECTORS = "script, style, noscript, svg, template, iframe";

// CTA intents, checked in this order. "label" text is matched against button/link text.
export const CTA_INTENTS = [
  { intent: "sales", re: /\b(book|schedule|request|get|see|watch)\b.{0,20}\bdemo\b|\btalk to (sales|an expert|us)\b|\bcontact sales\b|\bget a quote\b|\bspeak (to|with)\b/i },
  { intent: "trial", re: /\b(start|try|get started)\b.{0,20}\b(free|trial)\b|\bfree trial\b|\bsign ?up\b|\bget started\b|\bstart (building|now|for free)\b|\bcreate (an |your )?account\b|\btry (it )?(now|free)\b|\bget\b.{0,15}\bfree\b|\bdownload (the )?app\b/i },
  { intent: "content", re: /\b(watch|register|save my seat|reserve( my)? (seat|spot)|download|read( the| more| now)?|listen|get the (guide|report|ebook|playbook)|view (the )?(webinar|recording|report|guide)|get (instant )?access)\b/i },
  // "Contact" only counts as a CTA when it is the whole label, so feature names like "Contact management" don't
  { intent: "contact", re: /^\s*(contact( us| sales)?|get in touch|reach out)\s*[→>]?\s*$|\bcontact us\b/i },
];

const FORM_PROVIDERS = /hsforms|hs-scripts|hbspt\.forms|marketo|mktoForms|pardot|typeform|calendly|chilipiper|tally\.so|jotform|formstack|leadsquared/gi;
const ANALYSTS = /\b(Gartner|Forrester|IDC|Everest Group|G2|Capterra|TrustRadius|Frost & Sullivan)\b/g;
const COMPLIANCE = /\b(SOC ?2|SOC 1|ISO ?27001|ISO ?27701|ISO ?42001|GDPR|HIPAA|CCPA|FedRAMP|PCI[- ]DSS)\b/gi;
// Quantified claims: 40%, 3x, $2M, 51,000 employees, 45 days, 24x7
const STAT_RE = /(\$\s?\d[\d,.]*\s?(k|m|mn|million|bn|billion)?\b|\b\d[\d,.]*\s?(%|x\b|×)|\b\d{1,3}(,\d{3})+\b|\b\d+\+?\s(days|weeks|hours|minutes|employees|customers|languages|integrations|countries)\b)/gi;

const words = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []);
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// Text with one line per text node, so "30 mins" and "Watch now" in sibling elements don't merge.
function textOf(el) {
  const parts = [];
  (function walk(node) {
    if (node.nodeType === 3) {
      const t = clean(node.text);
      if (t) parts.push(t);
    } else if (node.nodeType === 1) {
      for (const child of node.childNodes) walk(child);
    }
  })(el);
  return parts.join("\n");
}

// Flesch Reading Ease over prose lines only (3+ words), so labels and buttons don't count.
// 60-70 is plain English, below 30 reads like an academic paper.
function fleschReadingEase(text) {
  const lines = text.split("\n").filter((l) => words(l).length >= 3);
  let sentences = 0;
  for (const l of lines) sentences += Math.max(1, (l.match(/[.!?]+(\s|$)/g) || []).length);
  const w = words(lines.join(" "));
  if (w.length < 30) return null;
  const syl = w.reduce((n, x) => n + syllables(x), 0);
  return 206.835 - 1.015 * (w.length / Math.max(1, sentences)) - 84.6 * (syl / w.length);
}

// Walks the tree in document order and records how many words of text precede each element.
function wordOffsets(root) {
  const offsets = new Map();
  let count = 0;
  (function walk(node) {
    if (node.nodeType === 3) {
      count += words(node.text).length;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag && /^(SCRIPT|STYLE|NOSCRIPT|SVG|TEMPLATE)$/.test(tag)) return;
    offsets.set(node, count);
    for (const child of node.childNodes) walk(child);
  })(root);
  return { offsets, total: count };
}

function jsonLdTypes(root) {
  const types = new Set();
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const visit = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(visit);
        if (o["@type"]) [].concat(o["@type"]).forEach((t) => types.add(String(t)));
        Object.values(o).forEach(visit);
      };
      visit(JSON.parse(s.text));
    } catch {
      /* malformed JSON-LD is common; ignore it */
    }
  }
  return [...types];
}

// Animated headlines often repeat their text in the markup ("Ship fasterShip fasterShip faster").
function collapseRepeats(text) {
  const compact = text.replace(/\s+/g, "");
  const m = compact.match(/^(.{8,}?)\1+$/s);
  if (!m) return text;
  // Cut the original after as many non-space characters as one copy has
  let seen = 0, i = 0;
  while (i < text.length && seen < m[1].length) if (!/\s/.test(text[i++])) seen++;
  return text.slice(0, i).trim();
}

function classifyCta(text) {
  for (const { intent, re } of CTA_INTENTS) if (re.test(text)) return intent;
  return null;
}

export function extractFacts(html, pageUrl) {
  const opts = { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } };
  const root = parse(html, opts);
  const url = new URL(pageUrl);

  // ---- Head / meta ----
  const meta = (sel) => clean(root.querySelector(sel)?.getAttribute("content"));
  const head = {
    title: clean(root.querySelector("title")?.text),
    metaDescription: meta('meta[name="description"]'),
    canonical: root.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
    ogTitle: meta('meta[property="og:title"]'),
    ogImage: meta('meta[property="og:image"]'),
    viewport: meta('meta[name="viewport"]'),
    noindex: /noindex/i.test(meta('meta[name="robots"]')),
    lang: root.querySelector("html")?.getAttribute("lang") || "",
  };
  const schemaTypes = jsonLdTypes(root);
  const scriptText = root.querySelectorAll("script").map((s) => (s.getAttribute("src") || "") + " " + s.text.slice(0, 20000)).join(" ");
  const formProviders = [...new Set((scriptText.match(FORM_PROVIDERS) || []).map((x) => x.toLowerCase()))];

  // Whole-page visible text (including header/footer) for site-wide trust marks like SOC 2
  const body = root.querySelector("body") || root;
  const bodyClone = parse(body.toString(), opts);
  bodyClone.querySelectorAll(NOISE_SELECTORS).forEach((n) => n.remove());
  const bodyText = textOf(bodyClone);

  // ---- Content scope: <main> minus site chrome, so global nav CTAs don't count as page CTAs ----
  const mainEl = root.querySelector("main") || root.querySelector('[role="main"]') || body;
  const scope = parse(mainEl.toString(), opts);
  scope.querySelectorAll(NOISE_SELECTORS).forEach((n) => n.remove());
  scope.querySelectorAll(CHROME_SELECTORS).forEach((n) => n.remove());
  const scopeText = textOf(scope);
  const wordList = words(scopeText);
  const { offsets } = wordOffsets(scope);

  // ---- Headings ----
  const h1s = root.querySelectorAll("h1").map((h) => collapseRepeats(clean(h.text))).filter(Boolean);
  const h2s = scope.querySelectorAll("h2").map((h) => clean(h.text)).filter(Boolean);
  const h3Count = scope.querySelectorAll("h3").length;
  const h1El = scope.querySelector("h1");
  const h1Offset = h1El ? offsets.get(h1El) ?? 0 : null;

  // Hero = the section that holds the H1 (or the first ~150 words when there is no section)
  const heroEl = h1El ? h1El.closest("section") || h1El.parentNode?.parentNode || null : null;
  const heroWords = heroEl ? words(textOf(heroEl)).length : 0;
  const heroLimit = heroEl && heroWords < 400 ? null : 150;
  const isInside = (el, ancestor) => {
    for (let n = el; n; n = n.parentNode) if (n === ancestor) return true;
    return false;
  };
  const inHero = (el) => (heroLimit === null ? isInside(el, heroEl) : (offsets.get(el) ?? 1e9) <= heroLimit);

  // Sub-headline: first paragraph after the H1 in the hero
  let subhead = "";
  if (heroEl) {
    const p = heroEl.querySelectorAll("p").map((x) => clean(x.text)).find((t) => words(t).length >= 6);
    subhead = p || "";
  }

  // ---- CTAs in page content ----
  const ctas = [];
  for (const el of scope.querySelectorAll('a, button, input[type="submit"], [role="button"]')) {
    const text = clean(el.text || el.getAttribute("value") || el.getAttribute("aria-label"));
    if (!text || text.length > 60) continue;
    const intent = classifyCta(text);
    if (!intent) continue;
    ctas.push({ text, intent, tag: el.tagName.toLowerCase(), href: el.getAttribute("href") || "", hero: inHero(el), wordOffset: offsets.get(el) ?? null });
  }
  // ---- Header CTA and whether the header stays on screen (sticky/fixed) ----
  const headerEl = root.querySelector("header") || root.querySelector('[role="banner"]');
  const headerCtas = headerEl
    ? headerEl
        .querySelectorAll('a, button, [role="button"]')
        .map((el) => clean(el.text))
        .filter((t) => t && t.length <= 40)
        .map((text) => ({ text, intent: classifyCta(text) }))
        .filter((c) => c.intent === "sales" || c.intent === "trial")
    : [];
  let headerSticky = false;
  if (headerEl) {
    const css = root.querySelectorAll("style").map((s) => s.text).join("\n");
    const stickyRe = /position\s*:\s*(sticky|fixed)/i;
    const inline = [headerEl, headerEl.parentNode].some((n) => n?.getAttribute && stickyRe.test(n.getAttribute("style") || ""));
    const classes = (headerEl.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const viaCss = classes.some((c) => new RegExp(`\\.${c.replace(/[^\w-]/g, "")}\\s*\\{[^}]*position\\s*:\\s*(sticky|fixed)`, "i").test(css));
    const viaUtility = classes.some((c) => /^(sticky|fixed)$/.test(c));
    headerSticky = inline || viaCss || viaUtility;
  }

  const ctaIntents = [...new Set(ctas.map((c) => c.intent))];
  const heroCtas = ctas.filter((c) => c.hero);
  const primaryIntent = (heroCtas[0] || ctas[0])?.intent || null;

  // ---- Links / exits ----
  const allLinks = root.querySelectorAll("a[href]").map((a) => a.getAttribute("href"));
  const isExternal = (h) => /^https?:\/\//i.test(h) && !h.includes(url.hostname.replace(/^www\./, ""));
  const scopeLinks = scope.querySelectorAll("a[href]").map((a) => a.getAttribute("href"));
  const navLinks = root.querySelectorAll("header a[href], nav a[href]").length;

  // ---- Forms ----
  // The lead form is the biggest form in the page content; footer newsletter boxes (one email
  // field) and header search boxes would otherwise make every page look frictionless.
  const fieldCount = (f) =>
    f.querySelectorAll("input, select, textarea").filter((i) => !/^(hidden|submit|button|image|reset|search)$/i.test(i.getAttribute("type") || "")).length;
  const forms = root.querySelectorAll("form").map((f) => ({ fields: fieldCount(f), inContent: false }));
  const contentForms = scope.querySelectorAll("form").map(fieldCount).filter((n) => n > 0);
  const visibleFormFields = contentForms.length ? Math.max(...contentForms) : null;

  // ---- Trust ----
  const analystMentions = [...new Set((bodyText.match(ANALYSTS) || []).map((x) => x))];
  // Compliance marks appear as text or as badge images (e.g. /images/security/GDPR.webp)
  const imgLabels = bodyClone.querySelectorAll("img, source").map((i) => `${i.getAttribute("alt") || ""} ${i.getAttribute("src") || i.getAttribute("srcset") || ""}`);
  const badgeText = imgLabels.join(" ").replace(/[_\-/.]/g, " ");
  const normCompliance = (x) => x.toUpperCase().replace(/\s+/g, "").replace("SOC2", "SOC 2").replace(/^ISO/, "ISO ");
  const compliance = [...new Set([...(bodyText.match(COMPLIANCE) || []), ...(badgeText.match(COMPLIANCE) || [])].map(normCompliance))];
  const scopeImgs = scope.querySelectorAll("img");
  const logoImgs = scopeImgs.filter((i) => /logo/i.test((i.getAttribute("alt") || "") + " " + (i.getAttribute("src") || "")));
  // A "logo wall": a block with many images and very little text (common for customer logos)
  let logoWallImages = 0;
  for (const block of scope.querySelectorAll("section, ul, div")) {
    const imgs = block.querySelectorAll("img").length;
    if (imgs >= 6 && words(textOf(block)).length < imgs * 4) logoWallImages = Math.max(logoWallImages, imgs);
  }
  const blockquotes = scope.querySelectorAll("blockquote, q, figure blockquote").length;
  const quotedSentences = (scopeText.match(/[“"][^”"]{40,400}[”"]/g) || []).length;
  // Testimonials: first-person customer paragraphs that sit next to a person photo / testimonial asset
  const personImg = /testimonial|avatar|headshot|customer|speaker/i;
  let testimonialBlocks = 0;
  for (const p of scope.querySelectorAll("p")) {
    const t = clean(p.text);
    if (words(t).length < 20 || (t.match(/\b(we|our|us|i|my)\b/gi) || []).length < 2) continue;
    let block = p.parentNode;
    for (let i = 0; i < 3 && block; i++, block = block.parentNode) {
      const media = block.querySelectorAll("img, source").some((m) => personImg.test(`${m.getAttribute("src") || ""} ${m.getAttribute("srcset") || ""} ${m.getAttribute("alt") || ""}`));
      if (media) {
        testimonialBlocks++;
        break;
      }
    }
  }
  const stats = [...new Set((scopeText.match(STAT_RE) || []).map(clean))];
  const caseStudyMentions = (scopeText.match(/\bcase stud(y|ies)\b|\bcustomer stor(y|ies)\b/gi) || []).length;

  // ---- Content structure ----
  const lists = scope.querySelectorAll("ul, ol").filter((l) => l.querySelectorAll("li").length >= 2).length;
  const paragraphs = scope.querySelectorAll("p").map((p) => words(p.text).length).filter((n) => n >= 8);
  const avgParagraphWords = paragraphs.length ? paragraphs.reduce((a, b) => a + b, 0) / paragraphs.length : 0;

  // ---- Media ----
  const videos =
    scope.querySelectorAll("video").length +
    (html.match(/youtube\.com\/embed|player\.vimeo|wistia|vidyard|loom\.com\/embed/gi) || []).length;
  const imgsWithAlt = scopeImgs.filter((i) => clean(i.getAttribute("alt")).length > 0).length;

  // ---- Pricing / self-serve markers ----
  const priceMentions = (scopeText.match(/\$\s?\d+(\.\d+)?\s?(\/|per)\s?(mo|month|user|seat|year)/gi) || []).length;
  const hasPricingLink = allLinks.some((h) => /\/pricing\b/i.test(h || ""));
  const freeMarkers = (scopeText.match(/\bfree (trial|plan|forever)\b|\bno credit card\b|\bcancel anytime\b/gi) || []).length;

  // ---- Learning / event markers ----
  const eventMarkers = (scopeText.match(/\bwebinar\b|\bspeakers?\b|\bon[- ]demand\b|\blive session\b|\bpanel\b|\bwhat you('|’)ll (learn|walk away with)\b/gi) || []).length;
  const articleMarkers = (scopeText.match(/\bmin(ute)?s? read\b|\bpublished\b|\bwritten by\b|\btable of contents\b|\bauthor\b/gi) || []).length;
  const durationMatch = scopeText.match(/\b(\d{1,3})\s?(mins?|minutes)\b/i);
  // Gated content: the main content CTA ("Watch now", "Download") is a script button rather than a
  // link, and there is no player/file on the page, so the content almost certainly sits behind a form.
  const mainContentCta = ctas.find((c) => c.intent === "content" && c.hero) || ctas.find((c) => c.intent === "content");
  const gateLikely = !!mainContentCta && !videos && (!mainContentCta.href || mainContentCta.href.startsWith("#")) && !/\.pdf($|\?)/i.test(mainContentCta.href);

  return {
    url: pageUrl,
    path: url.pathname,
    head,
    schemaTypes,
    formProviders,
    headings: { h1s, h1: h1s[0] || "", h1Words: words(h1s[0] || "").length, h2s, h2Count: h2s.length, h3Count, h1Offset },
    hero: { found: !!heroEl, words: heroWords, subhead },
    ctas,
    header: { ctas: headerCtas, sticky: headerSticky },
    ctaSummary: {
      total: ctas.length,
      hero: heroCtas.length,
      intents: ctaIntents,
      primaryIntent,
      primaryText: (heroCtas[0] || ctas[0])?.text || "",
      firstCtaWordOffset: ctas.length ? Math.min(...ctas.map((c) => c.wordOffset ?? 1e9)) : null,
    },
    links: {
      total: allLinks.length,
      inContent: scopeLinks.length,
      nav: navLinks,
      external: allLinks.filter((h) => isExternal(h || "")).length,
    },
    forms: { count: forms.length, visibleFormFields: visibleFormFields === 99 ? null : visibleFormFields, providers: formProviders },
    trust: {
      analystMentions,
      compliance,
      logoImages: logoImgs.length,
      logoWallImages,
      blockquotes,
      quotedSentences,
      testimonialBlocks,
      stats: stats.slice(0, 25),
      statCount: stats.length,
      caseStudyMentions,
    },
    content: {
      wordCount: wordList.length,
      readingEase: fleschReadingEase(scopeText),
      lists,
      avgParagraphWords: Math.round(avgParagraphWords),
      headingsPer300Words: wordList.length ? ((h2s.length + h3Count) / wordList.length) * 300 : 0,
    },
    media: { videos, images: scopeImgs.length, imgsWithAlt, altCoverage: scopeImgs.length ? imgsWithAlt / scopeImgs.length : null },
    selfServe: { priceMentions, hasPricingLink, freeMarkers },
    learning: { eventMarkers, articleMarkers, durationMinutes: durationMatch ? Number(durationMatch[1]) : null, gateLikely, mainContentCta: mainContentCta?.text || null },
    textSample: scopeText.slice(0, 600),
    text: scopeText, // full content text; stripped from API responses
  };
}
