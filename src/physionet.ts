import { createUploadedFromLeads, type UploadedEkg } from "./ekgUpload";
import type { LeadId } from "./ekgWaveforms";
import physioCurated from "./physioCurated.json";

/**
 * Dev: Vite `/physionet` proxy (see vite.config.ts) — live PhysioNet, no CORS.
 * Prod (GitHub Pages): same-origin static mirror under `wfdb/` (see scripts/mirror-physio.mjs).
 */
function assetBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

function mirrorUrl(database: string, fileName: string): string {
  return `${assetBase()}wfdb/${database}/${fileName}`;
}

function proxyUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `/physionet${p}`;
}

/** Prefer live proxy in dev; static mirror on GitHub Pages (no CORS). */
async function fetchPhysioFile(
  database: string,
  version: string,
  fileName: string,
): Promise<Response> {
  const urls = import.meta.env.DEV
    ? [proxyUrl(`/files/${database}/${version}/${fileName}`), mirrorUrl(database, fileName)]
    : [mirrorUrl(database, fileName)];
  let lastStatus = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastStatus = res.status;
    } catch {
      /* try next */
    }
  }
  const where = import.meta.env.DEV
    ? "dev proxy"
    : "static mirror (deploy runs npm run mirror:physio)";
  throw new Error(
    lastStatus === 404
      ? `Record file ${database}/${fileName} not found (${where})`
      : `Could not fetch ${database}/${fileName} (${lastStatus || "network"}). ${where}`,
  );
}

export type PhysioProjectHit = {
  slug: string;
  version: string;
  title: string;
  shortDescription: string;
  accessPolicy: string;
  sourceUrl: string;
  topics: string[];
  open: boolean;
};

export type PhysioRecordRef = {
  database: string;
  version: string;
  record: string;
  label: string;
  detail: string;
};

type CuratedDb = {
  slug: string;
  version: string;
  title: string;
  detail: string;
  topics: string[];
  records: string[];
};

/** Open-access ECG databases commonly used for teaching (PhysioNet). */
export const CURATED_ECG_DBS: CuratedDb[] = physioCurated as CuratedDb[];

const SIG_TO_LEAD: Record<string, LeadId> = {
  mlii: "II",
  "ml ii": "II",
  "ml-ii": "II",
  ii: "II",
  i: "I",
  iii: "III",
  avr: "aVR",
  avl: "aVL",
  avf: "aVF",
  v1: "V1",
  v2: "V2",
  v3: "V3",
  v4: "V4",
  v5: "V5",
  v6: "V6",
  ecg: "II",
  ecg1: "II",
  ecg2: "V1",
  "lead ii": "II",
  "lead i": "I",
  "lead v1": "V1",
  "lead v5": "V5",
};

function mapSigName(name: string, index: number, used: Set<LeadId>): LeadId {
  const key = name.trim().toLowerCase();
  const mapped = SIG_TO_LEAD[key] ?? SIG_TO_LEAD[key.replace(/\s+/g, " ")];
  const fallback: LeadId[] = ["II", "V1", "I", "V5", "III", "aVF", "V2", "V3", "V4", "V6", "aVL", "aVR"];
  let lead = mapped ?? fallback[index] ?? "II";
  // Duplicate names (e.g. both channels "ECG") → assign distinct leads by index
  if (used.has(lead)) {
    lead = fallback.find((l) => !used.has(l)) ?? lead;
  }
  used.add(lead);
  return lead;
}

function parseHea(text: string): HeaInfo {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("Empty WFDB header");
  const head = lines[0]!.split(/\s+/);
  const recordName = head[0]!.replace(/\/.*$/, "");
  const nSig = Number(head[1]);
  // freq may be "360" or "250/0.004"
  const freq = parseFloat(head[2] ?? "250") || 250;
  const nSamples = parseInt(head[3] ?? "0", 10) || 0;
  const signals: HeaSignal[] = [];
  for (let i = 0; i < nSig; i++) {
    const parts = lines[1 + i]?.split(/\s+/) ?? [];
    const fileName = parts[0] ?? `${recordName}.dat`;
    const format = Number(parts[1] ?? 16);
    const gainTok = parts[2] ?? "200";
    let gain = parseFloat(gainTok.split("/")[0] ?? "200");
    // WFDB: gain 0 means unspecified — default 200 adc units / mV
    if (!Number.isFinite(gain) || gain === 0) gain = 200;
    const adcZero = Number(parts[4] ?? 0) || 0;
    const description = parts.slice(8).join(" ") || `ch${i}`;
    signals.push({ fileName, format, gain, adcZero, description });
  }
  return { recordName, nSig, freq, nSamples, signals };
}

/**
 * Decode MIT format 212 (12-bit samples, 1.5 bytes each).
 * Per WFDB signal(5): each pair of samples is packed as a little-endian byte
 * pair + one following byte — first sample = 12 LSBs of the pair; second =
 * remaining 4 bits of the pair (MSBs) + the following byte (LSBs).
 * Multiplexed: for 2 channels each triple is (ch0[t], ch1[t]); for 1 channel
 * each triple is (x[t], x[t+1]).
 */
function decodeFormat212(
  buf: ArrayBuffer,
  nSig: number,
  nSamplesPerSig: number,
): Int16Array[] {
  const bytes = new Uint8Array(buf);
  const sign12 = (v: number) => (v >= 2048 ? v - 4096 : v);

  if (nSig === 1) {
    const maxSamples = Math.floor((bytes.length * 2) / 3);
    const n = Math.min(nSamplesPerSig, maxSamples);
    const ch = new Int16Array(n);
    let i = 0;
    for (let bi = 0; bi + 2 < bytes.length && i < n; bi += 3) {
      const word = bytes[bi]! | (bytes[bi + 1]! << 8);
      ch[i++] = sign12(word & 0x0fff);
      if (i < n) ch[i++] = sign12(bytes[bi + 2]! | ((word >> 12) << 8));
    }
    return [ch];
  }

  if (nSig !== 2) {
    throw new Error(`Format 212 with ${nSig} signals is not supported yet`);
  }

  const maxPairs = Math.floor(bytes.length / 3);
  const n = Math.min(nSamplesPerSig, maxPairs);
  const ch0 = new Int16Array(n);
  const ch1 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const b0 = bytes[i * 3]!;
    const b1 = bytes[i * 3 + 1]!;
    const b2 = bytes[i * 3 + 2]!;
    const word = b0 | (b1 << 8);
    ch0[i] = sign12(word & 0x0fff);
    ch1[i] = sign12(b2 | ((word >> 12) << 8));
  }
  return [ch0, ch1];
}

export async function searchPhysioNetProjects(query: string): Promise<PhysioProjectHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // Live API only via Vite proxy (no CORS on physionet.org). Curated search works offline.
  if (!import.meta.env.DEV) return [];
  const url = proxyUrl(
    `/api/v1/project/published/search/?search_term=${encodeURIComponent(q)}&resource_type=database`,
  );
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PhysioNet search failed (${res.status})`);
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data
    .map((row) => {
      const access = String(row.access_policy ?? "");
      const topics = Array.isArray(row.topics) ? row.topics.map(String) : [];
      const blob = `${row.title} ${row.short_description} ${topics.join(" ")}`.toLowerCase();
      const ecgish = /ecg|ekg|arrhythmia|holter|electrocardi/.test(blob);
      if (!ecgish) return null;
      return {
        slug: String(row.slug ?? ""),
        version: String(row.version ?? "1.0.0"),
        title: String(row.title ?? row.slug ?? ""),
        shortDescription: String(row.short_description ?? ""),
        accessPolicy: access,
        sourceUrl: String(row.source_url ?? `https://physionet.org/content/${row.slug}/${row.version}/`),
        topics,
        open: /open/i.test(access),
      } satisfies PhysioProjectHit;
    })
    .filter((x): x is PhysioProjectHit => !!x && !!x.slug)
    .slice(0, 12);
}

/** Local curated search — works without network; prefers open ECG teaching sets. */
export function searchCuratedRecords(query: string): PhysioRecordRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/[\s,/]+/).filter(Boolean);
  const out: PhysioRecordRef[] = [];

  for (const db of CURATED_ECG_DBS) {
    const dbHay = `${db.slug} ${db.title} ${db.detail} ${db.topics.join(" ")}`.toLowerCase();
    const lookingAtDb = tokens.every((t) => dbHay.includes(t) || !/\d/.test(t));

    for (const record of db.records) {
      const idHay = `${db.slug}/${record} ${record}`.toLowerCase();
      const matchRecord = tokens.some((t) => idHay.includes(t) && (/\d/.test(t) || t === db.slug));
      const matchTopic =
        lookingAtDb &&
        tokens.every((t) => dbHay.includes(t) || record.includes(t)) &&
        tokens.some((t) => dbHay.includes(t));

      if (!matchRecord && !matchTopic) continue;
      // Topic-only queries: cap samples per database
      if (!matchRecord && out.filter((r) => r.database === db.slug).length >= 8) continue;

      out.push({
        database: db.slug,
        version: db.version,
        record,
        label: `${db.slug}/${record}`,
        detail: db.title,
      });
      if (out.length >= 36) return out;
    }
  }
  return out;
}

export function curatedDbMatches(query: string): CuratedDb[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return CURATED_ECG_DBS.filter((db) => {
    const hay = `${db.slug} ${db.title} ${db.detail} ${db.topics.join(" ")}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
}

type HeaSignal = {
  fileName: string;
  format: number;
  gain: number;
  adcZero: number;
  description: string;
};

type HeaInfo = {
  recordName: string;
  nSig: number;
  freq: number;
  nSamples: number;
  signals: HeaSignal[];
};

function decodeFormat16(buf: ArrayBuffer, nSig: number, nSamplesPerSig: number): Int16Array[] {
  const view = new DataView(buf);
  const maxSamples = Math.floor(buf.byteLength / (2 * nSig));
  const n = Math.min(nSamplesPerSig, maxSamples);
  const channels: Int16Array[] = Array.from({ length: nSig }, () => new Int16Array(n));
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < nSig; s++) {
      channels[s]![i] = view.getInt16((i * nSig + s) * 2, true);
    }
  }
  return channels;
}

/**
 * Load an open PhysioNet WFDB record and convert to UploadedEkg.
 * Downloads a short window (default 12 s) for teaching playback.
 * Production uses the static `wfdb/` mirror; local `npm run dev` uses the Vite proxy.
 */
export async function loadPhysioNetRecord(opts: {
  database: string;
  version?: string;
  record: string;
  durationSec?: number;
}): Promise<UploadedEkg> {
  const version = opts.version ?? "1.0.0";
  const durationSec = opts.durationSec ?? 12;
  const heaRes = await fetchPhysioFile(opts.database, version, `${opts.record}.hea`);
  const heaText = await heaRes.text();
  if (heaText.includes("<!DOCTYPE") || heaText.includes("<html")) {
    throw new Error("Got HTML instead of a WFDB header — check PhysioNet proxy / mirror");
  }
  const hea = parseHea(heaText);
  const samplesWanted = Math.max(64, Math.floor(hea.freq * durationSec));
  const nSamples = hea.nSamples > 0 ? Math.min(hea.nSamples, samplesWanted) : samplesWanted;

  const formats = new Set(hea.signals.map((s) => s.format));
  if (formats.size !== 1) throw new Error("Mixed WFDB formats in one record are not supported yet");
  const format = hea.signals[0]!.format;
  const datName = hea.signals[0]!.fileName;
  const datRes = await fetchPhysioFile(opts.database, version, datName);
  const buf = await datRes.arrayBuffer();
  // Reject HTML error pages mistaken for binary
  if (buf.byteLength < 64) throw new Error("Signal file too small — check PhysioNet proxy / mirror");
  const headBytes = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  const asText = String.fromCharCode(...headBytes);
  if (asText.startsWith("<!") || asText.startsWith("<html") || asText.startsWith("{")) {
    throw new Error("Got a web page instead of WFDB data — check PhysioNet proxy / mirror");
  }

  let rawChannels: Int16Array[];
  if (format === 212) {
    rawChannels = decodeFormat212(buf, hea.nSig, nSamples);
  } else if (format === 16) {
    rawChannels = decodeFormat16(buf, hea.nSig, nSamples);
  } else {
    throw new Error(`WFDB format ${format} not supported yet (use 16 or 212)`);
  }

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  const leadLabels: Partial<Record<LeadId, string>> = {};
  const used = new Set<LeadId>();
  for (let s = 0; s < hea.nSig; s++) {
    const meta = hea.signals[s]!;
    const raw = rawChannels[s]!;
    const lead = mapSigName(meta.description, s, used);
    const out = new Float32Array(raw.length);
    const gain = meta.gain || 200;
    for (let i = 0; i < raw.length; i++) {
      out[i] = (raw[i]! - meta.adcZero) / gain;
    }
    leadSignals[lead] = out;
    leadLabels[lead] = meta.description || lead;
  }

  return createUploadedFromLeads({
    name: `PhysioNet ${opts.database}/${opts.record}`,
    leadSignals,
    leadLabels,
    sampleRateHz: hea.freq,
    sourceKind: "text",
  });
}

export function physioNetRecordPageUrl(database: string, version: string, record: string): string {
  return `https://physionet.org/content/${database}/${version}/${record}.hea`;
}
