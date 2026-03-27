// -----------------------------
// CONFIG – SERPENTINE JARRAHDALE (via Cloudflare Worker Proxy)
// -----------------------------

const PROXY = "https://late-sun-f6f1.wade-performance.workers.dev/?url=";

// Karnet AWS (best for SJ)
const BOM_OBS_URL =
  PROXY + encodeURIComponent("https://www.bom.gov.au/fwo/IDW60801/IDW60801.94610.json");

// Lower West District Forecast (correct path)
const BOM_FORECAST_URL =
  PROXY + encodeURIComponent("https://www.bom.gov.au/feeds/districts/IDW12300.xml");

// WA State Warnings (correct modern feed)
const BOM_WARNINGS_URL =
  PROXY + encodeURIComponent("https://www.bom.gov.au/feeds/warnings/wa.xml");

// -----------------------------
// HELPERS
// -----------------------------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Very small XML helper using DOMParser
function parseXml(text) {
  return new window.DOMParser().parseFromString(text, "application/xml");
}

// -----------------------------
// BOM DATA LOADERS
// -----------------------------

async function loadObservations() {
  const data = await fetchJson(BOM_OBS_URL);
  const obs = data.observations.data[0];

  document.getElementById("temp").textContent = `${obs.air_temp} °C`;
  document.getElementById("feels").textContent = `${obs.apparent_t} °C`;
  document.getElementById("wind").textContent =
    `${obs.wind_dir || "-"} ${obs.wind_kmh || 0} km/h`;
  document.getElementById("gusts").textContent =
    obs.gust_kmh != null ? `${obs.gust_kmh} km/h` : "–";
  document.getElementById("rain").textContent =
    obs.rain_trace != null ? `${obs.rain_trace} mm` : "–";
  document.getElementById("site-name").textContent =
    obs.name || obs.station_name || "Local station";

  const timeStr = obs.local_date_time_full;
  if (timeStr && timeStr.length === 14) {
    const pretty = `${timeStr.slice(6, 8)}/${timeStr.slice(4, 6)}/${timeStr.slice(
      0,
      4
    )} ${timeStr.slice(8, 10)}:${timeStr.slice(10, 12)}`;
    document.getElementById("obs-time").textContent = pretty;
  } else {
    document.getElementById("obs-time").textContent = "Unknown";
  }

  return obs;
}

async function loadForecast() {
  const xmlText = await fetchText(BOM_FORECAST_URL);
  const xml = parseXml(xmlText);

  // This is intentionally simple – pick first area and first period
  const area = xml.querySelector("area[description]");
  const areaName = area ? area.getAttribute("description") : "Local district";
  document.getElementById("forecast-area").textContent = areaName;

  const firstPeriod = xml.querySelector("area forecast-period");
  let rainChance = null;
  let fireDanger = null;

  if (firstPeriod) {
    firstPeriod.querySelectorAll("element").forEach((el) => {
      const type = el.getAttribute("type");
      if (type === "probability_of_precipitation") {
        rainChance = el.textContent.trim();
      }
      if (type === "fire_danger") {
        fireDanger = el.textContent.trim();
      }
    });
  }

  document.getElementById("rain-chance").textContent =
    rainChance || "Not available";
  document.getElementById("fire-danger").textContent =
    fireDanger || "Not available";

  return { rainChance, fireDanger, areaName };
}

async function loadWarnings() {
  const xmlText = await fetchText(BOM_WARNINGS_URL);
  const xml = parseXml(xmlText);

  const items = Array.from(xml.querySelectorAll("item"));
  const listEl = document.getElementById("warnings-list");
  listEl.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "No current BOM warnings for WA.";
    listEl.appendChild(li);
    return [];
  }

  const titles = [];

  items.forEach((item) => {
    const title = item.querySelector("title")?.textContent || "Warning";
    titles.push(title);

    const li = document.createElement("li");
    li.textContent = title;
    listEl.appendChild(li);
  });

  return titles;
}

// -----------------------------
// SES MESSAGE LOGIC
// -----------------------------

function buildSesMessage(obs, forecast, warningTitles) {
  const msgEl = document.getElementById("ses-message");
  msgEl.classList.remove("severe", "warning", "info");

  const gust = Number(obs.gust_kmh || 0);
  const temp = Number(obs.air_temp || 0);
  const rainTrace = parseFloat(obs.rain_trace || "0") || 0;

  let rainChanceNum = null;
  if (forecast.rainChance) {
    const m = forecast.rainChance.match(/(\d+)/);
    if (m) rainChanceNum = Number(m[1]);
  }

  const fireDanger = (forecast.fireDanger || "").toLowerCase();
  const warningsText = warningTitles.join(" | ").toLowerCase();

  // Priority 1 – explicit severe BOM warnings
  if (
    warningsText.includes("severe weather") ||
    warningsText.includes("thunderstorm") ||
    warningsText.includes("flood") ||
    warningsText.includes("fire weather")
  ) {
    msgEl.textContent =
      "Severe weather or hazard warning is current. Follow official advice, secure loose items and avoid unnecessary travel.";
    msgEl.classList.add("severe");
    return;
  }

  // Priority 2 – very strong winds
  if (gust >= 80) {
    msgEl.textContent =
      "Damaging winds possible. Secure outdoor items, park vehicles away from trees and stay indoors where safe.";
    msgEl.classList.add("severe");
    return;
  }

  // Priority 3 – high fire danger
  if (
    fireDanger.includes("severe") ||
    fireDanger.includes("extreme") ||
    fireDanger.includes("catastrophic")
  ) {
    msgEl.textContent =
      "Elevated fire danger today. Review your bushfire plan, stay informed and be ready to act quickly.";
    msgEl.classList.add("warning");
    return;
  }

  // Priority 4 – heavy rain / local flooding risk
  if ((rainChanceNum && rainChanceNum >= 70) || rainTrace >= 20) {
    msgEl.textContent =
      "Heavy rain or local flooding possible. Check gutters and drains, avoid driving through floodwaters and monitor official updates.";
    msgEl.classList.add("warning");
    return;
  }

  // Priority 5 – heat
  if (temp >= 38) {
    msgEl.textContent =
      "Very hot conditions. Stay hydrated, keep cool and check on vulnerable neighbours, family and pets.";
    msgEl.classList.add("warning");
    return;
  }

  // Default – no major hazards
  msgEl.textContent =
    "No significant hazards expected at this time. Stay prepared, keep your emergency kit up to date and monitor official channels.";
  msgEl.classList.add("info");
}

// -----------------------------
// INIT
// -----------------------------

async function initDashboard() {
  try {
    const [obs, forecast, warnings] = await Promise.all([
      loadObservations(),
      loadForecast(),
      loadWarnings(),
    ]);
    buildSesMessage(obs, forecast, warnings);
  } catch (err) {
    console.error(err);
    const msgEl = document.getElementById("ses-message");
    msgEl.textContent =
      "Unable to load live weather data at the moment. Please check official BOM and Emergency WA websites.";
    msgEl.classList.add("warning");
  }
}

document.addEventListener("DOMContentLoaded", initDashboard);

// -----------------------------
// AUTO-REFRESH (every 10 minutes)
// -----------------------------
setInterval(() => {
  console.log("Auto-refreshing SES dashboard...");
  initDashboard();
}, 30 * 60 * 1000); // 30 minutes
