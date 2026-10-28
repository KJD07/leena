// Fetches the live HTML of a page. Runs in the Worker and in Node (validation script).

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 LandingPageGrader/1.0";
const MAX_BYTES = 4 * 1024 * 1024;

export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Please enter a URL.");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs can be graded.");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host.startsWith("[")
  ) {
    throw new Error("Private and local addresses can't be graded.");
  }
  url.hash = "";
  return url.toString();
}

export async function fetchPage(url, { timeoutMs = 20000 } = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
  if (!/html/i.test(type)) throw new Error(`Expected an HTML page but got "${type || "unknown"}".`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error("The page is larger than 4 MB, which is too big to grade.");
  return {
    finalUrl: res.url || url,
    status: res.status,
    html: new TextDecoder().decode(buf),
    bytes: buf.byteLength,
    fetchMs: Date.now() - started,
  };
}
