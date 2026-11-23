import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset, buildDataset, FIELDS } from '../src/domain/dataset.mjs';
import { MaterialsError } from '../src/domain/errors.mjs';

const source = new URL('../fixtures/', import.meta.url);

async function fixture() {
  return loadDataset(source);
}

function rawFrom(dataset) {
  return {
    paths: dataset.paths.map(row => ({ path: row.path, zone: row.zone, low_lux: row.lowLux, normal_lux: row.normalLux, emergency_min_lux: row.emergencyMinLux })),
    season: dataset.seasons.map(row => ({ night: row.night, season: row.season, observation_zone: row.observationZone, min_safety_lux: row.minSafetyLux })),
    stations: dataset.stations.map(row => ({ station: row.station, zone: row.zone, affected_paths: row.affectedPaths.join('|'), calibration: row.calibration, night_min_readings: row.nightMinReadings })),
    calibration: dataset.calibrationRecords.map(row => ({ calibration: row.calibration, revision: row.revision, known_night: row.knownNight, first_night: row.firstNight, last_night: row.lastNight, valid: String(row.valid) })),
    windows: dataset.windows.map(row => ({ window: row.window, night: row.night, start: row.start, zone: row.zone, planned: row.planned, actual: row.actual, weather: row.weather, moon: row.moon, interruption: row.interruption.join('|') || '-' })),
    readings: dataset.readings.map(row => ({ window: row.window, station: row.station, minute: row.minute, mag_arcsec2: row.magArcsec2 })),
    matches: dataset.matches.map(row => ({ left_window: row.leftWindow, right_window: row.rightWindow, max_moon_gap: row.maxMoonGap })),
    operations: dataset.operations.map(row => ({ zone: row.zone, path: row.path, minimum: row.minimum, patrol_coverage: row.patrolCoverage, signed_window: row.signedWindow ?? '-', signed_night: row.signedNight ?? '-' })),
  };
}

test('loads all fixture tables with expected shapes', async () => {
  const dataset = await fixture();
  assert.equal(dataset.windows.length, 55);
  assert.equal(dataset.stations.length, 4);
  assert.equal(dataset.paths.length, 2);
  assert.equal(dataset.seasons.length, 29);
  assert.equal(dataset.readings.length, 446);
  assert.equal(dataset.matches.length, 50);
  assert.equal(dataset.operations.length, 2);
});

test('multi-value affected_paths parses, dash means none', async () => {
  const dataset = await fixture();
  assert.deepEqual(dataset.stationsByName.get('S1').affectedPaths, ['W', 'E']);
  assert.deepEqual(dataset.stationsByName.get('S4').affectedPaths, []);
});

test('night-zone setting index reflects actual delivery', async () => {
  const dataset = await fixture();
  const settings = dataset.derived.nightZoneSetting.get(1);
  assert.equal(settings.get('west'), 'normal'); // W1 安全事件改回 normal
  assert.equal(settings.get('east'), 'normal');
});

test('rejects a window with an undeclared weather value', async () => {
  const dataset = await fixture();
  const raw = rawFrom(dataset);
  raw.windows[0] = { ...raw.windows[0], weather: 'fog' };
  assert.throws(
    () => buildDataset(raw),
    error => error instanceof MaterialsError && error.issues.some(item => /weather/.test(item.message))
  );
});

test('rejects windows that share a night and zone', async () => {
  const dataset = await fixture();
  const raw = rawFrom(dataset);
  raw.windows.push({ ...raw.windows[0], window: 'DUPLICATE', line: 2 });
  assert.throws(
    () => buildDataset(raw),
    error => error instanceof MaterialsError && error.issues.some(item => /多个窗口/.test(item.message))
  );
});

test('rejects a calibration interval that ends before it starts', async () => {
  const dataset = await fixture();
  const raw = rawFrom(dataset);
  raw.calibration[0] = { ...raw.calibration[0], first_night: 10, last_night: 5 };
  assert.throws(
    () => buildDataset(raw),
    error => error instanceof MaterialsError && error.issues.some(item => /晚于 last_night/.test(item.message))
  );
});

test('rejects duplicate primary keys', async () => {
  const dataset = await fixture();
  const raw = rawFrom(dataset);
  raw.stations.push({ ...raw.stations[0] });
  assert.throws(
    () => buildDataset(raw),
    error => error instanceof MaterialsError && error.issues.some(item => /重复/.test(item.message))
  );
});

test('field order matches format.json contract', async () => {
  const format = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('format.json', source), 'utf8'));
  assert.deepEqual(FIELDS, format.tables);
});
