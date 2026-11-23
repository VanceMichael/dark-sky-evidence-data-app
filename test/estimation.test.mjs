import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import { evaluateAllPairs } from '../src/domain/eligibility.mjs';
import {
  windowMagnitude,
  pairObservations,
  collectObservations,
  stratify,
  nightBlocks,
  blockBootstrap,
  summarizeStratum,
  coverageMatrix,
  makeRng,
  stratumKey,
} from '../src/domain/estimation.mjs';
import { combineMagnitudes } from '../src/domain/units.mjs';

const source = new URL('../fixtures/', import.meta.url);

const observation = (pairId, effect, nights, extra = {}) => ({
  pairId,
  zone: 'west',
  weather: 'clear',
  season: 'late',
  station: 'S3',
  lowWindow: `${pairId}-lo`,
  normalWindow: `${pairId}-no`,
  nights,
  effect,
  ...extra,
});

test('window magnitude is a flux average, not a mag average', async () => {
  const dataset = await loadDataset(source);
  const mags = dataset.readings.filter(r => r.window === 'W22' && r.station === 'S1').map(r => r.magArcsec2);
  assert.equal(mags.length, 3);
  assert.equal(windowMagnitude(dataset, 'W22', 'S1'), combineMagnitudes(mags));
  assert.notEqual(windowMagnitude(dataset, 'W22', 'S1'), mags.reduce((a, b) => a + b, 0) / mags.length);
});

test('pair observation is treated-minus-control minus reference drift', async () => {
  const dataset = await loadDataset(source);
  const evaluated = evaluateAllPairs(dataset);
  const pair = evaluated.find(entry => entry.eligible && entry.pair.pairId === 'W28-W30');
  const observations = pairObservations(dataset, pair);
  assert.equal(observations.length, 1);
  const [first] = observations;
  const treatedLow = windowMagnitude(dataset, 'W28', 'S3');
  const treatedNormal = windowMagnitude(dataset, 'W30', 'S3');
  const refLow = windowMagnitude(dataset, 'W28', 'S4');
  const refNormal = windowMagnitude(dataset, 'W30', 'S4');
  assert.ok(Math.abs(first.effect - ((treatedLow - treatedNormal) - (refLow - refNormal))) < 1e-12);
  assert.equal(first.station, 'S3');
});

test('differential design cancels a reference drift shared by both windows', () => {
  // 构造：处理站低了 0.5 mag，但参考站同样漂移了 0.5 mag（整晚云量变化），
  // 差分-差分应给出约 0 的效应，而不是 0.5。
  const observations = [
    observation('P1', (18.5 - 18.0) - (18.5 - 18.0), [1, 2]),
  ];
  assert.equal(observations[0].effect, 0);
});

test('night blocks join pairs that share a night', () => {
  const observations = [
    observation('P1', 0.1, [1, 2]),
    observation('P2', 0.2, [2, 3]),
    observation('P3', 0.3, [10, 11]),
  ];
  const blocks = nightBlocks(observations);
  assert.equal(blocks.length, 2, 'P1-P2 通过夜 2 相连，P3 独立');
  const sizes = blocks.map(block => block.sort().join(',')).sort();
  assert.deepEqual(sizes, ['P1,P2', 'P3']);
});

test('block bootstrap resamples nights, not minutes, so intervals reflect night count', () => {
  // 10 个配对，每个只有 3 条读数但都来自同一夜对——独立信息只有很少几个夜。
  const clustered = [];
  for (let index = 0; index < 10; index += 1) {
    clustered.push(observation(`C${index}`, index % 2 === 0 ? 0.2 : -0.2, [1, 2]));
  }
  const wide = blockBootstrap(clustered, { seed: 1, resamples: 2000 });
  assert.equal(wide.blocks, 1, '全部共享同一夜对，只有一个块');

  const spread = [];
  for (let index = 0; index < 10; index += 1) {
    spread.push(observation(`D${index}`, index % 2 === 0 ? 0.2 : -0.2, [index * 2 + 1, index * 2 + 2]));
  }
  const narrow = blockBootstrap(spread, { seed: 1, resamples: 2000 });
  assert.equal(narrow.blocks, 10, '每个配对独占一对夜');
  assert.ok(narrow.low !== null && narrow.high !== null);
  assert.ok(wide.low === null && wide.high === null, '单块无法给出区间');
});

test('bootstrap is deterministic given the same seed', () => {
  const observations = [];
  for (let index = 0; index < 8; index += 1) {
    observations.push(observation(`E${index}`, Math.sin(index) * 0.3, [index * 2 + 1, index * 2 + 2]));
  }
  const first = blockBootstrap(observations, { seed: 42, resamples: 500 });
  const second = blockBootstrap(observations, { seed: 42, resamples: 500 });
  assert.deepEqual(first, second);
  const other = blockBootstrap(observations, { seed: 7, resamples: 500 });
  assert.notEqual(first.low, other.low);
});

test('summarizeStratum reports n, pairs, nights, stations and effects', async () => {
  const dataset = await loadDataset(source);
  const evaluated = evaluateAllPairs(dataset);
  const observations = collectObservations(dataset, evaluated);
  const summary = summarizeStratum(observations.filter(entry => entry.zone === 'west' && entry.season === 'late'));
  assert.equal(summary.zone, undefined);
  assert.ok(summary.n >= 1);
  assert.ok(summary.nights >= summary.pairs);
  assert.deepEqual(summary.stations, ['S3']);
  assert.equal(summary.effects.length, summary.n);
});

test('stratify separates clear from cloud and keeps unstratified separate', () => {
  const observations = [
    observation('P1', 0.1, [1, 2], { season: 'late', weather: 'clear' }),
    observation('P2', 0.2, [3, 4], { season: 'late', weather: 'cloud' }),
    observation('P3', 0.3, [5, 6], { season: null, weather: 'clear' }),
  ];
  const { strata, unstratified } = stratify(observations);
  assert.equal(strata.size, 2);
  assert.equal(unstratified.length, 1);
  assert.ok(strata.has(stratumKey('west', 'late', 'clear')));
  assert.ok(strata.has(stratumKey('west', 'late', 'cloud')));
});

test('coverage matrix enumerates empty cells explicitly', () => {
  const observations = [observation('P1', 0.1, [1, 2], { season: 'late', weather: 'clear' })];
  const matrix = coverageMatrix(observations, ['west', 'east'], ['early', 'late'], ['clear', 'cloud']);
  assert.equal(matrix.length, 8);
  const empty = matrix.filter(cell => cell.n === 0);
  assert.equal(empty.length, 7, '只有 late/clear/west 有资料');
  const filled = matrix.find(cell => cell.n > 0);
  assert.equal(filled.zone, 'west');
  assert.equal(filled.season, 'late');
  assert.equal(filled.weather, 'clear');
});

test('makeRng yields reproducible sequences in [0,1)', () => {
  const a = makeRng(3);
  const b = makeRng(3);
  for (let index = 0; index < 100; index += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});
