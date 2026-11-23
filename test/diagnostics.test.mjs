import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import { evaluateAllPairs } from '../src/domain/eligibility.mjs';
import { collectObservations } from '../src/domain/estimation.mjs';
import {
  naiveContrast,
  weatherBalance,
  withinPairDecomposition,
  diagnoseZone,
} from '../src/domain/diagnostics.mjs';

const source = new URL('../fixtures/', import.meta.url);

async function analyse() {
  const dataset = await loadDataset(source);
  const pairs = evaluateAllPairs(dataset);
  return { dataset, pairs };
}

test('naive contrast ignores weather and reference and is the largest number', async () => {
  const { dataset } = await analyse();
  const naive = naiveContrast(dataset, 'west', 'S3');
  assert.ok(naive.naiveDelta > 0.5, '朴素差应明显偏大');
  assert.ok(naive.lowWindows > 0 && naive.normalWindows > 0);
});

test('weather balance exposes the confound between schedule and cloud', async () => {
  const { dataset } = await analyse();
  const west = weatherBalance(dataset, 'west');
  assert.equal(west.confounded, true);
  assert.ok(west.clearShareLow > west.clearShareNormal, '低档夜更多晴夜');
  assert.equal(west.cloudShareLow, 0, '西区低档夜没有云夜');

  const east = weatherBalance(dataset, 'east');
  assert.equal(east.confounded, true);
  assert.equal(east.cloudShareNormal, 0, '东区正常档夜没有云夜');
});

test('within-pair decomposition splits raw change into shared drift and trail effect', async () => {
  const { dataset, pairs } = await analyse();
  const observations = collectObservations(dataset, pairs).filter(entry => entry.zone === 'west');
  const decomposition = withinPairDecomposition(observations);
  assert.ok(decomposition.n > 0);
  // 原始差 = 漂移 + 差值-差分（逐观测恒等，均值亦然）。
  assert.ok(Math.abs(decomposition.raw - (decomposition.drift + decomposition.differential)) < 1e-9);
  // 绝大部分表观变化由共享漂移解释。
  assert.ok(decomposition.shareExplainedByDrift > 0.5);
});

test('diagnoseZone produces a warning that names the weather confound', async () => {
  const { dataset, pairs } = await analyse();
  const west = diagnoseZone(dataset, 'west', pairs);
  assert.match(west.warning, /天气构成不同/);
  assert.match(west.warning, /共享的天空条件/);
  assert.ok(west.byStation.length > 0);
});

test('empty observations yield nulls, not zeros', () => {
  const empty = withinPairDecomposition([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.raw, null);
  assert.equal(empty.differential, null);
});
