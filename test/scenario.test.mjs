import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import {
  applySchedule,
  pinZone,
  compareScenarios,
  compareCombinations,
} from '../src/domain/scenario.mjs';

const source = new URL('../fixtures/', import.meta.url);

test('applySchedule changes only the targeted window and leaves the source dataset intact', async () => {
  const dataset = await loadDataset(source);
  const changed = applySchedule(dataset, [{ window: 'W1', actual: 'low' }]);
  assert.equal(dataset.windowsByName.get('W1').actual, 'normal', '原资料不变');
  assert.equal(changed.windowsByName.get('W1').actual, 'low');
  assert.equal(changed.windowsByName.get('W2').actual, dataset.windowsByName.get('W2').actual);
});

test('pinZone fixes every window of a zone to one setting', async () => {
  const dataset = await loadDataset(source);
  const pinned = pinZone(dataset, 'east', 'normal');
  const eastWindows = pinned.windows.filter(window => window.zone === 'east');
  assert.ok(eastWindows.length > 0);
  assert.ok(eastWindows.every(window => window.actual === 'normal'));
  assert.ok(dataset.windows.filter(window => window.zone === 'east').some(window => window.actual === 'low'));
});

test('pinning one zone changes the other zone\'s evidence via the shared station', async () => {
  const dataset = await loadDataset(source);
  const pinned = pinZone(dataset, 'east', 'normal');
  const comparison = compareScenarios(
    { name: 'baseline', dataset },
    { name: 'east=normal', dataset: pinned }
  );
  const west = comparison.changes.find(change => change.zone === 'west');
  assert.ok(west, '必须报告 west 的变化');
  // S1 受 W|E 影响；east 固定后 S1 在 west 配对里不再被污染，west 的可用观测应增加。
  assert.ok(
    west.after.strata.some(stratum => stratum.pairs > 0),
    'west 仍应有可比资料'
  );
  const baselineLate = comparison.baseline.byZone.get('west').strata.find(
    stratum => stratum.season === 'late' && stratum.weather === 'clear'
  );
  const afterLate = comparison.reviewed.byZone.get('west').strata.find(
    stratum => stratum.season === 'late' && stratum.weather === 'clear'
  );
  assert.ok(afterLate.n >= baselineLate.n, '固定另一片区后，本片区可用观测不应减少');
});

test('changing one zone flags the other zone for reconsideration when its conclusion moves', async () => {
  const dataset = await loadDataset(source);
  const pinned = pinZone(dataset, 'east', 'normal');
  const comparison = compareScenarios(
    { name: 'baseline', dataset },
    { name: 'east=normal', dataset: pinned }
  );
  const west = comparison.changes.find(change => change.zone === 'west');
  // 即使总体结论码相同，只要分层证据变化，也必须标为需重新审议。
  const lateStatusMoved = west.before.strata.some((stratum, index) =>
    stratum.status !== west.after.strata[index].status
    || stratum.pairs !== west.after.strata[index].pairs
  );
  assert.equal(west.changed, lateStatusMoved || west.before.code !== west.after.code);
  if (lateStatusMoved) {
    assert.ok(comparison.changedZones.includes('west'));
  }
});

test('compareCombinations lines up multiple schedules side by side', async () => {
  const dataset = await loadDataset(source);
  const result = compareCombinations(
    [
      { name: '现状', dataset },
      { name: 'east 固定 normal', overrides: [], dataset: pinZone(dataset, 'east', 'normal') },
      { name: 'east 固定 low', dataset: pinZone(dataset, 'east', 'low') },
    ],
    dataset
  );
  assert.equal(result.scenarios.length, 3);
  // 每个方案都要同时给出两个片区，便于审查员并排比较。
  for (const scenario of result.scenarios) {
    assert.deepEqual(scenario.zones.map(zone => zone.zone).sort(), ['east', 'west']);
  }
  assert.equal(result.pairwise.length, 2);
});

test('a scenario where east is unsafe stays blocked regardless of west\'s evidence', async () => {
  const dataset = await loadDataset(source);
  const result = compareCombinations([{ name: 'east=low', dataset: pinZone(dataset, 'east', 'low') }], dataset);
  const east = result.scenarios[0].zones.find(zone => zone.zone === 'east');
  assert.equal(east.conclusion.code, 'blocked_safety');
});

test('applySchedule can target a night and zone together', async () => {
  const dataset = await loadDataset(source);
  const changed = applySchedule(dataset, [{ night: 7, zone: 'west', actual: 'normal' }]);
  const night7 = changed.windows.find(window => window.night === 7 && window.zone === 'west');
  assert.equal(night7.actual, 'normal');
  assert.equal(changed.windowsByName.get('W24').actual, 'normal');
});
