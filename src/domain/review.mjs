/**
 * 审查与建议。
 *
 * 把「测到什么」与「能不能调」分开：
 *
 * - `evidence`：这一片区在各 (季节, 云量) 分层上是否测到了可归因于调暗的亮度变化。
 * - `constraints`：应急最低档位、巡查覆盖、路径应急照度与季节下限是否允许调暗。
 *
 * **建议从不把「没有测到收益」写成「可以恢复高亮」。** 若证据不足或对照被污染，
 * 结论固定为 `insufficient_evidence`，并列出仍需补录哪类时窗；只有三件事同时成立
 * 才给 `supported`：区间整体高于 0、分层覆盖足够、硬约束全部通过。若硬约束不通过，
 * 即使证据支持也固定为 `blocked_safety`。
 *
 * 阈值（`minPairs`、`minNights`、`minEffectMag`）是审查口径，显式传入，不藏在代码里。
 */

import {
  collectObservations,
  stratify,
  summarizeStratum,
  stratumKey,
} from './estimation.mjs';
import { evaluateAllPairs } from './eligibility.mjs';
import { diagnoseZone } from './diagnostics.mjs';
import {
  pathSafety,
  seasonFloorForZone,
  nightlyOperation,
  SAFETY_ISSUE,
} from './safety.mjs';

export const CONCLUSION = Object.freeze({
  SUPPORTED: 'supported',
  INSUFFICIENT: 'insufficient_evidence',
  BLOCKED_SAFETY: 'blocked_safety',
  NO_TRIAL: 'no_trial',
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  minPairs: 4,
  minNights: 4,
  minEffectMag: 0.05,
  alpha: 0.05,
  seed: 20261123,
  resamples: 4000,
});

const SEASON_ORDER = ['early', 'late'];
const WEATHER_ORDER = ['clear', 'cloud'];

/**
 * 生成一次完整审查。
 *
 * @param {object} dataset
 * @param {{
 *   grouping?: 'planned'|'actual',
 *   thresholds?: object,
 * }} options
 */
export function review(dataset, options = {}) {
  const grouping = options.grouping ?? 'planned';
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };

  const evaluated = evaluateAllPairs(dataset, { grouping, asOf: dataset.asOf });
  const observations = collectObservations(dataset, evaluated);
  const { strata } = stratify(observations);

  const zones = [...new Set(dataset.paths.map(path => path.zone))];
  const seasons = [...new Set(dataset.seasons.map(season => season.season))].sort(orderBy(SEASON_ORDER));
  const weathers = [...new Set(dataset.windows.map(window => window.weather))]
    .filter(weather => weather !== 'rain')
    .sort(orderBy(WEATHER_ORDER));

  const zoneReviews = zones.map(zone => reviewZone(dataset, {
    zone,
    grouping,
    thresholds,
    seasons,
    weathers,
    evaluated,
    strata,
  }));

  return {
    asOf: dataset.asOf,
    grouping,
    thresholds,
    zones: zoneReviews,
    byZone: new Map(zoneReviews.map(zone => [zone.zone, zone])),
    pairCounts: {
      registered: dataset.matches.length,
      eligible: evaluated.filter(pair => pair.eligible).length,
    },
    observations,
  };
}

function reviewZone(dataset, context) {
  const { zone, seasons, weathers, thresholds, evaluated } = context;
  const path = dataset.paths.find(candidate => candidate.zone === zone) ?? null;
  const operations = dataset.operationsByZone.get(zone) ?? null;
  const seasonFloor = seasonFloorForZone(dataset, zone);

  const strata = [];
  for (const season of seasons) {
    for (const weather of weathers) {
      const key = stratumKey(zone, season, weather);
      const observations = context.strata.get(key) ?? [];
      const summary = summarizeStratum(observations, {
        seed: thresholds.seed,
        resamples: thresholds.resamples,
        alpha: thresholds.alpha,
      });
      strata.push({
        zone,
        season,
        weather,
        ...summary,
        status: classifyStratum(summary, thresholds),
      });
    }
  }

  const safety = path ? pathSafety(path, operations, seasonFloor) : {
    issues: [SAFETY_ISSUE.PATH_UNKNOWN],
    lowIsSafe: false,
    emergencyMinLux: null,
    seasonFloor,
    lowLux: null,
  };

  const zonePairs = evaluated.filter(pair => pair.pair && pair.pair.zone === zone);
  const eligibility = summarizeEligibility(zonePairs);
  const compliance = summarizeCompliance(dataset, zone);
  const evidence = summarizeEvidence(strata, thresholds);
  const conclusion = decide(evidence, safety, thresholds);
  const needs = evidenceGaps(strata, thresholds, path);
  if (eligibility.missingReference > 0) {
    // 有可用处理站却找不到未受影响的参考站：对照被污染，需要补一个干净参考站或可
    // 作为等价的时窗，否则这些配对永远进不了证据。
    needs.unshift({
      season: null,
      weather: null,
      status: 'missing_reference',
      currentPairs: eligibility.missingReference,
      message: `有 ${eligibility.missingReference} 个配对缺少未受影响的参考站（对照被污染或缺失），`
        + '需要补设不受任何步道影响的参考站，或补一个参考站两窗都干净的时窗。',
    });
  }
  const diagnostics = diagnoseZone(dataset, zone, evaluated, { grouping: context.grouping });

  return {
    zone,
    path: path?.path ?? null,
    grouping: context.grouping,
    thresholds,
    strata,
    evidence,
    safety,
    eligibility,
    compliance,
    conclusion,
    needs,
    diagnostics,
    trial: describeTrial(dataset, operations, path),
  };
}

function classifyStratum(summary, thresholds) {
  if (summary.n === 0) return 'no_data';
  if (summary.pairs < thresholds.minPairs || summary.nights < thresholds.minNights) {
    return 'sparse';
  }
  if (summary.low === null || summary.high === null) return 'single_block';
  if (summary.low > 0 && summary.mean >= thresholds.minEffectMag) return 'positive';
  if (summary.high < 0) return 'negative';
  return 'inconclusive';
}

function summarizeEvidence(strata, thresholds) {
  const usable = strata.filter(stratum => stratum.status !== 'no_data');
  const material = usable.filter(
    stratum => stratum.pairs >= thresholds.minPairs && stratum.nights >= thresholds.minNights
  );
  const positive = usable.filter(stratum => stratum.status === 'positive');
  const negative = usable.filter(stratum => stratum.status === 'negative');
  const inconclusive = usable.filter(
    stratum => stratum.status === 'inconclusive' || stratum.status === 'sparse' || stratum.status === 'single_block'
  );
  return {
    usableStrata: usable.length,
    materialStrata: material.length,
    positiveStrata: positive.length,
    negativeStrata: negative.length,
    inconclusiveStrata: inconclusive.length,
    noDataStrata: strata.filter(stratum => stratum.status === 'no_data').length,
    totalStrata: strata.length,
  };
}

function decide(evidence, safety, thresholds) {
  if (!safety.lowIsSafe) {
    return {
      code: CONCLUSION.BLOCKED_SAFETY,
      reasons: [...safety.issues],
    };
  }
  if (evidence.materialStrata === 0) {
    return {
      code: CONCLUSION.INSUFFICIENT,
      reasons: ['no_material_stratum'],
    };
  }
  if (evidence.negativeStrata > 0) {
    return { code: CONCLUSION.INSUFFICIENT, reasons: ['negative_stratum'] };
  }
  if (evidence.positiveStrata === 0) {
    return { code: CONCLUSION.INSUFFICIENT, reasons: ['no_positive_stratum'] };
  }
  const uncovered = evidence.noDataStrata + evidence.inconclusiveStrata;
  if (uncovered > 0) {
    return { code: CONCLUSION.INSUFFICIENT, reasons: ['not_all_strata_confirmed'] };
  }
  return { code: CONCLUSION.SUPPORTED, reasons: [] };
}

/**
 * 仍需补录哪类时窗：对每个无资料/样本不足/不确定的分层给出具体条件。
 */
function evidenceGaps(strata, thresholds, path) {
  return strata
    .filter(stratum => !['positive'].includes(stratum.status))
    .map(stratum => ({
      season: stratum.season,
      weather: stratum.weather,
      status: stratum.status,
      currentPairs: stratum.pairs,
      currentNights: stratum.nights,
      neededPairs: Math.max(0, thresholds.minPairs - stratum.pairs),
      neededNights: Math.max(0, thresholds.minNights - stratum.nights),
      message: gapMessage(stratum, thresholds, path),
    }));
}

function gapMessage(stratum, thresholds, path) {
  const lux = path ? path.lowLux : null;
  const prefix = `需要 ${stratum.season} 季、${stratum.weather} 夜`;
  if (stratum.status === 'no_data') {
    return `${prefix}的可比时窗；当前没有任何合格配对（清洗后无资料）`;
  }
  if (stratum.status === 'sparse') {
    const needPairs = Math.max(0, thresholds.minPairs - stratum.pairs);
    const needNights = Math.max(0, thresholds.minNights - stratum.nights);
    const parts = [];
    if (needPairs > 0) parts.push(`${needPairs} 个合格配对`);
    if (needNights > 0) parts.push(`${needNights} 个独立夜`);
    return `${prefix}至少再有 ${parts.join('、') || '一个合格配对'}`;
  }
  if (stratum.status === 'single_block') {
    return `${prefix}的另一晚独立观测；当前所有信息来自同一批共享夜，无法给出区间`;
  }
  if (stratum.status === 'inconclusive') {
    return `${prefix}更多配对以收窄区间；当前均值 ${formatMag(stratum.mean)}，区间跨 0`;
  }
  if (stratum.status === 'negative') {
    return `${prefix}复核；当前区间整体低于 0（低档反而更亮），需检查现场接线或遮光`;
  }
  return `${prefix}（当前低档 ${lux ?? '未知'} lux）`;
}

function summarizeEligibility(zonePairs) {
  const registered = zonePairs.length;
  const eligible = zonePairs.filter(pair => pair.eligible).length;
  const usable = zonePairs.filter(pair => pair.usable).length;
  const reasons = new Map();
  for (const pair of zonePairs) {
    if (pair.eligible) continue;
    for (const reason of pair.pairIssues) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const stationIssues = new Map();
  for (const pair of zonePairs) {
    for (const station of pair.stations.values()) {
      for (const issue of station.issues) {
        const key = issue.split(':')[0];
        stationIssues.set(key, (stationIssues.get(key) ?? 0) + 1);
      }
    }
  }
  // 合格但无参考站的配对：对照缺失/被污染，无法做差值-差分。
  const missingReference = zonePairs.filter(pair => pair.referenceStatus === 'missing').length;
  // 合格但连处理站都没有的配对：两窗都没有足够可用读数。
  const noUsableStations = zonePairs.filter(pair => pair.eligible && !pair.usable && pair.referenceStatus !== 'missing').length;
  return {
    registered,
    eligible,
    usable,
    missingReference,
    noUsableStations,
    excludedBy: Object.fromEntries([...reasons.entries()].sort()),
    stationIssues: Object.fromEntries([...stationIssues.entries()].sort()),
  };
}

/** 依从性：排期与实际不一致、以及被安全事件打断的窗口。 */
export function summarizeCompliance(dataset, zone) {
  const windows = dataset.windows.filter(window => window.zone === zone);
  const deviations = windows
    .filter(window => window.planned !== window.actual)
    .map(window => ({
      window: window.window,
      night: window.night,
      planned: window.planned,
      actual: window.actual,
      interruptions: window.interruption,
    }));
  const interrupted = windows
    .filter(window => window.interruption.length > 0)
    .map(window => ({
      window: window.window,
      night: window.night,
      interruptions: window.interruption,
      planned: window.planned,
      actual: window.actual,
    }));
  return {
    windows: windows.length,
    deviations,
    interrupted,
    deviationCount: deviations.length,
  };
}

function describeTrial(dataset, operations, path) {
  if (!operations) return { registered: false };
  const nights = dataset.windows
    .filter(window => window.zone === (path?.zone ?? operations.zone))
    .map(window => nightlyOperation(dataset, path, window.night))
    .filter(entry => entry.delivered !== null);
  const violatingNights = nights.filter(entry => entry.violatesMinimum);
  return {
    registered: true,
    signedWindow: operations.signedWindow,
    signedNight: operations.signedNight,
    minimum: operations.minimum,
    patrolCoverage: operations.patrolCoverage,
    violatingNights: violatingNights.map(entry => entry.night),
  };
}

function orderBy(order) {
  return (a, b) => {
    const indexA = order.indexOf(a);
    const indexB = order.indexOf(b);
    if (indexA === -1 && indexB === -1) return a.localeCompare(b);
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  };
}

function formatMag(value) {
  return value === null || value === undefined ? '—' : value.toFixed(3);
}
