/**
 * 效应估计与不确定性。
 *
 * ## 估计量
 * 对每个可用配对、每个可用处理站：
 *
 *   effect = (m_low[T] - m_normal[T]) - (m_low[R] - m_normal[R])
 *
 * 即「处理站两窗之差」再减去「参考站两窗之差」。差分-差分消掉与夜共享的云雨/
 * 月光水平漂移。所有 m 都是**窗口通量平均后换回的 mag**（见 units.mjs），不是对
 * 分钟读数取算术平均。
 *
 * ## 单位：站点 × 配对
 * 每个处理站每晚贡献一个配对效应。若一个配对有多个处理站，它们是同一批被调暗
 * 的夜上的不同观测，仍属于同一实验单位的一部分，不是重复试验。
 *
 * ## 不确定性：按夜成块
 * 读数每几分钟一条，但几分钟之间的波动不是独立重复试验。真正独立、且与处理
 * 共同变化的是**整晚的天气/月光条件**。因此重抽样的单位是「夜」，且同一夜在两
 * 个片区之间的说法要合并——为避免把同一夜当两次独立抽样，这里用**按夜成块的
 * 自助法**（block bootstrap）：
 *   1. 把共享同一观测夜的配对连成连通块（配对图里共享窗口即相连）；
 *   2. 以「块」为单位有放回重抽；
 *   3. 每次重抽计算效应均值，取 2.5%/97.5% 分位。
 * 块数为 1 时无法给出区间，必须明确报告「只有一晚独立信息」。
 */

import { combineMagnitudes, meanFlux, magToFlux } from './units.mjs';
import { readingsFor } from './dataset.mjs';

/** 某窗口某站的亮度（mag），在通量上汇总。无读数返回 null。 */
export function windowMagnitude(dataset, window, station) {
  const mags = readingsFor(dataset, window, station);
  if (mags.length === 0) return null;
  return combineMagnitudes(mags);
}

/** 某窗口某站的汇总通量。 */
export function windowFlux(dataset, window, station) {
  const mags = readingsFor(dataset, window, station);
  if (mags.length === 0) return null;
  return meanFlux(mags.map(magToFlux));
}

/**
 * 从一个已判定合格的配对结果中抽取观测。
 *
 * 参考站可能不止一个：逐站先算两窗差，再在参考站之间取简单平均作为「夜漂移」，
 * 避免参考站多的配对获得更大权重。
 *
 * @returns {Array<{station, reference, raw, drift, effect, ...}>}
 */
export function pairObservations(dataset, evaluated) {
  if (!evaluated.eligible) return [];
  const { pair, stations, treated, reference } = evaluated;
  if (treated.length === 0 || reference.length === 0) return [];

  const drifts = reference.map(station => {
    const low = windowMagnitude(dataset, pair.lowWindow, station);
    const normal = windowMagnitude(dataset, pair.normalWindow, station);
    return low - normal;
  });
  const drift = drifts.reduce((sum, value) => sum + value, 0) / drifts.length;

  const observations = [];
  for (const station of treated) {
    const low = windowMagnitude(dataset, pair.lowWindow, station);
    const normal = windowMagnitude(dataset, pair.normalWindow, station);
    const raw = low - normal;
    observations.push({
      pairId: pair.pairId,
      zone: pair.zone,
      path: pair.path,
      weather: pair.weather,
      season: pair.season,
      station,
      references: [...reference],
      lowWindow: pair.lowWindow,
      normalWindow: pair.normalWindow,
      nights: pair.nights,
      raw,
      drift,
      effect: raw - drift,
      deliveredDiffer: pair.deliveredDiffer,
    });
  }
  return observations;
}

/** 收集所有合格配对的观测。 */
export function collectObservations(dataset, evaluatedPairs) {
  return evaluatedPairs.flatMap(evaluated => pairObservations(dataset, evaluated));
}

/**
 * 把观测按 (片区, 季节, 云量) 分层。
 * 未定义季节或云量的观测单列在 `unstratified`。
 */
export function stratify(observations) {
  const strata = new Map();
  const unstratified = [];
  for (const observation of observations) {
    if (observation.season === null || observation.weather === null) {
      unstratified.push(observation);
      continue;
    }
    const key = `${observation.zone}\u0000${observation.season}\u0000${observation.weather}`;
    const list = strata.get(key) ?? [];
    list.push(observation);
    strata.set(key, list);
  }
  return { strata, unstratified };
}

export function stratumKey(zone, season, weather) {
  return `${zone}\u0000${season}\u0000${weather}`;
}

/**
 * 共享观测夜的连通块。
 *
 * 两两配对通过「同一夜」相连：若配对 A 与 B 含有同一 night，则同一块。块的重抽样
 * 反映「换一批夜再看结论会不会变」，同时不会把同一夜重复当独立信息。
 */
export function nightBlocks(observations) {
  const parent = new Map();
  const find = node => {
    if (!parent.has(node)) parent.set(node, node);
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(node) !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const pairsByNight = new Map();
  for (const observation of observations) {
    for (const night of observation.nights) {
      const list = pairsByNight.get(night) ?? new Set();
      list.add(observation.pairId);
      pairsByNight.set(night, list);
    }
  }
  for (const [night, pairIds] of pairsByNight) {
    const ids = [...pairIds];
    union(`night:${night}`, ids[0]);
    for (const id of ids.slice(1)) union(id, ids[0]);
  }

  const blocks = new Map();
  for (const observation of observations) {
    if (parent.has(observation.pairId)) {
      const root = find(observation.pairId);
      const list = blocks.get(root) ?? new Set();
      list.add(observation.pairId);
      blocks.set(root, list);
    }
  }
  return [...blocks.values()].map(set => [...set]);
}

/** 确定性伪随机数（mulberry32），保证同一资料同一结论可复现。 */
export function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = probability * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * 按夜成块的自助法区间。
 *
 * @param {Array} observations 同一分层的观测
 * @param {{seed?: number, resamples?: number, alpha?: number}} options
 */
export function blockBootstrap(observations, { seed = 20261123, resamples = 4000, alpha = 0.05 } = {}) {
  if (observations.length === 0) {
    return { mean: null, low: null, high: null, blocks: 0, resamples: 0 };
  }
  const mean = observations.reduce((sum, observation) => sum + observation.effect, 0) / observations.length;
  const blocks = nightBlocks(observations);
  if (blocks.length <= 1) {
    return {
      mean,
      low: null,
      high: null,
      blocks: blocks.length,
      resamples: 0,
      note: '只有一晚独立信息，无法给出区间',
    };
  }

  const byPair = new Map();
  for (const observation of observations) {
    const list = byPair.get(observation.pairId) ?? [];
    list.push(observation.effect);
    byPair.set(observation.pairId, list);
  }

  const random = makeRng(seed);
  const means = [];
  for (let iteration = 0; iteration < resamples; iteration += 1) {
    let sum = 0;
    let count = 0;
    for (let pick = 0; pick < blocks.length; pick += 1) {
      const block = blocks[Math.floor(random() * blocks.length)];
      for (const pairId of block) {
        for (const effect of byPair.get(pairId) ?? []) {
          sum += effect;
          count += 1;
        }
      }
    }
    if (count > 0) means.push(sum / count);
  }
  means.sort((a, b) => a - b);

  return {
    mean,
    low: quantile(means, alpha / 2),
    high: quantile(means, 1 - alpha / 2),
    blocks: blocks.length,
    resamples: means.length,
    blockMembership: blocks.map(block => [...block].sort()),
  };
}

/**
 * 分层汇总：均值、按夜成块区间、独立夜数、站点集合、效应值列表。
 */
export function summarizeStratum(observations, options = {}) {
  if (observations.length === 0) {
    return {
      n: 0,
      pairs: 0,
      nights: 0,
      stations: [],
      mean: null,
      low: null,
      high: null,
      blocks: 0,
      effects: [],
    };
  }
  const bootstrap = blockBootstrap(observations, options);
  const effects = observations.map(observation => observation.effect);
  const nights = new Set(observations.flatMap(observation => observation.nights));
  return {
    n: observations.length,
    pairs: new Set(observations.map(observation => observation.pairId)).size,
    nights: nights.size,
    stations: [...new Set(observations.map(observation => observation.station))].sort(),
    mean: bootstrap.mean,
    low: bootstrap.low,
    high: bootstrap.high,
    blocks: bootstrap.blocks,
    note: bootstrap.note ?? null,
    effects,
    observations,
  };
}

/**
 * 分层覆盖报告：列出全部可能的 (片区, 季节, 云量) 组合，并标出哪些组合没有
 * 可比较资料、以及每种组合的样本量。这是回答「筛选后哪些季节、云量条件和站点
 * 实际上还有可比较的资料」的入口。
 */
export function coverageMatrix(observations, zones, seasons, weathers) {
  const cellsOf = new Map();
  for (const zone of zones) {
    for (const season of seasons) {
      for (const weather of weathers) {
        cellsOf.set(stratumKey(zone, season, weather), {
          zone,
          season,
          weather,
          observations: [],
        });
      }
    }
  }
  for (const observation of observations) {
    if (observation.season === null || observation.weather === null) continue;
    const cell = cellsOf.get(stratumKey(observation.zone, observation.season, observation.weather));
    if (cell) cell.observations.push(observation);
  }
  return [...cellsOf.values()].map(cell => ({
    zone: cell.zone,
    season: cell.season,
    weather: cell.weather,
    ...summarizeStratum(cell.observations),
  }));
}
