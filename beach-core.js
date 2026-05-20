(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BeachCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_THRESHOLDS = {
    high: 3.8,
    inlet: 2.15,
    low: 1.55,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createRatingModel(thresholds) {
    const limits = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    const HIGH = Number(limits.high);
    const INLET = Number(limits.inlet);
    const LOW = Number(limits.low);

    function stars(height, rate) {
      if (height >= HIGH) return 0;
      if (height <= LOW) return 5;

      let score;
      if (height > INLET) {
        const x = (HIGH - height) / (HIGH - INLET);
        score = 2.5 * Math.pow(x, 0.6);
      } else {
        score = 3 + 2 * (INLET - height) / (INLET - LOW);
      }

      if (rate > 0 && score > 3.0) {
        const proximity = clamp((height - 1.0) / (INLET - 1.0), 0, 1);
        const penalty = 2.0 * Math.pow(proximity, 1.5);
        score = Math.max(3.0, score - penalty);
      }

      return score;
    }

    function verdict(score, isRising) {
      if (score === 0) {
        return {
          text: 'No Beach',
          desc: isRising ? 'Tide rising. No beach.' : 'Tide falling - beach will appear soon.',
        };
      }
      if (score < 3.0) {
        if (isRising) return { text: 'Beach Closing', desc: 'Not worth it - beach is shrinking.' };
        return { text: 'Short Beach Only', desc: 'Wait a bit - beach is opening up. Inlet still blocked.' };
      }
      if (score < 3.5) {
        if (isRising) {
          return {
            text: 'Inlet Closing Soon',
            desc: 'Short walk only - inlet closing soon. Stay this side of the headland.',
          };
        }
        return { text: 'Inlet Just Open', desc: 'Go walk! Inlet just passable. Beach opening up.' };
      }
      if (score < 4.5) {
        if (isRising) return { text: 'Great Walk - Tide Coming In', desc: 'Go walk! Good conditions now.' };
        return { text: 'Great Walk', desc: 'Go walk! Beach is opening up. Plenty of beach.' };
      }
      if (isRising) return { text: 'Perfect Walk!', desc: 'Go walk! Massive beach right now.' };
      return { text: 'Perfect Walk!', desc: 'Go walk! Massive beach. Walk as far as you like.' };
    }

    return { stars, verdict, thresholds: { high: HIGH, inlet: INLET, low: LOW } };
  }

  function parseEventMs(dateTime) {
    if (!dateTime) return NaN;
    return /[Zz]$|[+-]\d{2}:\d{2}$/.test(dateTime)
      ? new Date(dateTime).getTime()
      : new Date(dateTime + 'Z').getTime();
  }

  function eventKind(event) {
    const raw = String(event && event.EventType || '').toLowerCase();
    if (raw.includes('low')) return 'low';
    if (raw.includes('high')) return 'high';
    return raw;
  }

  function eventTime(event) {
    return new Date(parseEventMs(event.DateTime));
  }

  function eventHeight(event) {
    return Number(event.Height);
  }

  function apiHeight(events, date) {
    if (!Array.isArray(events) || events.length < 2) return null;
    const t = date.getTime();
    const sorted = [...events].sort((a, b) => parseEventMs(a.DateTime) - parseEventMs(b.DateTime));

    for (let i = 0; i < sorted.length - 1; i++) {
      const t0 = parseEventMs(sorted[i].DateTime);
      const t1 = parseEventMs(sorted[i + 1].DateTime);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) continue;
      if (t >= t0 && t <= t1) {
        const h0 = eventHeight(sorted[i]);
        const h1 = eventHeight(sorted[i + 1]);
        if (!Number.isFinite(h0) || !Number.isFinite(h1)) return null;
        const frac = (t - t0) / (t1 - t0);
        return (h0 + h1) / 2 + (h0 - h1) / 2 * Math.cos(Math.PI * frac);
      }
    }

    return null;
  }

  function nextApiEvent(events, fromDate, type) {
    if (!Array.isArray(events)) return null;
    const fromMs = fromDate.getTime();
    const matches = events
      .filter((event) => eventKind(event) === type && parseEventMs(event.DateTime) > fromMs)
      .sort((a, b) => parseEventMs(a.DateTime) - parseEventMs(b.DateTime));

    if (matches.length === 0) return null;
    const event = matches[0];
    return {
      type,
      time: eventTime(event),
      height: eventHeight(event),
      source: 'api',
    };
  }

  function findWalkWindow(fromDate, maxHoursAhead, tideHeight, tideRate, ratingModel) {
    const ENTRY_STARS = 3.0;
    const EXIT_STARS = 3.5;
    const step = 5 * 60000;
    const startMs = fromDate.getTime();
    const endMs = startMs + (maxHoursAhead || 24) * 3600000;

    const currentH = tideHeight(fromDate);
    const currentR = tideRate(fromDate);
    const currentStars = ratingModel.stars(currentH, currentR);
    const insideNow =
      (currentR <= 0 && currentStars >= ENTRY_STARS) ||
      (currentR > 0 && currentStars >= EXIT_STARS);

    let windowStart = insideNow ? fromDate : null;
    let windowEnd = null;
    let peakTime = insideNow ? fromDate : null;
    let peakStars = insideNow ? currentStars : 0;

    for (let t = startMs + step; t < endMs; t += step) {
      const d = new Date(t);
      const h = tideHeight(d);
      const r = tideRate(d);
      const score = ratingModel.stars(h, r);

      if (!windowStart) {
        if (r <= 0 && score >= ENTRY_STARS) {
          windowStart = d;
          peakTime = d;
          peakStars = score;
        }
      } else {
        if (score > peakStars) {
          peakStars = score;
          peakTime = d;
        }
        if (r > 0 && score < EXIT_STARS) {
          windowEnd = d;
          break;
        }
      }
    }

    if (!windowStart) return null;
    if (!windowEnd) windowEnd = new Date(endMs);

    return { start: windowStart, end: windowEnd, peakTime, peakStars, currentlyInside: insideNow };
  }

  function normalizeBeachConfig(config, requestedId) {
    if (!config || !Array.isArray(config.beaches) || config.beaches.length === 0) {
      throw new Error('No beaches configured');
    }
    const id = requestedId || config.defaultBeachId || config.beaches[0].id;
    const beach = config.beaches.find((item) => item.id === id) || config.beaches[0];
    if (!beach.stationId || !beach.coordinates) {
      throw new Error('Beach config is missing station or coordinates');
    }
    return {
      ...beach,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(beach.thresholds || {}) },
      copy: { ...(beach.copy || {}) },
    };
  }

  return {
    DEFAULT_THRESHOLDS,
    createRatingModel,
    parseEventMs,
    apiHeight,
    nextApiEvent,
    findWalkWindow,
    normalizeBeachConfig,
  };
});
