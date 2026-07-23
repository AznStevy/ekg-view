/**
 * Download short WFDB windows for curated PhysioNet ECG records into public/wfdb/.
 * Used by GitHub Pages deploys so the browser never needs CORS access to physionet.org.
 *
 * Usage: node scripts/mirror-physio.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const curatedPath = path.join(root, "src", "physioCurated.json");
const outRoot = path.join(root, "public", "wfdb");
const ORIGIN = "https://physionet.org";
const DURATION_SEC = 12;
const CONCURRENCY = 6;

/** @typedef {{ slug: string, version: string, records: string[] }} Db */

/**
 * @param {string} text
 */
function parseHeaMeta(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("empty header");
  const head = lines[0].split(/\s+/);
  const nSig = Number(head[1]);
  const freq = parseFloat(head[2] ?? "250") || 250;
  const nSamples = parseInt(head[3] ?? "0", 10) || 0;
  const sigLine = (lines[1] ?? "").split(/\s+/);
  const fileName = sigLine[0] || `${head[0]}.dat`;
  const format = Number(sigLine[1] ?? 16);
  return { headLine: lines[0], nSig, freq, nSamples, fileName, format, signalLines: lines.slice(1, 1 + nSig) };
}

/**
 * @param {number} format
 * @param {number} nSig
 * @param {number} nSamples
 */
function bytesFor(format, nSig, nSamples) {
  if (format === 212) return Math.ceil(nSamples * nSig * 1.5);
  if (format === 16) return nSamples * nSig * 2;
  throw new Error(`unsupported format ${format}`);
}

/**
 * @param {string} url
 * @param {number} [maxBytes]
 */
async function fetchBytes(url, maxBytes) {
  const headers = maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : undefined;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`${res.status} ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return maxBytes && buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, i: number) => Promise<void>} worker
 */
async function mapPool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {{ slug: string, version: string }} db
 * @param {string} record
 */
async function mirrorRecord(db, record) {
  const heaUrl = `${ORIGIN}/files/${db.slug}/${db.version}/${record}.hea`;
  const heaRes = await fetch(heaUrl);
  if (!heaRes.ok) throw new Error(`hea ${heaRes.status}`);
  const heaText = await heaRes.text();
  if (heaText.includes("<html") || heaText.includes("<!DOCTYPE")) {
    throw new Error("HTML instead of header");
  }
  const meta = parseHeaMeta(heaText);
  if (meta.format !== 212 && meta.format !== 16) {
    throw new Error(`skip format ${meta.format}`);
  }
  const samplesWanted = Math.max(64, Math.floor(meta.freq * DURATION_SEC));
  const nSamples =
    meta.nSamples > 0 ? Math.min(meta.nSamples, samplesWanted) : samplesWanted;
  const byteCount = bytesFor(meta.format, meta.nSig, nSamples);
  const datUrl = `${ORIGIN}/files/${db.slug}/${db.version}/${meta.fileName}`;
  const datBuf = await fetchBytes(datUrl, byteCount);

  // Rewrite header sample count + keep signal lines; point file at local dat name
  const headParts = meta.headLine.split(/\s+/);
  headParts[3] = String(nSamples);
  const localDat = meta.fileName.includes("/")
    ? path.basename(meta.fileName)
    : meta.fileName;
  const signalLines = meta.signalLines.map((line) => {
    const parts = line.split(/\s+/);
    parts[0] = localDat;
    return parts.join(" ");
  });
  const outHea = [headParts.join(" "), ...signalLines, ""].join("\n");

  const dir = path.join(outRoot, db.slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record}.hea`), outHea, "utf8");
  await fs.writeFile(path.join(dir, localDat), datBuf);
}

async function main() {
  /** @type {Db[]} */
  const dbs = JSON.parse(await fs.readFile(curatedPath, "utf8"));
  await fs.rm(outRoot, { recursive: true, force: true });
  await fs.mkdir(outRoot, { recursive: true });

  /** @type {{ slug: string, version: string, record: string }[]} */
  const jobs = [];
  for (const db of dbs) {
    for (const record of db.records) {
      jobs.push({ slug: db.slug, version: db.version, record });
    }
  }

  let ok = 0;
  let fail = 0;
  const errors = [];
  await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      await mirrorRecord(job, job.record);
      ok++;
      if (ok % 20 === 0) console.log(`mirrored ${ok}/${jobs.length}…`);
    } catch (err) {
      fail++;
      errors.push(`${job.slug}/${job.record}: ${err instanceof Error ? err.message : err}`);
    }
  });

  console.log(`PhysioNet mirror done: ${ok} ok, ${fail} failed → ${outRoot}`);
  if (errors.length) {
    console.warn(errors.slice(0, 12).join("\n"));
    if (errors.length > 12) console.warn(`…and ${errors.length - 12} more`);
  }
  if (ok === 0) {
    process.exitCode = 1;
    console.error("No records mirrored — aborting");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
