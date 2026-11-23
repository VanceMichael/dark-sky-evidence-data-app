/**
 * 安全与运行约束。
 *
 * 审查建议必须同时考虑三类与「亮度收益」无关的硬约束：
 *   1. 预先登记的应急照明最低档位（operations.minimum）；
 *   2. 片区的实时巡查是否覆盖所有路段（operations.patrol_coverage）；
 *   3. 路径应急照度与季节安全下限（paths.emergency_min_lux、season.min_safety_lux）。
 *
 * 关键原则：**证据不足不等于可以恢复高亮**。这里把「不能下结论」与「支持恢复」
 * 分开建模——`evidence` 只回答「有没有测到收益」，`constraints` 只回答「能不能
 * 调暗」。任何一方为否，都不得输出「恢复高亮」。
 */
import { deliveredSetting } from './dataset.mjs';

export const SAFETY_ISSUE = Object.freeze({
  BELOW_EMERGENCY: 'below_emergency_minimum',
  BELOW_SEASON_FLOOR: 'below_season_safety_floor',
  PATROL_PARTIAL: 'patrol_coverage_partial',
  NO_OPERATIONS_RECORD: 'no_operations_record',
  MINIMUM_NOT_LOW: 'registered_minimum_not_low',
  PATH_UNKNOWN: 'path_unknown',
});

/** 某档位的照度（lux）。 */
export function luxAt(path, setting) {
  if (!path) return null;
  if (setting === 'low') return path.lowLux;
  if (setting === 'normal') return path.normalLux;
  return null;
}

/** 进行明暗比较的那一档（较低照度档）的照度。 */
export function comparisonLux(path) {
  return luxAt(path, 'low');
}

/**
 * 检查某路径在给定季节安全下限下，低档是否满足硬性约束。
 *
 * @param {object} path 类型化路径
 * @param {object} operations 该片区的运行记录
 * @param {number} seasonFloor 季节最低照度
 */
export function pathSafety(path, operations, seasonFloor) {
  const issues = [];
  const lowLux = path.lowLux;
  if (lowLux === null) {
    issues.push(SAFETY_ISSUE.PATH_UNKNOWN);
    return { issues, lowIsSafe: false, emergencyMinLux: path.emergencyMinLux, seasonFloor, lowLux };
  }
  if (path.emergencyMinLux !== null && lowLux < path.emergencyMinLux) {
    issues.push(SAFETY_ISSUE.BELOW_EMERGENCY);
  }
  if (seasonFloor !== null && lowLux < seasonFloor) {
    issues.push(SAFETY_ISSUE.BELOW_SEASON_FLOOR);
  }
  if (!operations) {
    issues.push(SAFETY_ISSUE.NO_OPERATIONS_RECORD);
  } else {
    if (operations.patrolCoverage !== 'full') issues.push(SAFETY_ISSUE.PATROL_PARTIAL);
    if (operations.minimum !== 'low') issues.push(SAFETY_ISSUE.MINIMUM_NOT_LOW);
  }
  return {
    issues,
    lowIsSafe: issues.length === 0,
    emergencyMinLux: path.emergencyMinLux,
    seasonFloor,
    lowLux,
  };
}

/**
 * 某路径在某夜的运行口径：实际交付档位 + 是否低于登记最低档位。
 */
export function nightlyOperation(dataset, path, night) {
  const delivered = deliveredSetting(dataset, path.path ?? path, night);
  const operations = dataset.operationsByZone.get(path.zone);
  const minimum = operations?.minimum ?? null;
  const rank = { low: 0, normal: 1 };
  const violatesMinimum = delivered !== null && minimum !== null
    && rank[delivered] < rank[minimum];
  return { night, delivered, minimum, violatesMinimum };
}

/**
 * 该片区季节安全下限：取该片区窗口所在各夜 safety floor 的最严格值。
 * 若某片区没有任何季节记录，返回 null。
 */
export function seasonFloorForZone(dataset, zone) {
  const floors = dataset.windows
    .filter(window => window.zone === zone)
    .map(window => dataset.seasonByNight.get(window.night)?.minSafetyLux)
    .filter(value => value !== undefined && value !== null);
  if (floors.length === 0) return null;
  return Math.min(...floors);
}
