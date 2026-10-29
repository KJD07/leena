# Landing Page Grader

Paste any URL and get a scored teardown of the page: a 0–100 score, the audience the page is built for, and every signal with the evidence behind it.

- **Live**: every run fetches and parses the real page, and pulls Lighthouse data from Google PageSpeed Insights. No mock data.
- **Traceable**: 22 signals, each a pure function of the HTML or PageSpeed. No LLM is involved in scoring. Signals that can't be measured are marked *n/a* and dropped, not guessed.
- **Audience-aware**: detects *enterprise buyer*, *self-serve user* or *learner* from evidence on the page, and changes what "good" means for each.
- **Checked against reality**: `npm run validate` grades a dataset of pages with every rubric version and compares the ranking with real conversion (Spearman, Kendall, pairwise agreement with significance testing, traffic-mix sensitivity).

## How it works

```
URL ──► fetchPage ──► extractFacts ──► detectAudience ──► scorePage(rubric) ──► JSON / UI
   └──► PageSpeed Insights (parallel) ─────────────────────────┘
```

| File | Role |
|---|---|
| `src/fetchPage.js` | URL normalisation, private-address blocking, fetch with timeout and size cap |
| `src/extract.js` | HTML → facts: headings, hero, CTAs (with intent), sticky header, forms, logos, testimonials, compliance badges, stats, readability, gating |
| `src/psi.js` | PageSpeed Insights (mobile): performance score, LCP, CLS, TBT, FCP, field data |
| `src/audience.js` | Evidence-based audience detection with per-point explanations |
| `src/rubric.js` | Signal library plus rubric **v1** (first draft, kept unchanged) and **v2** (after validation) |
| `src/grade.js` | Orchestration |
| `src/worker.js`, `src/ui.html` | Cloudflare Worker: API and single-page UI |
| `scripts/validate.mjs` | Ranks the grader against real conversion data |

### Audience weighting

Each audience multiplies signal weights and changes targets. For example, compliance marks are ×3 for an enterprise buyer (security review is a purchase gate) and ×0.2 for a learner (irrelevant to reading a post). The lead-form field tolerance is 7 for enterprise and 3 for self-serve. v2 blends the profiles by detection confidence, so a mixed page is judged by mixed standards instead of flipping at a label boundary. The UI shows the detected audience, the evidence for it, and what the page would score for each audience.

## Run it

```bash
npm install
npm run dev           # http://localhost:8787
```

PageSpeed needs an API key (the keyless quota is shared and usually exhausted). Create one at Google Cloud Console → APIs & Services → Credentials, enable *PageSpeed Insights API*, then:

```bash
echo "PSI_API_KEY=your-key" > .dev.vars     # local
npx wrangler secret put PSI_API_KEY         # production
```

### API

`GET /api/grade?url=<page>&rubric=v1|v2&audience=enterprise|self_serve|learner&fresh=1`

Returns the score, the category breakdown, every signal with its evidence, the audience detection, PageSpeed metrics and the raw extracted facts. Results are cached for 10 minutes.

## Deploy (Cloudflare Workers)

```bash
npx wrangler login
npx wrangler secret put PSI_API_KEY
npm run deploy
```

## Deploy (Vercel)

`api/meta.js` and `api/grade.js` wrap the same grader as Vercel Functions; `vercel.json` copies `src/ui.html` to `public/index.html` at build time. Vercel's CDN (`s-maxage=600`) stands in for the Worker's 10-minute cache.

1. Import the repo at vercel.com → Add New → Project (framework preset: *Other*).
2. Settings → Environment Variables: add `PSI_API_KEY` for Production and Preview, then redeploy.
3. Check `https://<app>.vercel.app/api/meta` returns `"psiConfigured": true`.

Or with the CLI: `vercel env add PSI_API_KEY production && vercel --prod`.

## Validate against conversion data

The dataset is confidential, so it is not in this repo (`data/` and `reports/` are gitignored).

```bash
npm run import-data -- "path/to/Website Data - Summary.xlsx"
PSI_API_KEY=your-key npm run validate     # writes reports/validation.md
```

## Known limits

- Forms and content that render only after JavaScript runs aren't visible in static HTML. The grader infers gating (a script button with no player or file on the page) but can't count those fields. Cloudflare Browser Rendering would close this gap.
- The grader can't see where traffic comes from, so it rates the page, not the campaign.
- Thresholds were set from CRO practice, not fitted. Three pages can't calibrate 22 signals.
