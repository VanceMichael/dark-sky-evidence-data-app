import assert from 'node:assert/strict';
import test from 'node:test';
import {
  magToFlux,
  fluxToMag,
  combineMagnitudes,
  darkeningFraction,
  fluxRatioToMag,
} from '../src/domain/units.mjs';

test('magnitude-flux conversion round-trips and 5 mag = 1% flux', () => {
  assert.ok(Math.abs(fluxToMag(magToFlux(18)) - 18) < 1e-12);
  assert.ok(Math.abs(magToFlux(5) * 100 - 1) < 1e-12);
  assert.ok(Math.abs(magToFlux(0) - 1) < 1e-12);
});

test('combining magnitudes averages in flux, not in mag', () => {
  // 两档读数 18 与 19：mag 平均 18.5，通量平均后应回到更接近 17.75。
  const combined = combineMagnitudes([18, 19]);
  const naive = 18.5;
  assert.ok(combined < naive, '通量平均应比 mag 平均更暗');
  const expected = -2.5 * Math.log10((magToFlux(18) + magToFlux(19)) / 2);
  assert.ok(Math.abs(combined - expected) < 1e-12);
  // 平均上界：不得亮于最亮读数，也不得暗于最暗读数。
  assert.ok(combined >= 18 && combined <= 19);
});

test('equal magnitudes combine to themselves', () => {
  assert.equal(combineMagnitudes([18.5, 18.5, 18.5]), 18.5);
});

test('combining rejects empty and non-finite input', () => {
  assert.throws(() => combineMagnitudes([]), /没有可用于汇总的读数/);
  assert.throws(() => combineMagnitudes([18, NaN]), /不是有限数值/);
});

test('darkening fraction maps mag difference to flux reduction', () => {
  assert.ok(Math.abs(darkeningFraction(0)) < 1e-12);
  assert.ok(Math.abs(darkeningFraction(2.5) - 0.9) < 1e-12, '2.5 mag 对应通量减到 10%');
  assert.ok(Math.abs(fluxRatioToMag(0.1) - 2.5) < 1e-12);
});

test('flux helpers reject non-positive values', () => {
  assert.throws(() => fluxToMag(0), /必须为有限正数/);
  assert.throws(() => fluxRatioToMag(-1), /必须为正数/);
});
