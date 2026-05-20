// =========================================
// GURNARD BEACH TIDE PREDICTION ENGINE
// =========================================
// Harmonic tidal prediction for Cowes, Isle of Wight
// Calibrated against known tidal data April 2026
// Reference: MHWS=4.2m, MLWS=0.8m, MHWN=3.5m, MLWN=1.8m

const TIDE = (() => {
  // Reference point: April 16 2026, 10:04 UTC (calibrated HW ~4.0m)
  // v5: REF_MS shifted -20min + S2 phase adjusted to -64° to fix spring-neap drift
  // Verified against 8 calibration points Apr 14–22 2026
  const REF_MS = Date.UTC(2026, 3, 16, 10, 4, 0);

  // Mean water level above Chart Datum
  const Z0 = 2.53;

  // Harmonic constituents: [speed °/hr, amplitude m, phase at ref °]
  // Calibrated to Cowes tidal characteristics with double high water
  const C = [
    [28.984104, 1.20, 0],       // M2 - principal lunar semidiurnal
    [30.000000, 0.40, -64],     // S2 - principal solar semidiurnal
    [28.439730, 0.22, 28],      // N2 - larger lunar elliptic
    [15.041069, 0.08, 140],     // K1 - luni-solar diurnal
    [13.943036, 0.07, 165],     // O1 - principal lunar diurnal
    [57.968208, 0.15, 180],     // M4 - shallow water (double HW)
    [58.984104, 0.06, 195],     // MS4 - shallow water compound
  ];

  const DEG2RAD = Math.PI / 180;

  function height(date) {
    const hrs = (date.getTime() - REF_MS) / 3600000;
    let h = Z0;
    for (const [spd, amp, pha] of C) {
      h += amp * Math.cos((spd * hrs + pha) * DEG2RAD);
    }
    return h;
  }

  // Derivative (m/hr) for rising/falling detection
  function rate(date) {
    const dt = 60000; // 1 minute in ms
    return (height(new Date(date.getTime() + dt)) - height(new Date(date.getTime() - dt))) / (2 * dt / 3600000);
  }

  // Find next high/low tide from a given time
  // Scans in 10-minute steps, then refines
  function findExtremes(fromDate, hoursAhead) {
    const extremes = [];
    const step = 10 * 60000; // 10 minutes
    const end = fromDate.getTime() + hoursAhead * 3600000;
    let prevRate = rate(fromDate);

    for (let t = fromDate.getTime() + step; t < end; t += step) {
      const d = new Date(t);
      const r = rate(d);
      if ((prevRate > 0 && r <= 0) || (prevRate < 0 && r >= 0)) {
        // Refine with bisection
        let lo = t - step, hi = t;
        for (let i = 0; i < 15; i++) {
          const mid = (lo + hi) / 2;
          const mr = rate(new Date(mid));
          if ((prevRate > 0 && mr > 0) || (prevRate < 0 && mr < 0)) lo = mid;
          else hi = mid;
        }
        const refT = new Date((lo + hi) / 2);
        extremes.push({
          time: refT,
          height: height(refT),
          type: prevRate > 0 ? 'high' : 'low'
        });
      }
      prevRate = r;
    }
    return extremes;
  }

  return { height, rate, findExtremes };
})();


// =========================================
// UI
// =========================================
const CORE = window.BeachCore;
const FALLBACK_CONFIG = {
  defaultBeachId: 'gurnard',
  beaches: [{
    id: 'gurnard',
    name: 'Gurnard Beach',
    shortName: 'Gurnard',
    subtitle: 'West of the Sailing Club towards Gurnard Luck',
    stationId: '0060',
    stationName: 'Cowes',
    coordinates: { latitude: 50.764, longitude: -1.321 },
    thresholds: { high: 3.8, inlet: 2.15, low: 1.55 },
    copy: {
      ratingLabel: 'Beach Walkability',
      nextWalkTitle: 'Next Great Walk',
      disclaimer: 'Not for navigation. Always check conditions on arrival.',
    },
  }],
};

let currentBeach = CORE.normalizeBeachConfig(FALLBACK_CONFIG);
let RATING = CORE.createRatingModel(currentBeach.thresholds);
let currentViewDate = null; // null = live/now mode
let liveTimer = null;

// =========================================
// ADMIRALTY API INTEGRATION
// =========================================
let apiTideEvents = null; // null = not yet loaded or failed
let tideFetchError = null;

const EDGE_FN_URL = 'https://gsucaxeqzluzbmvonsmj.supabase.co/functions/v1/tide-proxy';
const CACHE_TTL = 3600000; // 1 hour
const BEACH_CONFIG_URL = 'beaches.json';

function selectedBeachId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('beach') || null;
}

async function loadBeachConfig() {
  try {
    const resp = await fetch(BEACH_CONFIG_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch (e) {
    return FALLBACK_CONFIG;
  }
}

function applyBeachConfig(beach) {
  currentBeach = beach;
  RATING = CORE.createRatingModel(beach.thresholds);

  document.title = beach.name + ' Walk';
  document.getElementById('beachTitle').textContent = beach.name;
  document.getElementById('beachSubtitle').textContent = beach.subtitle || '';
  document.querySelector('.rating-label').textContent = beach.copy.ratingLabel || 'Beach Walkability';
  document.querySelector('.next-walk-card h3').textContent = beach.copy.nextWalkTitle || 'Next Great Walk';
  document.getElementById('dataDisclaimer').textContent =
    `Tidal data from UK Admiralty API (${beach.stationName}, station ${beach.stationId}) where available; harmonic model as fallback.`;
  document.getElementById('safetyDisclaimer').textContent =
    beach.copy.disclaimer || 'Not for navigation. Always check conditions on arrival.';
}

function tideCacheKey() {
  return `beach_tide_cache_${currentBeach.id}_${currentBeach.stationId}`;
}

function setDataStatus(kind, message) {
  const el = document.getElementById('dataStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `data-status ${kind}`;
  el.style.display = 'block';
}

function updateDataStatus(hasLiveDataForTime) {
  if (hasLiveDataForTime) {
    setDataStatus('live', `Live tide data from ${currentBeach.stationName} station ${currentBeach.stationId}.`);
    return;
  }
  if (apiTideEvents && apiTideEvents.length > 0) {
    setDataStatus('estimate', 'Using backup tide estimate for this time because live events are outside the loaded range.');
    return;
  }
  if (tideFetchError) {
    setDataStatus('error', `Using backup tide estimate. Live tide data failed to load: ${tideFetchError}.`);
    return;
  }
  setDataStatus('estimate', 'Using backup tide estimate while live tide data loads.');
}

async function fetchTideEvents() {
  try {
    const cached = JSON.parse(localStorage.getItem(tideCacheKey()) || 'null');
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
      return { events: cached.events, fromCache: true };
    }
  } catch (e) {}
  try {
    const params = new URLSearchParams({
      days: '3',
      station: currentBeach.stationId,
    });
    const resp = await fetch(EDGE_FN_URL + '?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const events = await resp.json();
    if (!Array.isArray(events)) throw new Error('Unexpected response');
    localStorage.setItem(tideCacheKey(), JSON.stringify({ ts: Date.now(), events }));
    tideFetchError = null;
    return { events, fromCache: false };
  } catch (e) {
    tideFetchError = e && e.message ? e.message : 'unknown error';
    return { events: null, error: tideFetchError };
  }
}

function parseEventMs(dt) {
  return CORE.parseEventMs(dt);
}

function apiHeight(date) {
  return CORE.apiHeight(apiTideEvents, date);
}

function tideHeight(date) {
  const h = apiHeight(date);
  return h !== null ? h : TIDE.height(date);
}

function tideRate(date) {
  const dt = 60000;
  return (tideHeight(new Date(date.getTime() + dt)) - tideHeight(new Date(date.getTime() - dt))) / (2 * dt / 3600000);
}

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) return 'Today';
  if (isTomorrow) return 'Tomorrow';
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatCountdown(fromDate, toDate) {
  const diff = toDate.getTime() - fromDate.getTime();
  if (diff < 0) return '';
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `in ${hrs}h ${mins}m`;
  return `in ${mins}m`;
}

function renderStars(rating) {
  const full = Math.floor(rating);
  const frac = rating - full;
  const hasHalf = frac >= 0.25;
  const empty = 5 - full - (hasHalf ? 1 : 0);
  let html = '';
  for (let i = 0; i < full; i++) {
    html += '<span class="star star-filled">★</span>';
  }
  if (hasHalf) {
    const pct = Math.round(frac * 100);
    html += `<span class="star star-half" style="color:var(--star-empty)">★<span style="position:absolute;left:0;top:0;overflow:hidden;width:${pct}%;color:var(--star-gold)">★</span></span>`;
  }
  for (let i = 0; i < empty; i++) {
    html += '<span class="star star-empty">★</span>';
  }
  return html;
}

function renderTideCurve(viewDate) {
  const container = document.getElementById('tideCurve');
  const dayStart = new Date(viewDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  const W = 388;
  const H = 90;
  const PAD_L = 30;
  const PAD_R = 10;
  const PAD_T = 8;
  const PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // Sample tide heights every 15 min
  const points = [];
  let minH = 99, maxH = -99;
  for (let t = dayStart.getTime(); t <= dayEnd.getTime(); t += 900000) {
    const h = tideHeight(new Date(t));
    points.push({ t, h });
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }

  // Add margin to range
  minH = Math.max(0, minH - 0.3);
  maxH = maxH + 0.3;

  function x(t) {
    return PAD_L + ((t - dayStart.getTime()) / (dayEnd.getTime() - dayStart.getTime())) * plotW;
  }
  function y(h) {
    return PAD_T + plotH - ((h - minH) / (maxH - minH)) * plotH;
  }

  // Build path
  const pathD = points.map((p, i) =>
    (i === 0 ? 'M' : 'L') + x(p.t).toFixed(1) + ',' + y(p.h).toFixed(1)
  ).join(' ');

  // Fill area
  const fillD = pathD + ` L${x(points[points.length - 1].t).toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${x(points[0].t).toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`;

  // Current time marker
  const nowT = viewDate.getTime();
  const nowInDay = nowT >= dayStart.getTime() && nowT <= dayEnd.getTime();
  const nowH = tideHeight(viewDate);

  // Rating color zones (background)
  const zones = [
    { from: 0, to: LOW_CUTOFF(), color: 'rgba(72,184,159,0.12)' },  // 5 star zone
    { from: HIGH_CUTOFF(), to: 6, color: 'rgba(232,115,90,0.12)' },  // 0 star zone
  ];

  // Time labels
  const timeLabels = [0, 6, 12, 18, 24].map(hr => {
    const t = new Date(dayStart);
    t.setHours(hr, 0, 0, 0);
    return { x: x(t.getTime()), label: hr.toString().padStart(2, '0') + ':00' };
  });

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;

  // Grid lines
  svg += `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" stroke="#e0e8ee" stroke-width="0.5"/>`;
  for (const tl of timeLabels) {
    svg += `<line x1="${tl.x}" y1="${PAD_T}" x2="${tl.x}" y2="${PAD_T + plotH}" stroke="#e8eef2" stroke-width="0.5"/>`;
    svg += `<text x="${tl.x}" y="${H - 2}" text-anchor="middle" fill="#8a9aaa" font-size="8" font-family="inherit">${tl.label}</text>`;
  }

  // Height labels
  const hStep = maxH - minH > 3 ? 1 : 0.5;
  for (let h = Math.ceil(minH / hStep) * hStep; h <= maxH; h += hStep) {
    const yy = y(h);
    svg += `<line x1="${PAD_L}" y1="${yy}" x2="${PAD_L + plotW}" y2="${yy}" stroke="#eef2f5" stroke-width="0.5"/>`;
    svg += `<text x="${PAD_L - 4}" y="${yy + 3}" text-anchor="end" fill="#a0aab4" font-size="7" font-family="inherit">${h.toFixed(1)}</text>`;
  }

  // Fill
  svg += `<path d="${fillD}" fill="url(#tideFill)" opacity="0.6"/>`;

  // Gradient def
  svg += `<defs><linearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#2e86ab" stop-opacity="0.4"/>
    <stop offset="100%" stop-color="#2e86ab" stop-opacity="0.05"/>
  </linearGradient></defs>`;

  // Line
  svg += `<path d="${pathD}" fill="none" stroke="#2e86ab" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Now marker
  if (nowInDay) {
    const nx = x(nowT);
    const ny = y(nowH);
    svg += `<line x1="${nx}" y1="${PAD_T}" x2="${nx}" y2="${PAD_T + plotH}" stroke="#e8735a" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>`;
    svg += `<circle cx="${nx}" cy="${ny}" r="4" fill="#e8735a" stroke="white" stroke-width="1.5"/>`;
  }

  svg += '</svg>';
  container.innerHTML = svg;
}

function LOW_CUTOFF() { return RATING.thresholds.low; }
function HIGH_CUTOFF() { return RATING.thresholds.high; }

function update(date) {
  // tideHeight/tideRate are API-first wrappers (Admiralty real data, falling back
  // to the harmonic model if the proxy is unavailable). RATING.stars takes both
  // h AND r so the rising-tide penalty (added in commit fe14cb9) kicks in correctly.
  const h = tideHeight(date);
  const r = tideRate(date);

  const liveHeight = apiHeight(date);

  // Show "~ est." badge when we're on the harmonic-model fallback
  const badge = document.getElementById('dataBadge');
  if (badge) badge.style.display = liveHeight !== null ? 'none' : 'inline';
  updateDataStatus(liveHeight !== null);

  const s = RATING.stars(h, r);
  const v = RATING.verdict(s, r > 0.05);

  // Rating
  document.getElementById('starsDisplay').innerHTML = renderStars(s);
  document.getElementById('ratingNumber').textContent = s.toFixed(1) + ' / 5';
  document.getElementById('ratingVerdict').textContent = v.text;
  document.getElementById('ratingDesc').textContent = v.desc;

  // Gradient bar color based on rating
  const card = document.getElementById('ratingCard');
  if (s >= 4) card.style.setProperty('--bar', '#48b89f');
  else if (s >= 2.5) card.style.setProperty('--bar', '#f5a623');
  else card.style.setProperty('--bar', '#e8735a');

  // Tide height
  document.getElementById('tideHeightVal').textContent = h.toFixed(1);

  // Rising/falling
  const arrow = r > 0.05 ? '↑' : r < -0.05 ? '↓' : '→';
  const stateText = r > 0.05 ? 'Rising' : r < -0.05 ? 'Falling' : 'Slack';
  const arrowColor = r > 0.05 ? '#e8735a' : r < -0.05 ? '#48b89f' : '#8a9aaa';
  document.getElementById('tideArrow').textContent = arrow;
  document.getElementById('tideArrow').style.color = arrowColor;
  document.getElementById('tideStateText').textContent = stateText;

  // Find next extremes from live Admiralty events when available. Fall back to
  // the harmonic model only when live events are not loaded or not in range.
  const extremes = TIDE.findExtremes(date, 14);
  const nextLow = CORE.nextApiEvent(apiTideEvents, date, 'low') || extremes.find(e => e.type === 'low');
  const nextHigh = CORE.nextApiEvent(apiTideEvents, date, 'high') || extremes.find(e => e.type === 'high');

  if (nextLow) {
    document.getElementById('nextLowLabel').textContent = formatDate(nextLow.time) === 'Today' ? 'Next Low Tide' : 'Low Tide ' + formatDate(nextLow.time);
    document.getElementById('nextLowTime').textContent = formatTime(nextLow.time);
    document.getElementById('nextLowHeight').textContent = nextLow.height.toFixed(1) + 'm';
    document.getElementById('nextLowCountdown').textContent = formatCountdown(date, nextLow.time);
  }

  if (nextHigh) {
    document.getElementById('nextHighLabel').textContent = formatDate(nextHigh.time) === 'Today' ? 'Next High Tide' : 'High Tide ' + formatDate(nextHigh.time);
    document.getElementById('nextHighTime').textContent = formatTime(nextHigh.time);
    document.getElementById('nextHighHeight').textContent = nextHigh.height.toFixed(1) + 'm';
    document.getElementById('nextHighCountdown').textContent = formatCountdown(date, nextHigh.time);
  }

  // Tide curve
  renderTideCurve(date);

  // Next great walk window (3.0 falling → 3.5 rising) + rain overlay
  renderWalkWindow(date);

  // Viewing label
  const label = document.getElementById('viewingLabel');
  if (currentViewDate) {
    const d = currentViewDate;
    label.innerHTML = 'Showing: <strong>' + formatDate(d) + ' at ' + formatTime(d) + '</strong>';
    label.style.display = 'block';
  } else {
    label.innerHTML = 'Live — updates every minute';
    label.style.display = 'block';
  }
}

// =========================================
// WALK WINDOW + RAIN OVERLAY
// =========================================
// findWalkWindow scans forward from `fromDate` and returns the next continuous
// "go" band, or null if no window in the next 24h. Thresholds chosen with
// Hamish from real walk experience (16 May 2026):
//   ENTRY = 3.0 stars on a FALLING tide (inlet just opens, beach growing)
//   EXIT  = 3.5 stars on a RISING tide (asymmetric — rising-tide-stuck is the
//           dangerous edge so we exit earlier than we entered)
// If we're already inside a window now, returns it with currentlyInside: true
// and start = fromDate.
function findWalkWindow(fromDate, maxHoursAhead) {
  return CORE.findWalkWindow(fromDate, maxHoursAhead, tideHeight, tideRate, RATING);
}

// fetchRainForecast pulls 15-minute precipitation from OpenMeteo (free, no key).
// Forecasts are cached per beach for 30 minutes so
// we don't hit the API on every render. Returns array of {time: ms, mm: number}
// or null on failure (caller is expected to fail gracefully — no rain strip
// shown, the walk window display still works).
const RAIN_CACHE_TTL = 30 * 60000;

function rainCacheKey() {
  return `beach_rain_cache_${currentBeach.id}`;
}

async function fetchRainForecast() {
  try {
    const cached = JSON.parse(localStorage.getItem(rainCacheKey()) || 'null');
    if (cached && (Date.now() - cached.ts) < RAIN_CACHE_TTL) return cached.slots;
  } catch (e) {}
  try {
    const { latitude, longitude } = currentBeach.coordinates;
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
      '&minutely_15=precipitation&forecast_days=2&timezone=auto';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data.minutely_15 || !Array.isArray(data.minutely_15.time)) {
      throw new Error('Unexpected response shape');
    }
    const times = data.minutely_15.time;
    const precip = data.minutely_15.precipitation;
    const slots = times.map((t, i) => ({ time: new Date(t).getTime(), mm: precip[i] || 0 }));
    localStorage.setItem(rainCacheKey(), JSON.stringify({ ts: Date.now(), slots }));
    return slots;
  } catch (e) {
    return null;
  }
}

// Met Office-ish thresholds, translated to mm-per-15-minute.
function bucketRain(mm) {
  if (mm === 0)    return 'clear';
  if (mm < 0.25)   return 'light';   // <1 mm/hr
  if (mm < 0.75)   return 'rain';    // ~1-3 mm/hr
  return 'heavy';                    // >3 mm/hr
}

// Find the longest contiguous run of clear/light slots inside the window and
// surface it as a "best sub-window" label.
function findBestRainBand(slots) {
  if (!slots || slots.length === 0) return null;
  const scores = slots.map(s => (s.bucket === 'clear' || s.bucket === 'light') ? 1 : 0);
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] === 1) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return null; // require at least 30 min of decent weather
  if (bestLen === slots.length) return { whole: true };
  return {
    whole: false,
    start: new Date(slots[bestStart].time),
    end: new Date(slots[bestStart + bestLen - 1].time + 15 * 60000)
  };
}

function renderRainStrip(window, rainSlots) {
  const wrap = document.getElementById('rainStripWrap');
  const strip = document.getElementById('rainStrip');
  const times = document.getElementById('rainStripTimes');
  const bestEl = document.getElementById('rainBestBand');

  if (!wrap || !strip || !rainSlots || !window) {
    if (wrap) wrap.style.display = 'none';
    return;
  }

  const inWindow = rainSlots
    .filter(s => s.time >= window.start.getTime() && s.time < window.end.getTime())
    .map(s => ({ ...s, bucket: bucketRain(s.mm) }));

  if (inWindow.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  strip.innerHTML = inWindow.map(s => {
    const t = new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return '<div class="rain-block ' + s.bucket + '" title="' + t + ' — ' + s.bucket + ' (' + s.mm.toFixed(2) + 'mm)"></div>';
  }).join('');

  // Start/end time labels on the strip
  const fmt = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  times.innerHTML = '<span>' + fmt(inWindow[0].time) + '</span><span>' + fmt(inWindow[inWindow.length - 1].time + 15 * 60000) + '</span>';

  // Best-sub-window label
  const best = findBestRainBand(inWindow);
  if (best && best.whole) {
    bestEl.textContent = '✓ Whole window is clear or light';
  } else if (best) {
    bestEl.textContent = 'Best stretch: ' + fmt(best.start) + ' → ' + fmt(best.end);
  } else {
    bestEl.textContent = 'Wet throughout — pick your moment';
  }

  wrap.style.display = 'block';
}

// renderWalkWindow replaces the old findNextGreatWalk display. Shows the full
// "go" band (entry-to-exit) instead of just the single peak moment, and
// triggers an async rain overlay fetch.
function renderWalkWindow(fromDate) {
  const card = document.getElementById('nextWalkCard');
  const timeEl = document.getElementById('nextWalkTime');
  const detailEl = document.getElementById('nextWalkDetail');
  const starsEl = document.getElementById('nextWalkStars');
  const metaEl = document.getElementById('walkWindowMeta');
  const rainWrap = document.getElementById('rainStripWrap');

  const win = findWalkWindow(fromDate, 24);

  if (!win) {
    // No window in next 24h — look further (just for the headline message)
    timeEl.textContent = 'No walks in the next 24 hours';
    detailEl.textContent = 'Tide windows aren\'t lining up — check back tomorrow.';
    starsEl.textContent = '';
    if (metaEl) metaEl.textContent = '';
    if (rainWrap) rainWrap.style.display = 'none';
    card.style.display = 'block';
    return;
  }

  const startTime = formatTime(win.start);
  const endTime = formatTime(win.end);
  const peakTime = formatTime(win.peakTime);
  const startDate = formatDate(win.start);
  const durMin = (win.end.getTime() - win.start.getTime()) / 60000;
  const durStr = durMin < 60
    ? Math.round(durMin) + ' min'
    : (durMin / 60).toFixed(1) + ' hrs';

  if (win.currentlyInside) {
    timeEl.textContent = 'GO NOW';
    detailEl.textContent = 'Window ends at ' + endTime;
  } else {
    const dateLabel = startDate === 'Today' ? 'Today' : startDate;
    timeEl.textContent = dateLabel + ', ' + startTime + ' → ' + endTime;
    detailEl.textContent = 'Peak ' + win.peakStars.toFixed(1) + '★ at ' + peakTime;
  }

  starsEl.textContent = '★'.repeat(Math.round(win.peakStars)) + ' (' + win.peakStars.toFixed(1) + ')';
  if (metaEl) metaEl.textContent = 'Window length: ' + durStr;

  card.style.display = 'block';

  // Async fetch rain (cached 30 min) — render strip when ready, do nothing if it fails.
  fetchRainForecast().then(slots => {
    if (slots) renderRainStrip(win, slots);
  });
}

// === INIT ===
function startLive() {
  currentViewDate = null;
  update(new Date());
  clearInterval(liveTimer);
  liveTimer = setInterval(() => update(new Date()), 60000);
}

// Date picker
document.getElementById('btnCheck').addEventListener('click', () => {
  const val = document.getElementById('dateTimePicker').value;
  if (!val) return;
  const d = new Date(val);
  if (isNaN(d.getTime())) return;
  currentViewDate = d;
  clearInterval(liveTimer);
  update(d);
});

document.getElementById('btnNow').addEventListener('click', startLive);

function setDefaultPickerValue() {
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  document.getElementById('dateTimePicker').value =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function init() {
  setDataStatus('estimate', 'Loading live tide data...');
  const config = await loadBeachConfig();
  const beach = CORE.normalizeBeachConfig(config, selectedBeachId());
  applyBeachConfig(beach);
  setDefaultPickerValue();

  // Start immediately with the fallback model, then upgrade to real API data.
  startLive();
  const result = await fetchTideEvents();
  if (result.events && Array.isArray(result.events) && result.events.length > 0) {
    apiTideEvents = result.events;
    update(currentViewDate || new Date());
  } else {
    update(currentViewDate || new Date());
  }
}

init();
