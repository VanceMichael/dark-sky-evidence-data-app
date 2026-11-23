/**
 * 方案组合与跨片区耦合。
 *
 * 审查员要同时比较「两个片区排期搭在一起」的效果，并在改动其中一个片区后知道
 * 另一个片区原有结论是否仍适用。
 *
 * ## 为什么改一个片区会动另一个片区的证据
 * 某站若同时受两条步道影响（例如 S1 受 W|E），它能否在本片区配对里充当干净处理站，
 * 取决于**另一条步道在两夜之间是否换了档**。因此另一片区的排期一变，本片区的可用
 * 处理站集合、合格配对数、甚至结论都可能改变。这不是统计噪声，是实验设计耦合。
 *
 * 本模块用「覆盖排期」在内存里构造候选方案（不改原始资料），对每个方案重算审查，
 * 并给出：
 *   - 单片区改动对自身结论的影响；
 *   - 对另一片区结论的影响（`crossZone`）——判定原结论是否仍适用；
 *   - 组合方案之间并排比较。
 */

import { buildDataset } from './dataset.mjs';
import { review } from './review.mjs';

/**
 * 在已加载资料上施加排期覆盖。
 *
 * @param {object} dataset 原始（未覆盖）资料集
 * @param {Array<{window?: string, night?: number, zone?: string, actual?: string, planned?: string}>} overrides
 *   每条按窗口名，或按「夜 + 片区」定位要改的窗口；`actual`/`planned` 给出新档位
 * @returns {object} 新资料集（原资料不变）
 */
export function applySchedule(dataset, overrides) {
  const byWindow = new Map(overrides.filter(o => o.window).map(o => [o.window, o]));
  const byNightZone = new Map(
    overrides
      .filter(o => !o.window && o.night !== undefined && o.zone)
      .map(o => [`${o.night}\u0000${o.zone}`, o])
  );

  const windows = dataset.windows.map(window => {
    const override = byWindow.get(window.window) ?? byNightZone.get(`${window.night}\u0000${window.zone}`);
    if (!override) return window;
    return {
      ...window,
      actual: override.actual !== undefined ? override.actual : window.actual,
      planned: override.planned !== undefined ? override.planned : window.planned,
    };
  });

  return rebuild(dataset, windows);
}

/**
 * 固定某片区整段排期为某一档（常用于「另一片区保持不变」的对照方案）。
 */
export function pinZone(dataset, zone, setting) {
  const windows = dataset.windows.map(window =>
    window.zone === zone ? { ...window, actual: setting } : window
  );
  return rebuild(dataset, windows);
}

function rebuild(dataset, windows) {
  const raw = {
    paths: dataset.paths.map(toRawPath),
    season: dataset.seasons.map(toRawSeason),
    stations: dataset.stations.map(toRawStation),
    calibration: dataset.calibrationRecords.map(toRawCalibration),
    windows: windows.map(toRawWindow),
    readings: dataset.readings.map(toRawReading),
    matches: dataset.matches.map(toRawMatch),
    operations: dataset.operations.map(toRawOperation),
  };
  return buildDataset(raw, { asOf: dataset.asOf });
}

// 覆盖排期时沿用原始行号，便于错误定位回原资料。
function toRawPath(row) {
  return { path: row.path, zone: row.zone, low_lux: row.lowLux, normal_lux: row.normalLux, emergency_min_lux: row.emergencyMinLux, line: row.line };
}
function toRawSeason(row) {
  return { night: row.night, season: row.season, observation_zone: row.observationZone, min_safety_lux: row.minSafetyLux, line: row.line };
}
function toRawStation(row) {
  return {
    station: row.station,
    zone: row.zone,
    affected_paths: row.affectedPaths.length === 0 ? '-' : row.affectedPaths.join('|'),
    calibration: row.calibration,
    night_min_readings: row.nightMinReadings,
    line: row.line,
  };
}
function toRawCalibration(row) {
  return {
    calibration: row.calibration,
    revision: row.revision,
    known_night: row.knownNight,
    first_night: row.firstNight,
    last_night: row.lastNight,
    valid: row.valid ? 'true' : 'false',
    line: row.line,
  };
}
function toRawWindow(row) {
  return {
    window: row.window,
    night: row.night,
    start: row.start,
    zone: row.zone,
    planned: row.planned,
    actual: row.actual,
    weather: row.weather,
    moon: row.moon,
    interruption: row.interruption.length === 0 ? '-' : row.interruption.join('|'),
    line: row.line,
  };
}
function toRawReading(row) {
  return { window: row.window, station: row.station, minute: row.minute, mag_arcsec2: row.magArcsec2, line: row.line };
}
function toRawMatch(row) {
  return { left_window: row.leftWindow, right_window: row.rightWindow, max_moon_gap: row.maxMoonGap, line: row.line };
}
function toRawOperation(row) {
  return {
    zone: row.zone,
    path: row.path,
    minimum: row.minimum,
    patrol_coverage: row.patrolCoverage,
    signed_window: row.signedWindow ?? '-',
    signed_night: row.signedNight ?? '-',
    line: row.line,
  };
}

/**
 * 比较两个方案的审查结论。
 *
 * @param {{name: string, dataset: object}} left
 * @param {{name: string, dataset: object}} right
 * @param {object} options 传给 review 的选项
 */
export function compareScenarios(left, right, options = {}) {
  const before = review(left.dataset, options);
  const after = review(right.dataset, options);

  const zones = [...new Set([...before.byZone.keys(), ...after.byZone.keys()])].sort();
  const changes = zones.map(zone => {
    const a = before.byZone.get(zone);
    const b = after.byZone.get(zone);
    const stationsBefore = a ? usedStations(before, zone) : [];
    const stationsAfter = b ? usedStations(after, zone) : [];
    return {
      zone,
      before: a ? conclusionOf(a) : null,
      after: b ? conclusionOf(b) : null,
      changed: a && b ? conclusionOf(a).code !== conclusionOf(b).code
        || JSON.stringify(conclusionOf(a).strata) !== JSON.stringify(conclusionOf(b).strata) : true,
      evidenceBefore: a?.evidence ?? null,
      evidenceAfter: b?.evidence ?? null,
      eligibleBefore: a?.eligibility.eligible ?? null,
      eligibleAfter: b?.eligibility.eligible ?? null,
      stationsBefore,
      stationsAfter,
      stationsGained: stationsAfter.filter(station => !stationsBefore.includes(station)),
      stationsLost: stationsBefore.filter(station => !stationsAfter.includes(station)),
    };
  });

  const mechanism = explainCoupling(right.dataset, changes);

  return {
    left: left.name,
    right: right.name,
    changes,
    changedZones: changes.filter(change => change.changed).map(change => change.zone),
    mechanism,
    // 若右方案只改了一个片区，另一个片区在 changes 里若 changed=true，即「原结论
    // 不再适用」，必须重新审议。
    reviewed: after,
    baseline: before,
  };
}

/** 某次审查中，某片区实际采纳了哪些处理站。 */
function usedStations(result, zone) {
  return [...new Set(
    result.observations
      .filter(observation => observation.zone === zone)
      .map(observation => observation.station)
  )].sort();
}

/**
 * 解释跨片区耦合的机制：哪些站同时受多条步道影响，因此另一片区排期一改，
 * 它在本片区配对里的污染状态就可能翻转。
 */
function explainCoupling(dataset, changes) {
  const shared = dataset.stations
    .filter(station => station.affectedPaths.length > 1)
    .map(station => ({
      station: station.station,
      affectedPaths: station.affectedPaths,
      zones: [...new Set(station.affectedPaths.map(path => dataset.pathsByKey.get(path)?.zone).filter(Boolean))],
    }));
  const affectedZones = changes
    .filter(change => change.changed || change.stationsGained.length > 0 || change.stationsLost.length > 0)
    .map(change => change.zone);
  return {
    sharedStations: shared,
    affectedZones,
    explanation: shared.length === 0
      ? '没有同时受多条步道影响的站点，两片区排期相互独立。'
      : `站点 ${shared.map(entry => `${entry.station}（${entry.affectedPaths.join('|')}）`).join('、')} `
        + '同时受不同片区的步道影响；改变其中一个片区会改变这些站在另一片区配对中的污染状态，'
        + '从而改变另一片区可用的处理站与证据。',
  };
}

function conclusionOf(zoneReview) {
  return {
    code: zoneReview.conclusion.code,
    reasons: zoneReview.conclusion.reasons,
    strata: zoneReview.strata.map(stratum => ({
      season: stratum.season,
      weather: stratum.weather,
      status: stratum.status,
      n: stratum.n,
      pairs: stratum.pairs,
      nights: stratum.nights,
      mean: stratum.mean,
      low: stratum.low,
      high: stratum.high,
    })),
  };
}

/**
 * 枚举若干方案组合并两两/整体比较，供审查员并排查看。
 *
 * @param {Array<{name: string, overrides?: Array, dataset?: object}>} scenarios
 */
export function compareCombinations(scenarios, baseDataset, options = {}) {
  const built = scenarios.map(scenario => ({
    name: scenario.name,
    dataset: scenario.dataset ?? (scenario.overrides ? applySchedule(baseDataset, scenario.overrides) : baseDataset),
  }));
  const reviews = built.map(scenario => ({ name: scenario.name, review: review(scenario.dataset, options) }));

  const baseline = built[0];
  const pairwise = built.slice(1).map(candidate => compareScenarios(baseline, candidate, options));

  return {
    scenarios: reviews.map(entry => ({
      name: entry.name,
      zones: [...entry.review.byZone.values()].map(zone => ({
        zone: zone.zone,
        conclusion: zone.conclusion,
        evidence: zone.evidence,
        eligible: zone.eligibility.eligible,
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
      })),
    })),
    pairwise,
  };
}
