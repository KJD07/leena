// Google PageSpeed Insights (Lighthouse, mobile). Returns null-safe metrics plus the reason
// when PSI is unavailable, so the rubric can drop performance signals instead of faking them.

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export async function runPageSpeed(url, { apiKey, timeoutMs = 60000 } = {}) {
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
    return {
      ok: true,
      ms: Date.now() - started,
      performance: lh?.categories?.performance?.score ?? null, // 0..1
      lcpMs: audit("largest-contentful-paint"),
      cls: audit("cumulative-layout-shift"),
      tbtMs: audit("total-blocking-time"),
      fcpMs: audit("first-contentful-paint"),
      speedIndexMs: audit("speed-index"),
      // Real-user (CrUX) data when Google has enough traffic for this URL
      fieldLcpMs: json.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      fieldCategory: json.loadingExperience?.overall_category ?? null,
    };
  } catch (err) {
    return { ok: false, reason: err.name === "TimeoutError" ? "PageSpeed Insights timed out" : String(err.message || err) };
  }
}
