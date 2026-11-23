/**
 * 混淆诊断：解释「调暗后天空确实变暗了，还是试行期间碰巧少云」。
 *
 * 三层证据，从最朴素到最可归因：
 *
 *   1. `naive`（朴素对比）：把低档夜读数与正常档夜读数直接相减，不分天气、
 *      不做参考站校正。数值最大，也最容易被误读。
 *   2. `withinPairs`（配对内原始差）：只用合格配对（天气、季节、月光已对齐），
 *      但仍是处理站自身的两窗之差。它排除了跨天气构成的混淆，却保留整晚共享
 *      的天空漂移。
 *   3. `differential`（差值-差分）：在配对内再减去参考站的同窗移动。这才是
 *      「可归因于步道」的部分。
 *
 * 三个量一起看，才能回答那个问题：若 2 很大而 3 接近 0，说明看似变暗的部分
 * 主要来自当晚天空条件（参考站同步移动），而不是步道。
 *
 * `weatherBalance` 直接暴露排期与天气的混淆；`shareExplainedByDrift` 用配对内的
 * 数字说明「原始差里有多大比例可由共享漂移解释」，是量级说明，不是因果分解。
 */
import { windowMagnitude, collectObservations } from './estimation.mjs';

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 朴素对比：某片区某站，按分组（默认排期）把所有低档夜与正常档夜直接相减。
 * 不分天气、不分季节、不做参考站校正——这正是要指出其不可信的那种算法。
 */
export function naiveContrast(dataset, zone, station, { grouping = 'planned' } = {}) {
  const windows = dataset.windows.filter(window => window.zone === zone);
  const low = [];
  const normal = [];
  for (const window of windows) {
    const mag = windowMagnitude(dataset, window.window, station);
    if (mag === null) continue;
    if (window[grouping] === 'low') low.push(mag);
    else if (window[grouping] === 'normal') normal.push(mag);
  }
  return {
    station,
    grouping,
    lowWindows: low.length,
    normalWindows: normal.length,
    lowMean: mean(low),
    normalMean: mean(normal),
    naiveDelta: low.length > 0 && normal.length > 0 ? mean(low) - mean(normal) : null,
  };
}

/**
 * 天气构成：按分组统计 clear/cloud/rain 夜数。两档构成明显不同即为混淆。
 */
export function weatherBalance(dataset, zone, { grouping = 'planned' } = {}) {
  const windows = dataset.windows.filter(window => window.zone === zone);
  const groups = { low: {}, normal: {} };
  for (const window of windows) {
    const group = window[grouping];
    if (group !== 'low' && group !== 'normal') continue;
    groups[group][window.weather] = (groups[group][window.weather] ?? 0) + 1;
  }
  const share = (counts, weather) => {
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return total === 0 ? null : (counts[weather] ?? 0) / total;
  };
  const clearLow = share(groups.low, 'clear');
  const clearNormal = share(groups.normal, 'clear');
  return {
    zone,
    grouping,
    lowCounts: groups.low,
    normalCounts: groups.normal,
    clearShareLow: clearLow,
    clearShareNormal: clearNormal,
    cloudShareLow: share(groups.low, 'cloud'),
    cloudShareNormal: share(groups.normal, 'cloud'),
    confounded: clearLow !== null && clearNormal !== null
      && Math.abs(clearLow - clearNormal) >= 0.25,
  };
}

/**
 * 配对内分解：只用合格配对，分别汇总处理站原始差、参考站漂移、以及二者之差。
 *
 * @param {Array} observations `collectObservations` 的输出
 */
export function withinPairDecomposition(observations) {
  if (observations.length === 0) {
    return { n: 0, raw: null, drift: null, differential: null, shareExplainedByDrift: null };
  }
  const raw = mean(observations.map(observation => observation.raw));
  const drift = mean(observations.map(observation => observation.drift));
  const differential = mean(observations.map(observation => observation.effect));
  const share = raw !== null && drift !== null && raw !== 0 ? drift / raw : null;
  return {
    n: observations.length,
    raw,
    drift,
    differential,
    shareExplainedByDrift: share,
  };
}

/**
 * 综合诊断。默认按排期分组，但配对内分解与估计量一致（受分组选项影响）。
 */
export function diagnoseZone(dataset, zone, evaluatedPairs, { grouping = 'planned' } = {}) {
  const path = dataset.paths.find(candidate => candidate.zone === zone) ?? null;
  const treatedStations = dataset.stations.filter(station =>
    path && station.affectedPaths.includes(path.path)
  );
  const referenceStations = dataset.stations.filter(station => station.affectedPaths.length === 0);

  const naive = treatedStations.map(station =>
    naiveContrast(dataset, zone, station.station, { grouping })
  );
  const balance = weatherBalance(dataset, zone, { grouping });

  const zoneObservations = collectObservations(dataset, evaluatedPairs)
    .filter(observation => observation.zone === zone);
  const withinPairs = withinPairDecomposition(zoneObservations);

  // 按处理站拆分，便于看出是不是所有站都呈现同样的模式。
  const byStation = treatedStations.map(station => ({
    station: station.station,
    ...withinPairDecomposition(zoneObservations.filter(observation => observation.station === station.station)),
  })).filter(entry => entry.n > 0);

  return {
    zone,
    grouping,
    naive,
    referenceStations: referenceStations.map(station => station.station),
    weatherBalance: balance,
    withinPairs,
    byStation,
    warning: buildWarning(balance, withinPairs),
  };
}

function buildWarning(balance, withinPairs) {
  const parts = [];
  if (balance.confounded) {
    parts.push(
      `低档夜 clear 占比 ${formatShare(balance.clearShareLow)}，正常档夜 ${formatShare(balance.clearShareNormal)}；`
      + '两档的天气构成不同，朴素对比被天气混淆。'
    );
  }
  if (withinPairs.n > 0 && withinPairs.raw !== null && withinPairs.drift !== null) {
    if (withinPairs.shareExplainedByDrift !== null && withinPairs.shareExplainedByDrift > 0.7) {
      parts.push(
        `合格配对内约 ${(100 * withinPairs.shareExplainedByDrift).toFixed(0)}% 的表观变化来自整晚共享的天空条件，`
        + '不能归因于步道。'
      );
    } else if (withinPairs.shareExplainedByDrift !== null && withinPairs.shareExplainedByDrift < 0.3) {
      parts.push('合格配对内表观变化主要来自处理站本身，不能由共享天空条件解释。');
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function signed(value) {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

function formatShare(value) {
  return value === null ? '—' : `${(value * 100).toFixed(0)}%`;
}
