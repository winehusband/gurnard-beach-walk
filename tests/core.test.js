const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../beach-core.js');

test('rating model preserves calibrated Gurnard thresholds', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });

  assert.equal(rating.stars(3.8, -0.1), 0);
  assert.equal(rating.stars(1.55, -0.1), 5);
  assert.ok(rating.stars(2.111, -0.1) >= 3.0);
  assert.ok(rating.stars(2.337, -0.1) < 3.0);
});

test('rating model applies the rising tide penalty above the inlet threshold', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });

  const falling = rating.stars(1.9, -0.2);
  const rising = rating.stars(1.9, 0.2);

  assert.ok(rising < falling);
  assert.ok(rising >= 3.0);
});

test('Admiralty event parsing treats timestamps without Z as UTC', () => {
  assert.equal(
    core.parseEventMs('2026-05-20T06:40:00'),
    Date.UTC(2026, 4, 20, 6, 40, 0),
  );
});

test('apiHeight interpolates between consecutive high and low water events', () => {
  const events = [
    { EventType: 'HighWater', DateTime: '2026-05-20T00:00:00', Height: 4 },
    { EventType: 'LowWater', DateTime: '2026-05-20T06:00:00', Height: 1 },
  ];

  assert.equal(core.apiHeight(events, new Date('2026-05-20T00:00:00Z')), 4);
  assert.equal(core.apiHeight(events, new Date('2026-05-20T06:00:00Z')), 1);
  assert.equal(core.apiHeight(events, new Date('2026-05-20T03:00:00Z')), 2.5);
});

test('nextApiEvent selects the next matching high or low event', () => {
  const events = [
    { EventType: 'HighWater', DateTime: '2026-05-20T00:00:00', Height: 4.2 },
    { EventType: 'LowWater', DateTime: '2026-05-20T06:00:00', Height: 0.8 },
    { EventType: 'HighWater', DateTime: '2026-05-20T12:00:00', Height: 4.1 },
  ];

  const from = new Date('2026-05-20T01:00:00Z');
  assert.equal(core.nextApiEvent(events, from, 'low').time.toISOString(), '2026-05-20T06:00:00.000Z');
  assert.equal(core.nextApiEvent(events, from, 'high').time.toISOString(), '2026-05-20T12:00:00.000Z');
});

test('beach config normalizes and selects requested beaches', () => {
  const configPath = path.join(__dirname, '..', 'beaches.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const beach = core.normalizeBeachConfig(config, 'gurnard');

  assert.equal(beach.id, 'gurnard');
  assert.equal(beach.stationId, '0060');
  assert.equal(beach.thresholds.inlet, 2.15);
  assert.equal(typeof beach.coordinates.latitude, 'number');
});

test('findWalkWindow returns the current window when conditions are already good', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });
  const start = new Date('2026-05-20T10:00:00Z');

  const window = core.findWalkWindow(
    start,
    2,
    () => 1.4,
    () => -0.2,
    rating,
  );

  assert.equal(window.currentlyInside, true);
  assert.equal(window.start, start);
  assert.ok(window.peakStars >= 5);
});
