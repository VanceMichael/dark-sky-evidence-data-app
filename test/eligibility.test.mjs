import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataset } from '../src/domain/dataset.mjs';
import { evaluatePair, evaluateAllPairs } from '../src/domain/eligibility.mjs';

/**
 * 最小可用资料集：两分区各一条步道、三个站（每分区一个处理站 + 一个共用参考站）。
 * 默认两夜一明一暗，天气、季节、月光都对齐。
 */
function makeDataset(overrides = {}) {
  const base = {
    paths: [
      { path: 'W', zone: 'west', low_lux: 2.2, normal_lux: 4.4, emergency_min_lux: 2.0 },
      { path: 'E', zone: 'east', low_lux: 2.5, normal_lux: 4.1, emergency_min_lux: 2.4 },
    ],
    season: [
      { night: 1, season: 'early', observation_zone: 'local', min_safety_lux: 2 },
      { night: 2, season: 'early', observation_zone: 'local', min_safety_lux: 2 },
    ],
    stations: [
      { station: 'TW', zone: 'west', affected_paths: 'W', calibration: 'C1', night_min_readings: 2 },
      { station: 'TE', zone: 'east', affected_paths: 'E', calibration: 'C2', night_min_readings: 2 },
      { station: 'RF', zone: 'ref', affected_paths: '-', calibration: 'C3', night_min_readings: 2 },
    ],
    calibration: [
      { calibration: 'C1', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
      { calibration: 'C2', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
      { calibration: 'C3', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
    ],
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
    readings: [],
    matches: [{ left_window: 'A', right_window: 'B', max_moon_gap: 0.1 }],
    operations: [
      { zone: 'west', path: 'W', minimum: 'low', patrol_coverage: 'full', signed_window: 'A', signed_night: 1 },
    ],
  };
  const merged = { ...base, ...overrides };
  return buildDataset(merged);
}

/** 给某窗口某站加若干读数。 */
function readings(window, station, values) {
  return values.map((mag, index) => ({
    window,
    station,
    minute: (index + 1) * 5,
    mag_arcsec2: mag,
  }));
}

test('a clean pair is eligible with one treated station and one reference', () => {
  const dataset = makeDataset({
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0, 19.0]),
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.treated, ['TW']);
  assert.deepEqual(result.reference, ['RF']);
  assert.deepEqual(result.stations.get('TW').issues, []);
  assert.deepEqual(result.stations.get('RF').issues, []);
});

test('rain excludes the whole pair', () => {
  const dataset = makeDataset({
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'rain', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'rain', moon: 0.2, interruption: '-' },
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.pairIssues.includes('rain'));
});

test('clear and cloud nights are never compared to each other', () => {
  const dataset = makeDataset({
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'cloud', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.pairIssues.includes('weather_mismatch'));
});

test('moon gap beyond the registered limit excludes the pair', () => {
  const dataset = makeDataset({
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.5, interruption: '-' },
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.pairIssues.includes('moon_gap'));
});

test('no planned contrast means the pair is not a comparison', () => {
  const dataset = makeDataset({
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'low', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.pairIssues.includes('no_contrast'));
});

test('planned grouping keeps a safety-overridden window in its planned group', () => {
  // A：排期 low，但安全事件改成 actual normal；B：排期 normal、actual normal。
  // 按 planned 分组仍有对照（A low 组、B normal 组）；按 actual 则无对照。
  const dataset = makeDataset({
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'low', actual: 'normal', weather: 'clear', moon: 0.2, interruption: 'patrol' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [18.0, 18.0]),
      ...readings('A', 'RF', [18.0, 18.0]),
      ...readings('B', 'RF', [18.0, 18.0]),
    ],
  });
  const planned = evaluatePair(dataset, dataset.matches[0], { grouping: 'planned' });
  assert.equal(planned.eligible, true, '排期分组仍保留对照');
  assert.equal(planned.pair.lowWindow, 'A');
  assert.equal(planned.pair.compliance.lowWindow.interruptions.length, 1);
  assert.equal(planned.pair.deliveredDiffer, false, '实际两夜都是 normal');

  const actual = evaluatePair(dataset, dataset.matches[0], { grouping: 'actual' });
  assert.equal(actual.eligible, false);
  assert.ok(actual.pairIssues.includes('no_contrast'));
});

test('a station below the night minimum reading count is unusable', () => {
  const dataset = makeDataset({
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0]), // 只有 1 条，低于 minimum 2；B 是低档（处理）窗
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.stations.get('TW').usable, false);
  assert.ok(result.stations.get('TW').issues.includes('readings_insufficient_treated'));
  assert.deepEqual(result.treated, []);
});

test('invalid calibration on either night makes the station unusable', () => {
  const dataset = makeDataset({
    calibration: [
      { calibration: 'C1', revision: 1, known_night: 0, first_night: 1, last_night: 1, valid: 'true' },
      { calibration: 'C2', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
      { calibration: 'C3', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
    ],
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0, 19.0]),
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.stations.get('TW').usable, false);
  // C1 只覆盖夜 1；B 是夜 2（低档/处理窗），因此是处理侧无校准覆盖。
  assert.ok(result.stations.get('TW').issues.includes('calibration_uncovered_treated'));
});

test('a station affected by both trails is contaminated when the other trail changes', () => {
  // 增加东西两片区的夜窗：S1 同时受 W 和 E 影响。两夜之间 E 的档位变了，
  // 于是 S1 在 W 的配对里被污染，不能当处理站或参考。
  const dataset = makeDataset({
    stations: [
      { station: 'TW', zone: 'west', affected_paths: 'W|E', calibration: 'C1', night_min_readings: 2 },
      { station: 'RF', zone: 'ref', affected_paths: '-', calibration: 'C3', night_min_readings: 2 },
    ],
    calibration: [
      { calibration: 'C1', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
      { calibration: 'C3', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
    ],
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'AE', night: 1, start: '20:00', zone: 'east', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'BE', night: 2, start: '20:00', zone: 'east', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0, 19.0]),
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  const station = result.stations.get('TW');
  assert.equal(station.usable, false);
  assert.ok(station.issues.some(issue => issue.startsWith('contaminated:E')));
  assert.deepEqual(result.treated, []);
});

test('a station affected only by a constant other trail stays usable', () => {
  // S1 受 W|E，但两夜 E 都是 normal，E 的影响在差分中抵消，S1 仍可用。
  const dataset = makeDataset({
    stations: [
      { station: 'TW', zone: 'west', affected_paths: 'W|E', calibration: 'C1', night_min_readings: 2 },
      { station: 'RF', zone: 'ref', affected_paths: '-', calibration: 'C3', night_min_readings: 2 },
    ],
    calibration: [
      { calibration: 'C1', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
      { calibration: 'C3', revision: 1, known_night: 0, first_night: 1, last_night: 40, valid: 'true' },
    ],
    windows: [
      { window: 'A', night: 1, start: '20:00', zone: 'west', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'B', night: 2, start: '20:00', zone: 'west', planned: 'low', actual: 'low', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'AE', night: 1, start: '20:00', zone: 'east', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
      { window: 'BE', night: 2, start: '20:00', zone: 'east', planned: 'normal', actual: 'normal', weather: 'clear', moon: 0.2, interruption: '-' },
    ],
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0, 19.0]),
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.stations.get('TW').usable, true);
  assert.deepEqual(result.treated, ['TW']);
});

test('season mismatch excludes the pair', () => {
  const dataset = makeDataset({
    season: [
      { night: 1, season: 'early', observation_zone: 'local', min_safety_lux: 2 },
      { night: 2, season: 'late', observation_zone: 'local', min_safety_lux: 2 },
    ],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, false);
  assert.ok(result.pairIssues.includes('season_mismatch'));
});

test('pair evaluation is order-independent for delivered settings', () => {
  const dataset = makeDataset({
    readings: [
      ...readings('A', 'TW', [18.0, 18.0]),
      ...readings('B', 'TW', [19.0, 19.0]),
      ...readings('A', 'RF', [18.5, 18.5]),
      ...readings('B', 'RF', [18.5, 18.5]),
    ],
    matches: [{ left_window: 'B', right_window: 'A', max_moon_gap: 0.1 }],
  });
  const result = evaluatePair(dataset, dataset.matches[0]);
  assert.equal(result.eligible, true);
  assert.equal(result.pair.lowWindow, 'B');
  assert.equal(result.pair.normalWindow, 'A');
});

test('evaluateAllPairs preserves registration order', async () => {
  const dataset = await (await import('../src/domain/dataset.mjs'))
    .loadDataset(new URL('../fixtures/', import.meta.url));
  const all = evaluateAllPairs(dataset);
  assert.equal(all.length, dataset.matches.length);
  assert.equal(all[0].pair.pairId, 'W1-W3');
});
