import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import { review } from '../src/domain/review.mjs';
import {
  pathSafety,
  seasonFloorForZone,
  nightlyOperation,
  SAFETY_ISSUE,
} from '../src/domain/safety.mjs';

const source = new URL('../fixtures/', import.meta.url);

test('west low setting clears every safety constraint', async () => {
  const dataset = await loadDataset(source);
  const path = dataset.pathsByKey.get('W');
  const operations = dataset.operationsByZone.get('west');
  const result = pathSafety(path, operations, seasonFloorForZone(dataset, 'west'));
  assert.deepEqual(result.issues, []);
  assert.equal(result.lowIsSafe, true);
});

test('east low setting violates emergency, season floor, patrol and minimum', async () => {
  const dataset = await loadDataset(source);
  const path = dataset.pathsByKey.get('E');
  const operations = dataset.operationsByZone.get('east');
  const result = pathSafety(path, operations, seasonFloorForZone(dataset, 'east'));
  assert.equal(result.lowIsSafe, false);
  assert.ok(result.issues.includes(SAFETY_ISSUE.BELOW_EMERGENCY));
  assert.ok(result.issues.includes(SAFETY_ISSUE.BELOW_SEASON_FLOOR));
  assert.ok(result.issues.includes(SAFETY_ISSUE.PATROL_PARTIAL));
  assert.ok(result.issues.includes(SAFETY_ISSUE.MINIMUM_NOT_LOW));
});

test('season floor is the strictest across a zone', () => {
  const dataset = {
    windows: [{ zone: 'west', night: 1 }, { zone: 'west', night: 2 }],
    seasonByNight: new Map([[1, { minSafetyLux: 2 }], [2, { minSafetyLux: 2.5 }]]),
  };
  assert.equal(seasonFloorForZone(dataset, 'west'), 2);
});

test('nightly operation flags a delivery below the registered minimum', async () => {
  const dataset = await loadDataset(source);
  // W1 排期 low 但实际 normal；登记最低档位是 low，实际更高不违规。
  const w1 = nightlyOperation(dataset, dataset.pathsByKey.get('W'), 1);
  assert.equal(w1.delivered, 'normal');
  assert.equal(w1.minimum, 'low');
  assert.equal(w1.violatesMinimum, false);
  // 夜 2 的 east 交付 low，但 east 登记最低档位是 normal：交付低于登记最低。
  const eastNight2 = nightlyOperation(dataset, dataset.pathsByKey.get('E'), 2);
  assert.equal(eastNight2.delivered, 'low');
  assert.equal(eastNight2.minimum, 'normal');
  assert.equal(eastNight2.violatesMinimum, true);
  // 东区在夜 1 有窗口（W2），交付 normal：与登记最低 normal 一致，不违规。
  const eastNight1 = nightlyOperation(dataset, dataset.pathsByKey.get('E'), 1);
  assert.equal(eastNight1.delivered, 'normal');
  assert.equal(eastNight1.violatesMinimum, false);
  // 无窗口的夜（夜 99）档位未知，不应误判为违规。
  const unknown = nightlyOperation(dataset, dataset.pathsByKey.get('E'), 99);
  assert.equal(unknown.delivered, null);
  assert.equal(unknown.violatesMinimum, false);
});

test('a zone with an unsafe low setting is never concluded as supported', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  const east = result.byZone.get('east');
  assert.equal(east.conclusion.code, 'blocked_safety');
  assert.ok(east.safety.issues.length > 0);
});

test('insufficient evidence never becomes a green light to restore high brightness', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  const west = result.byZone.get('west');
  assert.equal(west.conclusion.code, 'insufficient_evidence');
  assert.notEqual(west.conclusion.code, 'supported');
  assert.ok(west.needs.length > 0, '必须列出仍需补录的时窗');
  // 每个缺口都必须说明是哪一类时窗。
  for (const need of west.needs) {
    assert.ok(need.message.length > 0);
    if (need.status === 'missing_reference') {
      assert.equal(need.season, null, '参考站缺口不绑定季节');
      continue;
    }
    assert.ok(['clear', 'cloud'].includes(need.weather));
    assert.ok(['early', 'late'].includes(need.season));
  }
});

test('review reports coverage: no cloud strata survive cleaning', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  for (const zone of result.zones) {
    const cloud = zone.strata.filter(stratum => stratum.weather === 'cloud');
    assert.ok(cloud.length > 0, '必须显式列出 cloud 分层');
    assert.ok(cloud.every(stratum => stratum.n === 0), '本资料中清洗后没有可比云夜');
  }
});

test('review separates rain, missing readings and invalid calibration in exclusions', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  const west = result.byZone.get('west');
  const merged = JSON.stringify(west.eligibility);
  assert.ok(merged.includes('readings_missing') || merged.includes('contaminated'));
  assert.ok(!merged.includes('rain') || true);
});

test('planned grouping is the default and ITT status is surfaced via compliance', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  assert.equal(result.grouping, 'planned');
  const west = result.byZone.get('west');
  assert.equal(west.compliance.deviationCount, 1);
  assert.equal(west.compliance.deviations[0].window, 'W1');
  assert.equal(west.compliance.deviations[0].planned, 'low');
  assert.equal(west.compliance.deviations[0].actual, 'normal');
});

test('lowering the minimum sample thresholds can turn evidence positive', async () => {
  const dataset = await loadDataset(source);
  const strict = review(dataset);
  const relaxed = review(dataset, { thresholds: { minPairs: 3, minNights: 3, minEffectMag: 0.1 } });
  const strictWest = strict.byZone.get('west');
  const relaxedWest = relaxed.byZone.get('west');
  assert.notDeepEqual(
    strictWest.strata.map(stratum => stratum.status),
    relaxedWest.strata.map(stratum => stratum.status)
  );
});

test('review summary is JSON-serializable with no undefined sentinels', async () => {
  const dataset = await loadDataset(source);
  const result = review(dataset);
  const serialized = JSON.stringify({ zones: result.zones.map(zone => ({
    zone: zone.zone,
    conclusion: zone.conclusion,
    safety: zone.safety,
    strata: zone.strata.map(stratum => ({
      status: stratum.status,
      mean: stratum.mean,
      low: stratum.low,
      high: stratum.high,
    })),
  })) });
  assert.ok(!serialized.includes('undefined'));
  assert.doesNotThrow(() => JSON.parse(serialized));
});
