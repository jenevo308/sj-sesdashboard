// -----------------------------
// SES DASHBOARD – live data
// Reads live.json, which a scheduled GitHub Action builds from BOM and
// Emergency WA (see scripts/fetch-data.mjs). No proxy needed.
// -----------------------------

const LIVE_URL =
  "https://raw.githubusercontent.com/jenevo308/sj-sesdashboard/data/live.json";

const REFRESH_MS = 5 * 60 * 1000;      // re-read live.json every 5 minutes
const DATA_STALE_MIN = 45;             // whole file older than this = warn
const OBS_STALE_MIN = 90;              // observation older than this = hide values

// -----------------------------
// HELPERS
// -----------------------------
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

const fmt = (v, unit = "") => (v == null || Number.isNaN(v) ? "–" : `${v}${unit}`);

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

// BOM local_date_time_full is YYYYMMDDHHMMSS in WA local time
function parseBomLocal(s) {
  if (!s || s.length < 12) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:00+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchLive() {
  const res = await fetch(`${LIVE_URL}?t=${Math.floor(Date.now() / 300000)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading live.json`);
  return res.json();
}

// -----------------------------
// RENDERERS
// -----------------------------
function renderObservations(live) {
  const o = live.obs;
  const obsTime = o ? parseBomLocal(o.localTime) : null;
  const ageMin = obsTime ? (Date.now() - obsTime.getTime()) / 60000 : Infinity;
  const usable = o && ageMin <= OBS_STALE_MIN;

  if (!usable) {
    ["temp", "feels", "wind", "gusts", "rain"].forEach((id) => setText(id, "–"));
    setText("site-name", o?.station || "Local station");
    setText("obs-time", o ? "Out of date" : "Unavailable");
    return null;
  }

  setText("temp", fmt(o.temp, " °C"));
  setText("feels", fmt(o.feels, " °C"));
  setText("wind", `${o.windDir || "-"} ${fmt(o.windKmh ?? 0, " km/h")}`);
  setText("gusts", o.gustKmh != null ? `${o.gustKmh} km/h` : "–");
  setText("rain", o.rainSince9am != null ? `${o.rainSince9am} mm` : "–");
  setText("site-name", o.station);
  setText(
    "obs-time",
    obsTime.toLocaleString("en-AU", {
      timeZone: "Australia/Perth",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    })
  );
  return o;
}

function renderForecast(live) {
  const f = live.forecast;
  const today = f?.periods?.[0] || {};
  // Period 0 can be missing the rain chance late in the day – fall back to the next one
  const rainChance = today.rainChance ?? f?.periods?.find((p) => p.rainChance)?.rainChance ?? null;
  const fireDanger = today.fireDanger ?? null;

  setText("forecast-area", f?.area || "Local district");
  setText("rain-chance", rainChance || "Not available");
  setText("fire-danger", fireDanger || "Not available");
  return { rainChance, fireDanger };
}

function levelClass(alertLevel = "", event = "") {
  const s = `${alertLevel} ${event}`.toLowerCase();
  if (/emergency warning|evacuate|watch and act/.test(s)) return "severe";
  if (/advice|smoke|monitor|closure|flood|storm|cyclone/.test(s)) return "warning";
  return "info";
}

function renderWarnings(live) {
  const listEl = document.getElementById("warnings-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const add = (txt) => {
    const li = document.createElement("li");
    li.textContent = txt;
    listEl.appendChild(li);
  };

  const local = live.emergencyWA?.local || [];
  const nearby = live.emergencyWA?.nearby || [];
  const bom = live.bomWarnings || [];

  local.forEach((w) => add(`Emergency WA (local): ${w.headline}`));
  bom.forEach((w) => add(`BOM: ${w.title}`));
  nearby.slice(0, 3).forEach((w) => add(`Nearby, ${w.distanceKm} km: ${w.headline}`));
  if (nearby.length > 3) add(`…and ${nearby.length - 3} more nearby. See emergency.wa.gov.au`);

  if (!listEl.children.length) {
    const ewaOk = live.sources?.emergencyWA?.ok;
    add(ewaOk ? "No current warnings for the local area." : "Warning feed unavailable – check emergency.wa.gov.au");
  }
}

// -----------------------------
// SES MESSAGE LOGIC
// -----------------------------
function buildSesMessage(live, obs, forecast) {
  const msgEl = document.getElementById("ses-message");
  if (!msgEl) return;
  msgEl.classList.remove("severe", "warning", "info");
  const set = (text, cls) => { msgEl.textContent = text; msgEl.classList.add(cls); };

  const local = live.emergencyWA?.local || [];
  const bomText = (live.bomWarnings || []).map((w) => w.title).join(" | ").toLowerCase();
  const gust = Number(obs?.gustKmh || 0);
  const temp = Number(obs?.temp || 0);
  const rainTrace = Number(obs?.rainSince9am || 0);
  const rainChanceNum = forecast.rainChance ? Number((forecast.rainChance.match(/(\d+)/) || [])[1]) : null;
  const fireDanger = (forecast.fireDanger || "").toLowerCase();

  // Priority 1 – Emergency WA warnings for our area
  const worst = local.find((w) => levelClass(w.alertLevel, w.event) === "severe") || local[0];
  if (worst) {
    const cls = levelClass(worst.alertLevel, worst.event);
    const more = local.length > 1 ? ` (+${local.length - 1} more)` : "";
    set(`${worst.alertLevel || "Warning"} for our area: ${worst.headline}${more}. Follow official advice at emergency.wa.gov.au.`, cls);
    return;
  }
  // Priority 2 – severe BOM warnings
  if (/severe weather|thunderstorm|flood|fire weather|cyclone/.test(bomText)) {
    set("A severe weather warning is current. Follow official advice, secure loose items and avoid unnecessary travel.", "severe");
    return;
  }
  // Priority 3 – very strong winds
  if (gust >= 80) {
    set("Damaging winds possible. Secure outdoor items, park vehicles away from trees and stay indoors where safe.", "severe");
    return;
  }
  // Priority 4 – fire danger
  if (/severe|extreme|catastrophic/.test(fireDanger)) {
    set("Elevated fire danger today. Review your bushfire plan, stay informed and be ready to act quickly.", "warning");
    return;
  }
  // Priority 5 – heavy rain
  if ((rainChanceNum && rainChanceNum >= 70) || rainTrace >= 20) {
    set("Heavy rain or local flooding possible. Check gutters and drains, avoid driving through floodwaters and monitor official updates.", "warning");
    return;
  }
  // Priority 6 – heat
  if (temp >= 38) {
    set("Very hot conditions. Stay hydrated, keep cool and check on vulnerable neighbours, family and pets.", "warning");
    return;
  }
  set("No significant hazards expected at this time. Stay prepared, keep your emergency kit up to date and monitor official channels.", "info");
}

// -----------------------------
// INIT
// -----------------------------
async function initDashboard() {
  try {
    const live = await fetchLive();
    const obs = renderObservations(live);
    const forecast = renderForecast(live);
    renderWarnings(live);
    buildSesMessage(live, obs, forecast);

    // If the data pipeline has stalled, say so rather than show old data as current
    if (minutesSince(live.generatedAt) > DATA_STALE_MIN) {
      const msgEl = document.getElementById("ses-message");
      if (msgEl) {
        msgEl.textContent +=
          " (Live data is delayed. Check emergency.wa.gov.au and bom.gov.au for current information.)";
      }
    }
  } catch (err) {
    console.error(err);
    const msgEl = document.getElementById("ses-message");
    if (msgEl) {
      msgEl.classList.remove("severe", "warning", "info");
      msgEl.textContent =
        "Unable to load live data at the moment. Please check official BOM and Emergency WA websites.";
      msgEl.classList.add("warning");
    }
  }
}

document.addEventListener("DOMContentLoaded", initDashboard);
setInterval(initDashboard, REFRESH_MS);

// -----------------------------
// QR CODES FOR TRAINING & RECRUITMENT (only where those elements exist)
// -----------------------------
const TRAINING_URL = "https://jenevo308.github.io/sj-sesdashboard/training-calendar.html";
const RECRUIT_URL = "https://jenevo308.github.io/sj-sesdashboard/recruitment.html";

const trainingLink = document.getElementById("training-link");
const recruitLink = document.getElementById("recruit-link");
if (trainingLink) trainingLink.href = TRAINING_URL;
if (recruitLink) recruitLink.href = RECRUIT_URL;

if (typeof QRious !== "undefined") {
  const trainingQr = document.getElementById("qr-training");
  const recruitQr = document.getElementById("qr-recruit");
  if (trainingQr && !trainingQr.dataset.drawn) new QRious({ element: trainingQr, value: TRAINING_URL, size: 160 });
  if (recruitQr && !recruitQr.dataset.drawn) new QRious({ element: recruitQr, value: RECRUIT_URL, size: 160 });
}
