import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDataset } from '../src/domain/dataset.mjs';
import { review } from '../src/domain/review.mjs';

/**
 * 构造一个完全干净的合成试验：两片区 × 两季节 × 两云量，每分层 4 个配对。
 *
 * @param {(context: {zone: string, setting: string, season: string, weather: string}) => {treated: number, reference: number}} valueOf
 *   返回处理站与参考站在该窗的 mag 读数
 */
function syntheticTrial(valueOf, { emergencyEast = 2.4 } = {}) {
  const paths = [
    { path: 'W', zone: 'west', low_lux: 2.2, normal_lux: 4.4, emergency_min_lux: 2.0 },
    { path: 'E', zone: 'east', low_lux: 2.5, normal_lux: 4.1, emergency_min_lux: emergencyEast },
  ];
  const stations = [
    { station: 'SW', zone: 'west', affected_paths: 'W', calibration: 'CW', night_min_readings: 2 },
    { station: 'SE', zone: 'east', affected_paths: 'E', calibration: 'CE', night_min_readings: 2 },
    { station: 'RF', zone: 'ref', affected_paths: '-', calibration: 'CR', night_min_readings: 2 },
  ];
  const calibration = [
    { calibration: 'CW', revision: 1, known_night: 0, first_night: 1, last_night: 999, valid: 'true' },
    { calibration: 'CE', revision: 1, known_night: 0, first_night: 1, last_night: 999, valid: 'true' },
    { calibration: 'CR', revision: 1, known_night: 0, first_night: 1, last_night: 999, valid: 'true' },
  ];
  const operations = [
    { zone: 'west', path: 'W', minimum: 'low', patrol_coverage: 'full', signed_window: 'x', signed_night: '1' },
    { zone: 'east', path: 'E', minimum: 'low', patrol_coverage: 'full', signed_window: '-', signed_night: '-' },
  ];

  const windows = [];
  const season = [];
  const readings = [];
  const nights = [];
  let night = 0;
  for (const zone of ['west', 'east']) {
    for (const seasonName of ['early', 'late']) {
      for (const weather of ['clear', 'cloud']) {
        // 每个分层 8 夜，低/正常交替，形成 4 个配对（夜号相差 1，天气相同）。
        for (let index = 0; index < 8; index += 1) {
          night += 1;
          const setting = index % 2 === 0 ? 'low' : 'normal';
          windows.push({
            window: `${zone}-${seasonName}-${weather}-${index}`,
            night,
            start: '20:00',
            zone,
            planned: setting,
            actual: setting,
            weather,
            moon: '0.2',
            interruption: '-',
          });
          season.push({ night, season: seasonName, observation_zone: 'local', min_safety_lux: '2' });
          const values = valueOf({ zone, setting, season: seasonName, weather });
          const treated = zone === 'west' ? 'SW' : 'SE';
          for (const minute of [4, 8]) {
            readings.push({ window: windows.at(-1).window, station: treated, minute, mag_arcsec2: values.treated });
            readings.push({ window: windows.at(-1).window, station: 'RF', minute, mag_arcsec2: values.reference });
          }
          nights.push({ zone, seasonName, weather, setting, window: windows.at(-1).window });
        }
      }
    }
  }

  // 配对：同一片区/季节/云量内，相邻的 normal(夜) 与 low(夜)。
  const matches = [];
  const grouped = new Map();
  for (const entry of nights) {
    const key = `${entry.zone}|${entry.seasonName}|${entry.weather}`;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    const low = list.filter(entry => entry.setting === 'low');
    const normal = list.filter(entry => entry.setting === 'normal');
    for (let index = 0; index < Math.min(low.length, normal.length); index += 1) {
      matches.push({ left_window: normal[index].window, right_window: low[index].window, max_moon_gap: '0.1' });
    }
  }

  return buildDataset({ paths, season, stations, calibration, windows, readings, matches, operations });
}

test('a genuinely positive trial across all strata is supported', () => {
  const dataset = syntheticTrial(({ setting }) => ({
    treated: setting === 'low' ? 19.1 : 18.5, // 低档暗 0.6 mag
    reference: 18.8,
  }));
  const result = review(dataset);
  for (const zone of result.zones) {
    assert.equal(zone.conclusion.code, 'supported', `${zone.zone} 应支持维持低档`);
    assert.ok(zone.strata.every(stratum => stratum.status === 'positive'));
  }
});

test('drift-only change (reference moves with treatment) is not attributed to the trail', () => {
  // 处理站低档时暗 0.6，但参考站也同步暗 0.6：差值-差分应为 0。
  const dataset = syntheticTrial(({ setting }) => ({
    treated: setting === 'low' ? 19.1 : 18.5,
    reference: setting === 'low' ? 19.4 : 18.8,
  }));
  const result = review(dataset);
  for (const zone of result.zones) {
    assert.equal(zone.conclusion.code, 'insufficient_evidence');
    for (const stratum of zone.strata) {
      assert.ok(
        ['inconclusive', 'negative'].includes(stratum.status),
        `${zone.zone} ${stratum.season}/${stratum.weather} 不应判为阳性`
      );
      assert.ok(Math.abs(stratum.mean) < 0.05, '差值-差分应接近 0');
    }
  }
});

test('a trial where low is brighter is flagged, never supported', () => {
  const dataset = syntheticTrial(({ setting }) => ({
    treated: setting === 'low' ? 17.9 : 18.5, // 低档反而亮 0.6 mag
    reference: 18.8,
  }));
  const result = review(dataset);
  for (const zone of result.zones) {
    assert.equal(zone.conclusion.code, 'insufficient_evidence');
    assert.ok(zone.conclusion.reasons.includes('negative_stratum'));
  }
});

test('safety block overrides otherwise-positive evidence', () => {
  const dataset = syntheticTrial(
    ({ setting }) => ({ treated: setting === 'low' ? 19.1 : 18.5, reference: 18.8 }),
    { emergencyEast: 3.0 } // 东区低档低于应急照度
  );
  const result = review(dataset);
  const east = result.byZone.get('east');
  assert.equal(east.conclusion.code, 'blocked_safety');
  assert.ok(east.strata.every(stratum => stratum.status === 'positive'), '证据本身是阳性的，但安全阻断优先');
});
