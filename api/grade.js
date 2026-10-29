// Vercel Function: same response as /api/grade in src/worker.js.
import { gradeUrl } from "../src/grade.js";

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  try {
    const result = await gradeUrl(q.get("url"), {
      psiKey: process.env.PSI_API_KEY,
      rubric: q.get("rubric") || undefined,
      audience: q.get("audience") || undefined,
    });
    // Vercel's CDN caches identical requests for 10 minutes (stands in for caches.default);
    // fresh=1 changes the URL, so it bypasses the cached copy
    return Response.json(result, { headers: { "cache-control": "public, s-maxage=600" } });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 400 });
  }
}
