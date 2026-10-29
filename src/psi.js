// Google PageSpeed Insights (Lighthouse, mobile). Returns null-safe metrics plus the reason
// when PSI is unavailable, so the rubric can drop performance signals instead of faking them.
//
// One Lighthouse lab run swings 10+ points between runs, so several run in parallel. The
// top-level lab fields are the first successful run (what rubric v1 was written against);
// `median` holds the median across runs and `runs` each run's numbers, for v2 and the UI.

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const PSI_RUNS = 3;

const LAB_KEYS = ["performance", "lcpMs", "cls", "tbtMs", "fcpMs", "speedIndexMs"];

async function runOnce(url, { apiKey, timeoutMs }) {
  const qs = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (apiKey) qs.set("key", apiKey);
  const started = Date.now();
  try {
    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const reason =
        res.status === 429
          ? "PageSpeed Insights quota exceeded" + (apiKey ? "" : " (no API key configured)")
          : `PageSpeed Insights returned HTTP ${res.status}`;
      return { ok: false, reason };
    }
    const json = await res.json();
    const lh = json.lighthouseResult;
    const audit = (id) => lh?.audits?.[id]?.numericValue ?? null;
    // Real-user (CrUX) data for this exact URL, when Google has enough traffic for it.
    // Origin-level data is ignored on purpose: it is the same for every page on the site.
    const field = json.loadingExperience?.id && !json.loadingExperience.origin_fallback ? json.loadingExperience : null;
    const fieldCls = field?.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
    return {
      ok: true,
      ms: Date.now() - started,
      fetchTime: lh?.fetchTime ?? null,
      performance: lh?.categories?.performance?.score ?? null, // 0..1
      lcpMs: audit("largest-contentful-paint"),
      cls: audit("cumulative-layout-shift"),
      tbtMs: audit("total-blocking-time"),
      fcpMs: audit("first-contentful-paint"),
      speedIndexMs: audit("speed-index"),
      fieldLcpMs: field?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      fieldCls: fieldCls == null ? null : fieldCls / 100, // CrUX reports CLS x100
      fieldCategory: field?.overall_category ?? null,
    };
  } catch (err) {
    return { ok: false, reason: err.name === "TimeoutError" ? "PageSpeed Insights timed out" : String(err.message || err) };
  }
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export async function runPageSpeed(url, { apiKey, timeoutMs = 60000, runs = PSI_RUNS } = {}) {
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: runs }, () => runOnce(url, { apiKey, timeoutMs })));
  const ok = results.filter((r) => r.ok);
  if (!ok.length) return results[0];
  const first = ok[0];
  return {
    ...first,
    ms: Date.now() - started,
    median: Object.fromEntries(LAB_KEYS.map((k) => [k, median(ok.map((r) => r[k]))])),
    runs: ok.map((r) => Object.fromEntries(["fetchTime", ...LAB_KEYS].map((k) => [k, r[k]]))),
    runsRequested: runs,
  };
}
