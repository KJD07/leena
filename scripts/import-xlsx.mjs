// Converts Leena's "Website Data - Summary.xlsx" into data/pages.json.
// Usage: npm run import-data -- "path/to/Website Data - Summary.xlsx"
// The output is gitignored because the data is confidential.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import XLSX from "xlsx";

const src = process.argv[2];
if (!src) {
  console.error('Usage: npm run import-data -- "path/to/Website Data - Summary.xlsx"');
  process.exit(1);
}

const wb = XLSX.read(readFileSync(src));
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });

// Traffic split arrives as one multi-line cell: "Direct: 44%\nOrganic Search: 25%..."
function parseSplit(cell) {
  const split = {};
  for (const line of String(cell || "").split(/\n|;/)) {
    const m = line.match(/^\s*([^:]+):\s*([\d.]+)\s*%/);
    if (m) split[m[1].trim().toLowerCase().replace(/\s+/g, "_")] = Number(m[2]) / 100;
  }
  return split;
}

const pages = rows
  .filter((r) => r["Page URL"])
  .map((r) => {
    const sessions = Number(r["Sessions"]);
    // The brief calls it "Form Submits", the sheet calls it "Form fills"
    const formFills = Number(r["Form fills"] ?? r["Form Submits"] ?? r["Form submits"]);
    return {
      url: String(r["Page URL"]).trim(),
      pageType: r["Page type"],
      traffic: parseSplit(r["Traffic source split"]),
      sessions,
      formFills,
      cvr: formFills / sessions,
    };
  });

mkdirSync("data", { recursive: true });
writeFileSync("data/pages.json", JSON.stringify(pages, null, 2));
console.log(`Wrote ${pages.length} pages to data/pages.json`);
