// Vercel Function: same response as /api/meta in src/worker.js.
import { RUBRICS, CATEGORIES } from "../src/rubric.js";
import { AUDIENCES } from "../src/audience.js";

export function GET() {
  return Response.json({
    rubrics: Object.values(RUBRICS).map((r) => ({ id: r.id, name: r.name })),
    audiences: AUDIENCES,
    categories: CATEGORIES,
    psiConfigured: !!process.env.PSI_API_KEY,
  });
}
