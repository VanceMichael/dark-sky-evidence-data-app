import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCalibration,
  calibrationChanged,
  CALIBRATION_STATUS,
} from '../src/domain/calibration.mjs';

const record = (overrides) => ({
  calibration: 'C',
  revision: 1,
  knownNight: 0,
  firstNight: 1,
  lastNight: 40,
  valid: true,
  ...overrides,
});

test('validity range includes both endpoints', () => {
  const records = [record({ firstNight: 2, lastNight: 4 })];
  assert.equal(resolveCalibration(records, 1).status, CALIBRATION_STATUS.UNCOVERED);
  assert.equal(resolveCalibration(records, 2).status, CALIBRATION_STATUS.VALID);
  assert.equal(resolveCalibration(records, 4).status, CALIBRATION_STATUS.VALID);
  assert.equal(resolveCalibration(records, 5).status, CALIBRATION_STATUS.UNCOVERED);
});

test('later revision overrides only within its own interval', () => {
  const records = [
    record({ revision: 1, firstNight: 1, lastNight: 40, valid: true }),
    record({ revision: 2, knownNight: 5, firstNight: 2, lastNight: 4, valid: false }),
  ];
  // 夜 2-4 被修订 2 覆盖且判为无效。
  assert.equal(resolveCalibration(records, 2).status, CALIBRATION_STATUS.INVALID);
  assert.equal(resolveCalibration(records, 2).revision, 2);
  // 夜 5 不在修订 2 区间，退回修订 1。
  assert.equal(resolveCalibration(records, 5).status, CALIBRATION_STATUS.VALID);
  assert.equal(resolveCalibration(records, 5).revision, 1);
});

test('knowledge cut hides later revisions and marks pending', () => {
  const records = [
    record({ revision: 1, firstNight: 1, lastNight: 40, valid: true }),
    record({ revision: 2, knownNight: 5, firstNight: 2, lastNight: 4, valid: false }),
  ];
  // 会议在夜 4 开，修订 2 尚未可知：夜 2 仍按修订 1 判有效。
  const early = resolveCalibration(records, 2, 4);
  assert.equal(early.status, CALIBRATION_STATUS.VALID);
  assert.equal(early.revision, 1);
  // 夜 5 之后修订 2 可知：夜 2 变为无效。
  assert.equal(resolveCalibration(records, 2, 5).status, CALIBRATION_STATUS.INVALID);
});

test('pending when only unknown records cover the night', () => {
  const records = [record({ revision: 2, knownNight: 6, firstNight: 2, lastNight: 4, valid: false })];
  assert.equal(resolveCalibration(records, 3, 5).status, CALIBRATION_STATUS.PENDING);
  assert.equal(resolveCalibration(records, 3, 6).status, CALIBRATION_STATUS.INVALID);
});

test('calibrationChanged detects status and revision moves', () => {
  const before = { status: CALIBRATION_STATUS.VALID, revision: 1 };
  const after = { status: CALIBRATION_STATUS.INVALID, revision: 2 };
  assert.equal(calibrationChanged(before, after), true);
  assert.equal(calibrationChanged(before, { status: CALIBRATION_STATUS.VALID, revision: 1 }), false);
});

test('highest revision wins among multiple covering records', () => {
  const records = [
    record({ revision: 3, firstNight: 1, lastNight: 10, valid: true }),
    record({ revision: 5, firstNight: 1, lastNight: 10, valid: false }),
  ];
  assert.equal(resolveCalibration(records, 5).revision, 5);
  assert.equal(resolveCalibration(records, 5).status, CALIBRATION_STATUS.INVALID);
});
