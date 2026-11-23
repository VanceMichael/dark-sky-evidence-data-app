/**
 * 审阅台账：保留「当时实际审阅的版本」与「后来更正后的版本」。
 *
 * 业务要求：校准记录可能在会议后才确认并更正观测有效期。夜班需要核对现场当时按
 * 什么方案运行，因此**不能用新资料覆盖旧结论**。每次审阅都作为一条不可变的快照
 * 存下：
 *   - `reviewedAt`：审阅日期；
 *   - `asOf`：当时已知到哪一夜（校准可知范围）；
 *   - `signedSettings`：该次审阅时，各片区按排期签准/现场运行的档位；
 *   - `zones`：当时的结论与分层证据；
 *   - `approved`：当时是否据此批准了试行。
 *
 * 后续资料到达后，`diffReviews` 给出两次审阅之间的变化，并区分：
 *   - `stillValid`：仍有效的安全安排（硬约束、签准档位中未被推翻的部分）；
 *   - `needsReconsideration`：需要重新审议的结论（结论码或分层状态改变）；
 *   - `calibrationCorrections`：校准更正影响了哪些夜。
 */

import { review } from './review.mjs';
import { resolveCalibration } from './calibration.mjs';
import { evaluateAllPairs } from './eligibility.mjs';

/**
 * 生成一条审阅快照。
 *
 * @param {object} dataset 以给定 `asOf` 加载的资料集
 * @param {{reviewedAt: string, approved?: object, thresholds?: object, grouping?: string, note?: string}} meta
 */
export function captureReview(dataset, meta) {
  const result = review(dataset, { grouping: meta.grouping, thresholds: meta.thresholds });
  const zones = [...result.byZone.values()].map(zone => ({
    zone: zone.zone,
    path: zone.path,
    conclusion: zone.conclusion,
    safety: zone.safety,
    compliance: zone.compliance,
    trial: zone.trial,
    eligibility: zone.eligibility,
    strata: zone.strata.map(stratum => ({
      season: stratum.season,
      weather: stratum.weather,
      status: stratum.status,
      n: stratum.n,
      pairs: stratum.pairs,
      nights: stratum.nights,
      mean: stratum.mean,
      low: stratum.low,
      high: stratum.high,
      stations: stratum.stations,
    })),
  }));

  return Object.freeze({
    reviewedAt: meta.reviewedAt,
    asOf: dataset.asOf,
    grouping: result.grouping,
    thresholds: result.thresholds,
    signedSettings: signedSettings(dataset),
    calibrationState: calibrationState(dataset),
    pairState: pairState(result),
    registeredPairs: registeredPairState(dataset, result),
    zones,
    approved: meta.approved ?? null,
    note: meta.note ?? null,
  });
}

/**
 * 记录每个被采纳观测（配对 × 处理站）在该审阅时点的效应，便于后来定位是哪一处
 * 更正改变了结论所依据的样本。
 */
export function pairState(result) {
  return result.observations.map(observation => ({
    pairId: observation.pairId,
    zone: observation.zone,
    station: observation.station,
    lowWindow: observation.lowWindow,
    normalWindow: observation.normalWindow,
    nights: observation.nights,
    effect: observation.effect,
  }));
}

/**
 * 记录审阅时点各站校准在观测夜上的已知状态。
 *
 * 这是「当时实际审阅的版本」的一部分：即使结论不变，也必须能证明当时按哪一版
 * 校准判定哪些夜可用。后来补录的更正会在这里体现为状态变化。
 */
export function calibrationState(dataset) {
  const state = [];
  for (const station of dataset.stations) {
    const records = dataset.calibrationByKey.get(station.calibration) ?? [];
    for (const window of dataset.windows) {
      const resolved = resolveCalibration(records, window.night, dataset.asOf);
      if (resolved.status === 'uncovered') continue;
      state.push({
        station: station.station,
        calibration: station.calibration,
        night: window.night,
        status: resolved.status,
        revision: resolved.revision,
      });
    }
  }
  return state;
}

/**
 * 从「现场实际交付」角度记录签准档位：每个片区、每夜的 actual 档位，以及登记最低
 * 档位。夜班据此核对现场当时按什么方案运行。
 */
export function signedSettings(dataset) {
  const byZone = new Map();
  for (const window of dataset.windows) {
    const entry = byZone.get(window.zone) ?? {
      zone: window.zone,
      minimum: dataset.operationsByZone.get(window.zone)?.minimum ?? null,
      patrolCoverage: dataset.operationsByZone.get(window.zone)?.patrolCoverage ?? null,
      nights: new Map(),
    };
    // 同一夜同片区只有一个窗口（dataset 已校验）。
    entry.nights.set(window.night, {
      window: window.window,
      planned: window.planned,
      actual: window.actual,
      interruptions: window.interruption,
    });
    byZone.set(window.zone, entry);
  }
  return [...byZone.values()].map(entry => ({
    zone: entry.zone,
    minimum: entry.minimum,
    patrolCoverage: entry.patrolCoverage,
    nights: [...entry.nights.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([night, value]) => ({ night, ...value })),
  }));
}

/**
 * 比较两次审阅。
 *
 * @param {object} before 较早的快照
 * @param {object} after 较晚的快照
 */
export function diffReviews(before, after) {
  const beforeZones = new Map(before.zones.map(zone => [zone.zone, zone]));
  const afterZones = new Map(after.zones.map(zone => [zone.zone, zone]));
  const zones = [...new Set([...beforeZones.keys(), ...afterZones.keys()])].sort();

  const zoneDiffs = zones.map(zone => {
    const a = beforeZones.get(zone);
    const b = afterZones.get(zone);
    if (!a || !b) return { zone, added: !a, removed: !b };
    const stratumChanges = diffStrata(a.strata, b.strata);
    const conclusionChanged = a.conclusion.code !== b.conclusion.code
      || JSON.stringify(a.conclusion.reasons) !== JSON.stringify(b.conclusion.reasons);
    return {
      zone,
      conclusionBefore: a.conclusion.code,
      conclusionAfter: b.conclusion.code,
      conclusionChanged,
      stratumChanges,
      safetyBefore: a.safety.lowIsSafe,
      safetyAfter: b.safety.lowIsSafe,
      safetyIssuesBefore: a.safety.issues,
      safetyIssuesAfter: b.safety.issues,
    };
  });

  const calibrationCorrections = diffCalibrationState(before.calibrationState ?? [], after.calibrationState ?? []);
  const signedChanges = diffSignedSettings(before.signedSettings, after.signedSettings);
  const sampleChanges = diffPairState(before.pairState ?? [], after.pairState ?? []);
  const correctionsWithImpact = linkCorrections(calibrationCorrections, before, after, sampleChanges);

  const stillValid = [];
  const needsReconsideration = [];
  for (const diff of zoneDiffs) {
    if (diff.added || diff.removed) {
      needsReconsideration.push(`${diff.zone}: 片区记录增删`);
      continue;
    }
    if (!diff.safetyAfter && diff.safetyBefore) {
      // 安全约束由通过变为不通过：原安全安排不再有效，必须重议。
      needsReconsideration.push(`${diff.zone}: 安全约束不再满足（${diff.safetyIssuesAfter.join(', ')}）`);
    } else if (!diff.safetyAfter && !diff.safetyBefore) {
      // 两次都不通过：维持原有的阻断，不是本次新出现的需重议项。
      if (diff.safetyIssuesBefore.join(',') !== diff.safetyIssuesAfter.join(',')) {
        needsReconsideration.push(`${diff.zone}: 安全约束阻断理由变化`);
      } else {
        stillValid.push(`${diff.zone}: 安全阻断维持（${diff.safetyIssuesAfter.join(', ')}）`);
      }
    } else if (diff.safetyIssuesBefore.join(',') !== diff.safetyIssuesAfter.join(',')) {
      needsReconsideration.push(`${diff.zone}: 安全约束状态变化`);
    } else {
      stillValid.push(`${diff.zone}: 安全约束与签准最低档位仍有效`);
    }
    if (diff.conclusionChanged) {
      needsReconsideration.push(
        `${diff.zone}: 结论由 ${diff.conclusionBefore} 变为 ${diff.conclusionAfter}`
      );
    }
    for (const change of diff.stratumChanges) {
      if (change.before !== change.after) {
        needsReconsideration.push(
          `${diff.zone} ${change.season}/${change.weather}: 分层状态由 ${change.before} 变为 ${change.after}`
        );
      }
    }
  }

  return {
    before: { reviewedAt: before.reviewedAt, asOf: before.asOf },
    after: { reviewedAt: after.reviewedAt, asOf: after.asOf },
    calibrationCorrections: correctionsWithImpact,
    signedChanges,
    sampleChanges,
    zoneDiffs,
    stillValid: [...new Set(stillValid)],
    needsReconsideration: [...new Set(needsReconsideration)],
    approvalImpact: approvalImpact(before, after, needsReconsideration),
  };
}

function diffStrata(beforeStrata, afterStrata) {
  const key = stratum => `${stratum.season}/${stratum.weather}`;
  const beforeMap = new Map(beforeStrata.map(stratum => [key(stratum), stratum]));
  const afterMap = new Map(afterStrata.map(stratum => [key(stratum), stratum]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])];
  return keys.map(name => ({
    season: beforeMap.get(name)?.season ?? afterMap.get(name)?.season,
    weather: beforeMap.get(name)?.weather ?? afterMap.get(name)?.weather,
    before: beforeMap.get(name)?.status ?? 'absent',
    after: afterMap.get(name)?.status ?? 'absent',
    beforeStats: statsOf(beforeMap.get(name)),
    afterStats: statsOf(afterMap.get(name)),
  }));
}

function statsOf(stratum) {
  if (!stratum) return null;
  return { n: stratum.n, pairs: stratum.pairs, nights: stratum.nights, mean: stratum.mean };
}

/**
 * 签准档位的变化：哪些夜、哪个片区的实际档位因排期覆盖而改变。
 */
function diffSignedSettings(beforeSettings, afterSettings) {
  const beforeMap = new Map(beforeSettings.map(entry => [entry.zone, entry]));
  const afterMap = new Map(afterSettings.map(entry => [entry.zone, entry]));
  const corrections = [];
  for (const [zone, beforeEntry] of beforeMap) {
    const afterEntry = afterMap.get(zone);
    if (!afterEntry) {
      corrections.push({ zone, change: 'removed' });
      continue;
    }
    const beforeNights = new Map(beforeEntry.nights.map(night => [night.night, night]));
    const afterNights = new Map(afterEntry.nights.map(night => [night.night, night]));
    for (const [night, beforeNight] of beforeNights) {
      const afterNight = afterNights.get(night);
      if (!afterNight) continue;
      if (beforeNight.actual !== afterNight.actual || beforeNight.planned !== afterNight.planned) {
        corrections.push({
          zone,
          night,
          window: beforeNight.window,
          before: { planned: beforeNight.planned, actual: beforeNight.actual },
          after: { planned: afterNight.planned, actual: afterNight.actual },
        });
      }
    }
  }
  return corrections;
}

/**
 * 若此前已批准试行，后来出现的需要重新审议项会直接影响批准。
 */
function approvalImpact(before, after, needsReconsideration) {
  if (!before.approved) return { approvedBefore: null, status: 'no_prior_approval' };
  const affectedZones = [...new Set(
    needsReconsideration
      .map(item => item.split(':')[0])
      .filter(zone => before.approved.zones?.includes(zone))
  )];
  if (affectedZones.length === 0) {
    return { approvedBefore: before.approved, status: 'unchanged' };
  }
  return {
    approvedBefore: before.approved,
    status: 'reconsider',
    affectedZones,
    message: `已批准试行涉及 ${affectedZones.join('、')}，需重新审议`,
  };
}

/**
 * 台账：按时间追加快照，支持「回到会议当时看到的那一版」。
 */
export function createLedger() {
  const entries = [];
  return {
    entries,
    add(snapshot) {
      entries.push(snapshot);
      return snapshot;
    },
    /** 取某日期及以前的最后一条快照（当时实际看到的那一版）。 */
    at(date) {
      const eligible = entries.filter(entry => entry.reviewedAt <= date);
      return eligible.length > 0 ? eligible[eligible.length - 1] : null;
    },
    latest() {
      return entries.length > 0 ? entries[entries.length - 1] : null;
    },
    /** 相邻两次快照的差异序列。 */
    trail() {
      return entries.slice(1).map((entry, index) => diffReviews(entries[index], entry));
    },
  };
}

/**
 * 校准状态的逐站逐夜变化：哪些观测夜的有效性因会后补录而更正。
 *
 * 只有两边都记录到的站-夜才比较；新增记录（当时对某夜无任何记录）会标注 `added`。
 */
export function diffCalibrationState(before, after) {
  const key = item => `${item.station}\u0000${item.night}`;
  const beforeMap = new Map(before.map(item => [key(item), item]));
  const afterMap = new Map(after.map(item => [key(item), item]));
  const changes = [];
  for (const [name, beforeItem] of beforeMap) {
    const afterItem = afterMap.get(name);
    if (!afterItem) {
      changes.push({ ...beforeItem, direction: 'removed' });
      continue;
    }
    if (beforeItem.status !== afterItem.status || beforeItem.revision !== afterItem.revision) {
      changes.push({
        station: beforeItem.station,
        calibration: beforeItem.calibration,
        night: beforeItem.night,
        before: { status: beforeItem.status, revision: beforeItem.revision },
        after: { status: afterItem.status, revision: afterItem.revision },
        direction: 'corrected',
      });
    }
  }
  for (const [name, afterItem] of afterMap) {
    if (!beforeMap.has(name)) {
      changes.push({
        station: afterItem.station,
        calibration: afterItem.calibration,
        night: afterItem.night,
        before: null,
        after: { status: afterItem.status, revision: afterItem.revision },
        direction: 'added',
      });
    }
  }
  return changes.sort((a, b) => a.night - b.night || a.station.localeCompare(b.station));
}

/**
 * 被采纳观测的变化：哪些配对 × 处理站的效应被新增或移除。
 * 用于回答「新证据影响了哪一条步道的哪次试行」。
 */
export function diffPairState(before, after) {
  const key = item => `${item.pairId}\u0000${item.station}`;
  const beforeMap = new Map(before.map(item => [key(item), item]));
  const afterMap = new Map(after.map(item => [key(item), item]));
  const added = [];
  const removed = [];
  for (const [name, item] of afterMap) {
    if (!beforeMap.has(name)) added.push(item);
  }
  for (const [name, item] of beforeMap) {
    if (!afterMap.has(name)) removed.push(item);
  }
  return {
    added: added.sort(byZonePair),
    removed: removed.sort(byZonePair),
  };
}

function byZonePair(a, b) {
  return a.zone.localeCompare(b.zone) || a.pairId.localeCompare(b.pairId) || a.station.localeCompare(b.station);
}

/**
 * 给每条校准更正挂上它触及的配对：登记配对中，有窗口落在被更正夜的都算相关，
 * 并标注该配对在更正后是否仍被采纳（`usedBefore`/`usedAfter`）。
 */
export function linkCorrections(corrections, before, after, sampleChanges) {
  const changed = sampleChanges.added.length > 0 || sampleChanges.removed.length > 0;
  const registeredBefore = new Map((before.registeredPairs ?? []).map(pair => [pair.pairId, pair]));
  const registeredAfter = new Map((after.registeredPairs ?? []).map(pair => [pair.pairId, pair]));

  return corrections.map(correction => {
    const affected = new Map();
    const note = (pair, label) => {
      if (!pair || !pair.nights.includes(correction.night)) return;
      const entry = affected.get(pair.pairId) ?? {
        pairId: pair.pairId,
        zone: pair.zone,
        eligibleBefore: false,
        eligibleAfter: false,
        stationIssuesBefore: [],
        stationIssuesAfter: [],
      };
      if (label === 'before') {
        entry.eligibleBefore = pair.eligible;
        entry.stationIssuesBefore = pair.stations
          .filter(station => station.station === correction.station)
          .flatMap(station => station.issues)
          .sort();
      } else {
        entry.eligibleAfter = pair.eligible;
        entry.stationIssuesAfter = pair.stations
          .filter(station => station.station === correction.station)
          .flatMap(station => station.issues)
          .sort();
      }
      affected.set(pair.pairId, entry);
    };
    for (const pair of registeredBefore.values()) note(pair, 'before');
    for (const pair of registeredAfter.values()) note(pair, 'after');

    return {
      ...correction,
      affectedPairs: [...affected.values()].sort((a, b) => a.pairId.localeCompare(b.pairId)),
      changedAdoptedSample: changed,
    };
  });
}

/**
 * 全部登记配对的资格快照（不只被采纳的观测）：配对 id、涉及的夜、是否通过配对筛选、
 * 各站是否可用。校准更正即使没改变最终结论，也能在这里定位到它触及哪些配对。
 */
export function registeredPairState(dataset, result) {
  // result.observations 只含被采纳观测；这里重新评估以保留被排除的配对。
  const evaluated = evaluateAllPairs(dataset, { grouping: result.grouping, asOf: dataset.asOf });
  return evaluated.map(pair => ({
    pairId: pair.pair?.pairId ?? null,
    zone: pair.pair?.zone ?? null,
    lowWindow: pair.pair?.lowWindow ?? null,
    normalWindow: pair.pair?.normalWindow ?? null,
    nights: pair.pair?.nights ?? [],
    eligible: pair.eligible,
    usable: pair.usable ?? false,
    referenceStatus: pair.referenceStatus ?? null,
    pairIssues: pair.pairIssues,
    stations: [...pair.stations.values()].map(station => ({
      station: station.station,
      usable: station.usable,
      role: station.role,
      issues: station.issues,
    })),
  }));
}
