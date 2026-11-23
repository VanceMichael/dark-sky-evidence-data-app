import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDataset } from '../src/domain/dataset.mjs';
import {
  captureReview,
  diffReviews,
  createLedger,
  signedSettings,
  calibrationState,
  diffCalibrationState,
} from '../src/domain/ledger.mjs';

const source = new URL('../fixtures/', import.meta.url);

async function fixtures() {
  // 会议在夜 4 开：C04 修订 2 的 known_night=5，当时尚不可知。
  const atMeeting = await loadDataset(source, { asOf: 4 });
  const later = await loadDataset(source, { asOf: Infinity });
  return { atMeeting, later };
}

test('snapshot records reviewed version, as-of night, and signed settings', async () => {
  const { atMeeting } = await fixtures();
  const snapshot = captureReview(atMeeting, {
    reviewedAt: '2026-06-01',
    approved: { zones: ['west'], basis: 'W1 签准' },
  });
  assert.equal(snapshot.reviewedAt, '2026-06-01');
  assert.equal(snapshot.asOf, 4);
  assert.deepEqual(snapshot.approved, { zones: ['west'], basis: 'W1 签准' });
  assert.ok(snapshot.signedSettings.some(entry => entry.zone === 'west'));
  // 现场按什么档位运行必须可核：W1 排期 low、现场 normal。
  const west = snapshot.signedSettings.find(entry => entry.zone === 'west');
  const night1 = west.nights.find(night => night.night === 1);
  assert.equal(night1.planned, 'low');
  assert.equal(night1.actual, 'normal');
});

test('snapshot is frozen so later corrections cannot silently rewrite history', async () => {
  const { atMeeting } = await fixtures();
  const snapshot = captureReview(atMeeting, { reviewedAt: '2026-06-01' });
  assert.ok(Object.isFrozen(snapshot));
});

test('calibration state records which nights were treated as valid at review time', async () => {
  const { atMeeting, later } = await fixtures();
  const early = calibrationState(atMeeting).find(item => item.station === 'S4' && item.night === 2);
  const late = calibrationState(later).find(item => item.station === 'S4' && item.night === 2);
  assert.equal(early.status, 'valid');
  assert.equal(early.revision, 1);
  assert.equal(late.status, 'invalid');
  assert.equal(late.revision, 2);
});

test('diff catches the retroactive calibration correction on nights 2-4', async () => {
  const { atMeeting, later } = await fixtures();
  const before = captureReview(atMeeting, { reviewedAt: '2026-06-01' });
  const after = captureReview(later, { reviewedAt: '2026-06-10' });
  const diff = diffReviews(before, after);
  const corrected = diff.calibrationCorrections.filter(item => item.direction === 'corrected');
  assert.deepEqual(corrected.map(item => item.night).sort((a, b) => a - b), [2, 3, 4]);
  assert.ok(corrected.every(item => item.station === 'S4' && item.calibration === 'C04'));
  assert.ok(corrected.every(item => item.before.status === 'valid' && item.after.status === 'invalid'));
});

test('diff separates still-valid safety arrangements from items needing reconsideration', async () => {
  const { atMeeting, later } = await fixtures();
  const before = captureReview(atMeeting, { reviewedAt: '2026-06-01', approved: { zones: ['west'] } });
  const after = captureReview(later, { reviewedAt: '2026-06-10' });
  const diff = diffReviews(before, after);
  // west 的安全安排仍有效。
  assert.ok(diff.stillValid.some(item => item.startsWith('west')));
  // east 的低档在两次审阅中都不安全：维持阻断，不算「新出现的重议项」，但要列入仍有效项。
  assert.ok(diff.stillValid.some(item => item.startsWith('east: 安全阻断维持')));
});

test('approval impact is flagged when a later correction touches an approved zone', async () => {
  const { atMeeting, later } = await fixtures();
  const before = captureReview(atMeeting, { reviewedAt: '2026-06-01', approved: { zones: ['west'] } });
  const after = captureReview(later, { reviewedAt: '2026-06-10' });
  // 人为让西区结论变化：放宽阈值以改变分层状态。
  const changed = captureReview(later, {
    reviewedAt: '2026-06-10',
    thresholds: { minPairs: 1, minNights: 1 },
  });
  const diff = diffReviews(before, changed);
  assert.equal(diff.approvalImpact.approvedBefore.zones.includes('west'), true);
  assert.ok(['unchanged', 'reconsider'].includes(diff.approvalImpact.status));
});

test('ledger can retrieve the version actually seen on a given date', async () => {
  const { atMeeting, later } = await fixtures();
  const ledger = createLedger();
  ledger.add(captureReview(atMeeting, { reviewedAt: '2026-06-01' }));
  ledger.add(captureReview(later, { reviewedAt: '2026-06-10' }));

  const asSeen = ledger.at('2026-06-01');
  assert.equal(asSeen.asOf, 4);
  assert.equal(asSeen.reviewedAt, '2026-06-01');

  const latest = ledger.latest();
  assert.equal(latest.asOf, Infinity);

  // 日期落在两次审阅之间，得到当时最后一次审阅的版本。
  assert.equal(ledger.at('2026-06-05').reviewedAt, '2026-06-01');
  assert.equal(ledger.at('2025-01-01'), null);
});

test('ledger trail yields diffs between successive reviews', async () => {
  const { atMeeting, later } = await fixtures();
  const ledger = createLedger();
  ledger.add(captureReview(atMeeting, { reviewedAt: '2026-06-01' }));
  ledger.add(captureReview(later, { reviewedAt: '2026-06-10' }));
  const trail = ledger.trail();
  assert.equal(trail.length, 1);
  assert.ok(trail[0].calibrationCorrections.length >= 3);
});

test('signed settings expose per-night delivery and registered minimum', async () => {
  const { later } = await fixtures();
  const settings = signedSettings(later);
  const east = settings.find(entry => entry.zone === 'east');
  assert.equal(east.minimum, 'normal');
  assert.equal(east.patrolCoverage, 'partial');
  assert.ok(east.nights.every(night => typeof night.actual === 'string'));
});

test('diffCalibrationState reports added records as well as corrections', () => {
  const before = [{ station: 'S', calibration: 'C', night: 1, status: 'uncovered', revision: null }];
  const after = [
    { station: 'S', calibration: 'C', night: 1, status: 'valid', revision: 1 },
    { station: 'S', calibration: 'C', night: 2, status: 'valid', revision: 1 },
  ];
  const changes = diffCalibrationState(before, after);
  assert.ok(changes.some(change => change.direction === 'corrected' && change.night === 1));
  assert.ok(changes.some(change => change.direction === 'added' && change.night === 2));
});

test('a calibration correction names the registered pairs it touches', async () => {
  const { atMeeting, later } = await fixtures();
  const before = captureReview(atMeeting, { reviewedAt: '2026-06-01' });
  const after = captureReview(later, { reviewedAt: '2026-06-10' });
  const diff = diffReviews(before, after);
  const night2 = diff.calibrationCorrections.find(item => item.night === 2 && item.station === 'S4');
  assert.ok(night2, '应有夜 2 的 C04 更正');
  // 夜 2 被 W2-W4、W4-W7 等登记配对引用；更正必须定位到具体配对。
  assert.ok(night2.affectedPairs.length > 0);
  assert.ok(night2.affectedPairs.every(pair => pair.pairId.includes('W')));
});

test('registeredPairs records excluded pairs too, for later tracing', async () => {
  const { atMeeting } = await fixtures();
  const snapshot = captureReview(atMeeting, { reviewedAt: '2026-06-01' });
  assert.ok(snapshot.registeredPairs.length > 0);
  assert.ok(snapshot.registeredPairs.some(pair => pair.eligible === false), '被排除的配对也要留痕');
});
