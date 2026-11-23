import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import { review } from '../src/domain/review.mjs';
import { formatReview, formatDarkening } from '../src/domain/report.mjs';

const source = new URL('../fixtures/', import.meta.url);

test('report states conclusions, coverage and gaps for every zone', async () => {
  const dataset = await loadDataset(source);
  const text = formatReview(review(dataset));
  assert.match(text, /west 片区/);
  assert.match(text, /east 片区/);
  assert.match(text, /清洗后无资料/, '必须显式说明 cloud 分层无资料');
  assert.match(text, /仍需补录的时窗/);
  assert.match(text, /低档低于路径应急照度/);
  assert.match(text, /不得据此恢复高亮/);
});

test('report shows compliance deviations without moving windows out of their group', async () => {
  const dataset = await loadDataset(source);
  const text = formatReview(review(dataset));
  assert.match(text, /W1（夜 1）：排期 low → 实际 normal/);
  assert.match(text, /仍留原分组/);
});

test('report labels the estimator and units', async () => {
  const dataset = await loadDataset(source);
  const text = formatReview(review(dataset));
  assert.match(text, /参考站校正后/);
  assert.match(text, /正值=低档更暗/);
  assert.match(text, /95% 区间/);
});

test('formatDarkening converts a magnitude gap to flux percentage', () => {
  const text = formatDarkening(2.5);
  assert.match(text, /2\.500 mag/);
  assert.match(text, /90\.0%/);
  assert.equal(formatDarkening(null), '—');
});

test('report never claims a benefit when a stratum is empty', async () => {
  const dataset = await loadDataset(source);
  const west = review(dataset).byZone.get('west');
  const cloud = west.strata.filter(stratum => stratum.weather === 'cloud');
  for (const stratum of cloud) {
    assert.equal(stratum.n, 0);
    const need = west.needs.find(item => item.season === stratum.season && item.weather === 'cloud');
    assert.ok(need.message.includes('没有任何合格配对'));
  }
});
