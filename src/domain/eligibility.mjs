/**
 * 配对与站点可用性。
 *
 * 比较单位是**事先登记的站点观测窗**（matches 表给出候选配对，不是配对已通过的
 * 标记）。一个配对要成为可比较证据，必须同时满足：
 *
 *   配对层：同一分区；同一季节；云量条件相同（clear 与 cloud 分开比较）；非雨天；
 *           两窗月光差不超过登记上限；在所选分组下确有明/暗对照。
 *   站点层：两窗读数都达到该站整晚最少读数；两夜校准在审阅时点均有效；站点的
 *           其它受影响步道在两夜间档位没有变化（否则它是被污染的，不能当对照）。
 *
 * ## 分组
 * 默认按**排期**（planned）分组：安全事件把灯具改回亮档时，该窗仍留在原登记分组，
 * 依从性单独报告。这样不会因为事后改档把失败改成成功；代价是估计量变成「意向
 * 处理」（ITT），若现场其实没有造成明暗差，效应会被稀释，必须另行标注。
 * 也可按 actual 分组做「实际执行」敏感性分析。
 *
 * ## 污染与跨片区耦合
 * 污染判定用**实际交付档位**（actual），因为读数反映的是现场真正的光。某站若同时
 * 受两条步道影响，另一片区排期一改，它在本片区配对里就可能从「干净」变「污染」，
 * 或反过来。这就是两片区排期相互影响证据可用性的机制。
 *
 * ## 参考站
 * 参考站指**不受本处理步道影响**的站。它若受另一条步道影响、但该步道在两夜间
 * 档位不变，仍可作为本对比的对照（该影响在差分中被消掉）。若该步道也变化，则
 * 参考站被污染，不能充当「未受影响的对照」。
 */
import { resolveCalibration, CALIBRATION_STATUS } from './calibration.mjs';
import { deliveredSetting, readingsFor } from './dataset.mjs';

export const PAIR_ISSUE = Object.freeze({
  UNKNOWN_WINDOW: 'unknown_window',
  SELF_PAIR: 'self_pair',
  ZONE_MISMATCH: 'zone_mismatch',
  RAIN: 'rain',
  WEATHER_MISMATCH: 'weather_mismatch',
  SEASON_MISMATCH: 'season_mismatch',
  MOON_GAP: 'moon_gap',
  NO_CONTRAST: 'no_contrast',
});

export const STATION_ISSUE = Object.freeze({
  READINGS_MISSING: 'readings_missing',
  READINGS_INSUFFICIENT_TREATED: 'readings_insufficient_treated',
  READINGS_INSUFFICIENT_CONTROL: 'readings_insufficient_control',
  CALIBRATION_INVALID_TREATED: 'calibration_invalid_treated',
  CALIBRATION_INVALID_CONTROL: 'calibration_invalid_control',
  CALIBRATION_PENDING_TREATED: 'calibration_pending_treated',
  CALIBRATION_PENDING_CONTROL: 'calibration_pending_control',
  CALIBRATION_UNCOVERED_TREATED: 'calibration_uncovered_treated',
  CALIBRATION_UNCOVERED_CONTROL: 'calibration_uncovered_control',
  CONTAMINATED: 'contaminated',
});

/**
 * 某站受哪条「其它步道」影响且该步道在两夜间实际档位发生变化。
 * 只统计两夜都能确认交付档位的步道。
 */
export function changingPaths(dataset, station, treatedPath, nightA, nightB) {
  return station.affectedPaths.filter(other => {
    if (other === treatedPath) return false;
    const a = deliveredSetting(dataset, other, nightA);
    const b = deliveredSetting(dataset, other, nightB);
    return a !== null && b !== null && a !== b;
  });
}

/**
 * 评估一个登记配对。
 *
 * @returns {{
 *   eligible: boolean,
 *   pairIssues: string[],
 *   pair: object|null,
 *   stations: Map<string, object>,
 *   treated: string[],
 *   reference: string[],
 * }}
 */
export function evaluatePair(dataset, match, { grouping = 'planned', asOf = dataset.asOf } = {}) {
  const left = dataset.windowsByName.get(match.leftWindow);
  const right = dataset.windowsByName.get(match.rightWindow);

  if (!left || !right) return failed(dataset, [PAIR_ISSUE.UNKNOWN_WINDOW]);
  if (left.window === right.window) return failed(dataset, [PAIR_ISSUE.SELF_PAIR]);

  const pairIssues = [];
  if (left.zone !== right.zone) pairIssues.push(PAIR_ISSUE.ZONE_MISMATCH);
  if (left.weather === 'rain' || right.weather === 'rain') pairIssues.push(PAIR_ISSUE.RAIN);
  if (left.weather !== right.weather) pairIssues.push(PAIR_ISSUE.WEATHER_MISMATCH);

  const seasonLeft = dataset.seasonByNight.get(left.night)?.season ?? null;
  const seasonRight = dataset.seasonByNight.get(right.night)?.season ?? null;
  if (seasonLeft !== seasonRight) pairIssues.push(PAIR_ISSUE.SEASON_MISMATCH);

  if (Math.abs(left.moon - right.moon) > match.maxMoonGap) pairIssues.push(PAIR_ISSUE.MOON_GAP);

  const groupLeft = left[grouping];
  const groupRight = right[grouping];
  if (groupLeft === groupRight || groupLeft === '' || groupRight === '') {
    pairIssues.push(PAIR_ISSUE.NO_CONTRAST);
  }

  if (pairIssues.length > 0) return failed(dataset, pairIssues);

  const treatedPath = dataset.paths.find(candidate => candidate.zone === left.zone)?.path;
  if (!treatedPath) return failed(dataset, [PAIR_ISSUE.ZONE_MISMATCH]);

  const lowWindow = groupLeft === 'low' ? left : right;
  const normalWindow = groupLeft === 'low' ? right : left;
  const lowNight = lowWindow.night;
  const normalNight = normalWindow.night;

  const stations = new Map();
  for (const station of dataset.stations) {
    stations.set(
      station.station,
      assessStation(dataset, station, {
        treatedPath,
        lowWindow,
        normalWindow,
        lowNight,
        normalNight,
        asOf,
      })
    );
  }

  const treated = [...stations.values()]
    .filter(entry => entry.role === 'treated' && entry.usable)
    .map(entry => entry.station);
  const reference = [...stations.values()]
    .filter(entry => entry.role === 'reference' && entry.usable)
    .map(entry => entry.station);

  const deliveredLow = deliveredSetting(dataset, treatedPath, lowNight);
  const deliveredNormal = deliveredSetting(dataset, treatedPath, normalNight);
  const deliveredDiffer = deliveredLow !== null && deliveredNormal !== null
    ? deliveredLow !== deliveredNormal
    : null;

  // 有可用处理站却没有可用参考站：对照缺失或被污染，这一配对做不了差值-差分。
  // 单独标出，避免它悄悄退化成「没有观测」而不被追问。
  const referenceStatus = reference.length > 0
    ? 'usable'
    : treated.length > 0
      ? 'missing'
      : 'not_needed';
  const usable = treated.length > 0 && reference.length > 0;

  const plannedLow = lowWindow.planned;
  const plannedNormal = normalWindow.planned;
  const actualLow = lowWindow.actual;
  const actualNormal = normalWindow.actual;

  return {
    eligible: true,
    usable,
    referenceStatus,
    pairIssues: [],
    pair: {
      pairId: `${left.window}-${right.window}`,
      match,
      zone: left.zone,
      path: treatedPath,
      weather: left.weather,
      season: seasonLeft === seasonRight ? seasonLeft : null,
      moonGap: Math.abs(left.moon - right.moon),
      lowWindow: lowWindow.window,
      normalWindow: normalWindow.window,
      lowNight,
      normalNight,
      nights: [...new Set([lowNight, normalNight])].sort((a, b) => a - b),
      grouping,
      deliveredDiffer,
      compliance: {
        lowWindow: { planned: plannedLow, actual: actualLow, interruptions: lowWindow.interruption },
        normalWindow: { planned: plannedNormal, actual: actualNormal, interruptions: normalWindow.interruption },
      },
    },
    stations,
    treated,
    reference,
  };

  function failed(ds, issues) {
    return {
      eligible: false,
      usable: false,
      referenceStatus: 'not_needed',
      pairIssues: issues,
      pair: describeFailedPair(ds, match),
      stations: new Map(),
      treated: [],
      reference: [],
    };
  }
}

/** 即使配对不合格，也给出它的分区/夜/天气，便于覆盖率报告归类。 */
function describeFailedPair(dataset, match) {
  const left = dataset.windowsByName.get(match.leftWindow);
  const right = dataset.windowsByName.get(match.rightWindow);
  if (!left && !right) return null;
  const anchor = left ?? right;
  return {
    pairId: `${match.leftWindow}-${match.rightWindow}`,
    zone: anchor.zone,
    weather: left && right && left.weather === right.weather ? left.weather : null,
    season: left && right
      ? dataset.seasonByNight.get(left.night)?.season === dataset.seasonByNight.get(right.night)?.season
        ? dataset.seasonByNight.get(left.night)?.season ?? null
        : null
      : null,
    lowWindow: null,
    normalWindow: null,
    nights: left && right ? [...new Set([left.night, right.night])].sort((a, b) => a - b) : [],
  };
}

function assessStation(dataset, station, context) {
  const { treatedPath, lowWindow, normalWindow, lowNight, normalNight, asOf } = context;
  const issues = [];
  const treated = station.affectedPaths.includes(treatedPath);
  const role = treated ? 'treated' : 'reference';

  const lowReadings = readingsFor(dataset, lowWindow.window, station.station);
  const normalReadings = readingsFor(dataset, normalWindow.window, station.station);
  if (lowReadings.length === 0 || normalReadings.length === 0) {
    issues.push(STATION_ISSUE.READINGS_MISSING);
  } else {
    if (lowReadings.length < station.nightMinReadings) {
      issues.push(STATION_ISSUE.READINGS_INSUFFICIENT_TREATED);
    }
    if (normalReadings.length < station.nightMinReadings) {
      issues.push(STATION_ISSUE.READINGS_INSUFFICIENT_CONTROL);
    }
  }

  const records = dataset.calibrationByKey.get(station.calibration) ?? [];
  const calibrationLow = resolveCalibration(records, lowNight, asOf);
  const calibrationNormal = resolveCalibration(records, normalNight, asOf);
  pushCalibrationIssue(issues, calibrationLow, 'TREATED');
  pushCalibrationIssue(issues, calibrationNormal, 'CONTROL');

  // 参考站若也受本处理步道影响，就不是「未受影响的对照」——先前的 treated 判定已
  // 把它排除在外。此处只处理「其它步道在两夜间变化」的污染。
  const changed = changingPaths(dataset, station, treatedPath, lowNight, normalNight);
  if (changed.length > 0) {
    issues.push(`${STATION_ISSUE.CONTAMINATED}:${changed.join('|')}`);
  }

  return {
    station: station.station,
    zone: station.zone,
    affectedPaths: station.affectedPaths,
    role,
    issues,
    usable: issues.length === 0,
    counts: { low: lowReadings.length, normal: normalReadings.length },
    calibration: {
      treated: calibrationLow.status,
      control: calibrationNormal.status,
    },
    contaminatedBy: changed,
  };
}

function pushCalibrationIssue(issues, resolved, suffix) {
  if (resolved.status === CALIBRATION_STATUS.VALID) return;
  const map = {
    [CALIBRATION_STATUS.INVALID]: STATION_ISSUE[`CALIBRATION_INVALID_${suffix}`],
    [CALIBRATION_STATUS.PENDING]: STATION_ISSUE[`CALIBRATION_PENDING_${suffix}`],
    [CALIBRATION_STATUS.UNCOVERED]: STATION_ISSUE[`CALIBRATION_UNCOVERED_${suffix}`],
  };
  issues.push(map[resolved.status]);
}

/** 评估全部登记配对，保持 matches 表顺序。 */
export function evaluateAllPairs(dataset, options = {}) {
  return dataset.matches.map(match => evaluatePair(dataset, match, options));
}
