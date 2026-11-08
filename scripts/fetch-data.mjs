// Fetches BOM + Emergency WA data server-side and writes one small JSON file
// (live.json) that the dashboard reads from the same GitHub repo.
//
// Why server-side: BOM does not send CORS headers, so browsers can't call it
// directly. Running this from a scheduled GitHub Action removes the need for
// a proxy and means BOM is hit once every ~10 minutes, not once per screen.
//
// Usage:  node scripts/fetch-data.mjs --out out/live.json [--prev prev.json]
// Test:   FIXTURE_DIR=tests/fixtures node scripts/fetch-data.mjs --out out/live.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// CONFIG – edit these
// ---------------------------------------------------------------------------
const CONFIG = {
  // Centre of the Shire of Serpentine-Jarrahdale (approx.)
  home: { lat: -32.35, lon: 116.0 },
  // Emergency WA warnings within this distance are "local" / "nearby"
  localKm: 15,
  nearbyKm: 40,
  // Place names that mark a warning as local even if geometry is missing
  localities:
    /serpentine|jarrahdale|mundijong|byford|keysbrook|whitby|cardup|oakford|hopeland|darling downs|mardella|karrakup/i,

  // BOM observation station. 94609 = Jandakot Aero (half-hourly, has gusts).
  // Karnet is 95614 but it only reports 9am/3pm with no gusts.
  obsStation: "94609",
  // BOM blocks GitHub's servers on the website (HTTP 403), so use the anonymous
  // FTP service, which is BOM's own route for automated access.
  obsXmlUrl: "ftp://ftp.bom.gov.au/anon/gen/fwo/IDW60920.xml", // all WA stations

  // Perth city/town forecast XML and the area name to pick from it
  forecastUrl: "ftp://ftp.bom.gov.au/anon/gen/fwo/IDW12300.xml",
  forecastAreaMatch: /perth/i,

  // BOM WA warnings RSS. The old URL returned 403 from GitHub and was never
  // verified, so it's off. Emergency WA covers local hazards. Set a URL to re-enable.
  bomWarningsUrl: null,

  // Emergency WA public CAP-AU feed
  ewaUrl: "https://api.emergency.wa.gov.au/v1/capau",

  userAgent:
    process.env.FETCH_USER_AGENT ||
    "SJ-SES-Dashboard/1.0 (unofficial community information page; +https://github.com/jenevo308/sj-sesdashboard)",
  timeoutMs: 20000,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const FIXTURE_DIR = process.env.FIXTURE_DIR || null;
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x == null ? "" : typeof x === "object" ? String(x["#text"] ?? "") : String(x)).trim();

async function getText(url, fixtureName) {
  if (FIXTURE_DIR) return readFile(join(FIXTURE_DIR, fixtureName), "utf8");
  if (url.startsWith("ftp://")) {
    const { stdout } = await run(
      "curl", ["-sS", "--fail", "--max-time", "45", "--retry", "2", url],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout;
  }
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.userAgent, Accept: "*/*" },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function parsePoints(str) {
  return String(str || "")
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lat, lon]) => ({ lat, lon }));
}
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (
      a.lat > pt.lat !== b.lat > pt.lat &&
      pt.lon < ((b.lon - a.lon) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lon
    ) inside = !inside;
  }
  return inside;
}
function distanceToArea(area) {
  const poly = parsePoints(text(area.polygon));
  const circle = parsePoints(text(area.circle).split(" ")[0]); // "lat,lon radius"
  const pts = [...poly, ...circle];
  if (!pts.length) return null;
  if (poly.length >= 3 && pointInPolygon(CONFIG.home, poly)) return 0;
  return Math.min(...pts.map((p) => haversineKm(CONFIG.home, p)));
}

// ---------------------------------------------------------------------------
// Emergency WA (DFES) – CAP-AU
// ---------------------------------------------------------------------------
async function loadEmergencyWA() {
  const raw = await getText(CONFIG.ewaUrl, "capau.xml");
  const doc = xml.parse(raw);
  const objects = arr(doc?.EDXLDistribution?.contentObject);
  const alerts = objects
    .map((o) => o?.xmlContent?.embeddedXMLContent?.alert)
    .flatMap(arr)
    .filter(Boolean);

  const out = { local: [], nearby: [], totalStatewide: alerts.length };
  for (const alert of alerts) {
    for (const info of arr(alert.info)) {
      for (const area of arr(info.area)) {
        const params = Object.fromEntries(
          arr(info.parameter).map((p) => [text(p.valueName), text(p.value)])
        );
        const haystack = [info.headline, info.description, area.areaDesc].map(text).join(" ");
        const km = distanceToArea(area);
        const byName = CONFIG.localities.test(haystack);
        let tier = null;
        if (byName || (km != null && km <= CONFIG.localKm)) tier = "local";
        else if (km != null && km <= CONFIG.nearbyKm) tier = "nearby";
        if (!tier) continue;

        out[tier].push({
          id: text(alert.identifier),
          sent: text(alert.sent),
          headline: text(info.headline),
          event: text(info.event),
          alertLevel: text(area.alertLevel),
          severity: text(info.severity),
          urgency: text(info.urgency),
          description: text(info.description).replace(/\s+/g, " "),
          region: params.DFES_Region || "",
          agency: params.Agency_Responsible || "",
          distanceKm: km == null ? null : Math.round(km),
          url: text(info.web),
        });
      }
    }
  }
  const byDistance = (a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  out.local.sort(byDistance);
  out.nearby.sort(byDistance);
  return out;
}

// ---------------------------------------------------------------------------
// BOM observations – WA state XML (IDW60920), pick our station, newest period
// ---------------------------------------------------------------------------
async function loadObservations() {
  const doc = xml.parse(await getText(CONFIG.obsXmlUrl, "obs.xml"));
  const stations = arr(doc?.product?.observations?.station);
  const st = stations.find((x) => String(x["@_wmo-id"]) === CONFIG.obsStation);
  if (!st) throw new Error(`Station ${CONFIG.obsStation} not in WA observations XML`);

  const periods = arr(st.period).sort((a, b) =>
    String(b["@_time-utc"] || "").localeCompare(String(a["@_time-utc"] || ""))
  );
  const period = periods[0];
  if (!period) throw new Error("No observation period for station");

  const e = {};
  for (const level of arr(period.level)) {
    for (const el of arr(level.element)) e[el["@_type"]] = text(el);
  }
  const n = (v) => (v == null || v === "" || v === "-" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const local = String(period["@_time-local"] || "").slice(0, 19).replace(/\D/g, ""); // YYYYMMDDHHMMSS

  return {
    station: st["@_stn-name"] || `Station ${CONFIG.obsStation}`,
    localTime: local || null,
    temp: n(e.air_temperature),
    feels: n(e.apparent_temp),
    humidity: n(e["rel-humidity"] ?? e.rel_hum),
    windDir: e.wind_dir || null,
    windKmh: n(e.wind_spd_kmh),
    gustKmh: n(e.gust_kmh ?? e.wind_gust_spd),
    rainSince9am: n(e.rainfall),
    pressureHpa: n(e.msl_pres ?? e.pres),
  };
}

// ---------------------------------------------------------------------------
// BOM district forecast XML
// ---------------------------------------------------------------------------
async function loadForecast() {
  const doc = xml.parse(await getText(CONFIG.forecastUrl, "forecast.xml"));
  const areas = arr(doc?.product?.forecast?.area);
  if (!areas.length) throw new Error("No areas in forecast XML");
  const area =
    areas.find((a) => CONFIG.forecastAreaMatch.test(a["@_description"] || "")) ||
    areas.find((a) => a["@_type"] === "location") ||
    areas[0];

  const periods = arr(area["forecast-period"]).slice(0, 4).map((fp) => {
    const bag = {};
    for (const e of arr(fp.element)) bag[e["@_type"]] = text(e);
    for (const t of arr(fp.text)) bag[t["@_type"]] = text(t); // chance of rain lives in <text>
    return {
      start: fp["@_start-time-local"] || null,
      min: bag.air_temperature_minimum ?? null,
      max: bag.air_temperature_maximum ?? null,
      rainChance: bag.probability_of_precipitation ?? null,
      rainRange: bag.precipitation_range ?? null,
      precis: bag.precis ?? null,
      fireDanger: bag.fire_danger ?? null, // often absent for WA
    };
  });
  return { area: area["@_description"] || "", periods };
}

// ---------------------------------------------------------------------------
// BOM warnings RSS (WA)
// ---------------------------------------------------------------------------
async function loadBomWarnings() {
  if (!CONFIG.bomWarningsUrl) return [];
  const doc = xml.parse(await getText(CONFIG.bomWarningsUrl, "bom-warnings.xml"));
  return arr(doc?.rss?.channel?.item).map((i) => ({
    title: text(i.title),
    link: text(i.link),
    published: text(i.pubDate),
  }));
}

// ---------------------------------------------------------------------------
// main – each source fails independently; stale data is kept and flagged
// ---------------------------------------------------------------------------
async function main() {
  let prev = {};
  if (args.prev) {
    try { prev = JSON.parse(await readFile(args.prev, "utf8")); } catch { /* first run */ }
  }
  const now = new Date().toISOString();
  const result = { generatedAt: now, sources: {} };

  const jobs = {
    obs: loadObservations,
    forecast: loadForecast,
    bomWarnings: loadBomWarnings,
    emergencyWA: loadEmergencyWA,
  };
  for (const [key, fn] of Object.entries(jobs)) {
    try {
      result[key] = await fn();
      result.sources[key] = { ok: true, fetchedAt: now };
    } catch (err) {
      console.error(`[${key}] failed:`, err.message);
      result[key] = prev[key] ?? null;
      result.sources[key] = {
        ok: false,
        error: err.message,
        // keep the time of the last *good* fetch so the page can warn when stale
        fetchedAt: prev.sources?.[key]?.fetchedAt ?? null,
      };
    }
  }

  const out = args.out || "out/live.json";
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`Wrote ${out}`);
  console.log(
    Object.entries(result.sources).map(([k, v]) => `${k}: ${v.ok ? "ok" : "FAILED"}`).join("  ")
  );
  // Only fail the job if everything failed, so one broken feed doesn't stop the rest
  if (Object.values(result.sources).every((s) => !s.ok)) process.exit(1);
}

main();
