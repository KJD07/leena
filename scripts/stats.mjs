// Small, dependency-free statistics helpers for the validation report.

export function ranks(values, { descending = true } = {}) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  const out = new Array(values.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// Spearman's rho = Pearson correlation of the ranks (handles ties)
export const spearman = (x, y) => pearson(ranks(x), ranks(y));

// Kendall's tau-b
export function kendall(x, y) {
  let c = 0, d = 0, tx = 0, ty = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) {
      const a = Math.sign(x[i] - x[j]), b = Math.sign(y[i] - y[j]);
      if (a === 0 && b === 0) continue;
      if (a === 0) tx++;
      else if (b === 0) ty++;
      else if (a === b) c++;
      else d++;
    }
  const denom = Math.sqrt((c + d + tx) * (c + d + ty));
  return denom ? (c - d) / denom : 0;
}

// Wilson score interval for a binomial proportion (95%)
export function wilson(successes, n, z = 1.96) {
  const p = successes / n;
  const denom = 1 + z ** 2 / n;
  const centre = (p + z ** 2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / denom;
  return [Math.max(0, centre - half), centre + half];
}

// Two-proportion z-test, two-sided p-value
export function twoProportionP(x1, n1, x2, n2) {
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  return 2 * (1 - normCdf(z));
}

function normCdf(z) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// Deterministic PRNG so the sensitivity analysis is reproducible
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
