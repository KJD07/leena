// Cloudflare Worker: serves the UI at / and the grader API at /api/grade.
import UI from "./ui.html";
import { gradeUrl } from "./grade.js";
import { RUBRICS, CATEGORIES } from "./rubric.js";
import { AUDIENCES } from "./audience.js";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (url.pathname === "/api/meta") {
      return json({ rubrics: Object.values(RUBRICS).map((r) => ({ id: r.id, name: r.name })), audiences: AUDIENCES, categories: CATEGORIES, psiConfigured: !!env.PSI_API_KEY });
    }

    if (url.pathname === "/api/grade") {
      const target = url.searchParams.get("url");
      const rubric = url.searchParams.get("rubric") || undefined;
      const audience = url.searchParams.get("audience") || undefined;
      const fresh = url.searchParams.get("fresh") === "1";

      // Cache identical requests for 10 minutes: PageSpeed is slow and quota-limited
      const cache = caches.default;
      const cacheKey = new Request(`https://cache.grader/${encodeURIComponent(target || "")}|${rubric || ""}|${audience || ""}`);
      if (!fresh) {
        const hit = await cache.match(cacheKey);
        if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), "x-cache": "HIT" } });
      }
      try {
        const result = await gradeUrl(target, { psiKey: env.PSI_API_KEY, rubric, audience });
        const res = json(result, 200, { "cache-control": "public, max-age=600" });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (err) {
        return json({ error: err.message || String(err) }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
