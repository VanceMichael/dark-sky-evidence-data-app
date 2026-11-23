/**
 * 中文文本报告。
 *
 * 面向照明审议会与夜班：先给结论与硬约束，再给证据强度与缺口，最后给可追溯的
 * 配对明细。所有数值都标注口径（通量平均后的 mag、按夜成块区间）。
 */

import { darkeningFraction } from './units.mjs';

const CONCLUSION_TEXT = {
  supported: '支持维持低档',
  insufficient_evidence: '证据不足，不能下结论（不得据此恢复高亮）',
  blocked_safety: '安全约束阻断（不得调暗）',
  no_trial: '未登记试行',
};

const STRATUM_TEXT = {
  positive: '测到变暗（区间整体高于 0）',
  negative: '测到变亮（区间整体低于 0，需复核）',
  inconclusive: '区间跨 0，方向不明',
  sparse: '样本不足',
  single_block: '只有一晚独立信息',
  no_data: '清洗后无资料',
};

const SAFETY_TEXT = {
  below_emergency_minimum: '低档低于路径应急照度',
  below_season_safety_floor: '低档低于季节安全下限',
  patrol_coverage_partial: '巡查未覆盖全部路段',
  no_operations_record: '缺少运行记录',
  registered_minimum_not_low: '登记最低档位不是低档',
  path_unknown: '路径未知',
};

const PAIR_TEXT = {
  rain: '雨天',
  weather_mismatch: '云量不一致',
  season_mismatch: '季节不一致',
  moon_gap: '月光差超限',
  zone_mismatch: '跨分区',
  no_contrast: '无明暗对照',
  unknown_window: '窗口未知',
  self_pair: '自身配对',
};

const STATION_TEXT = {
  readings_missing: '缺读数',
  readings_insufficient_treated: '处理窗读数不足',
  readings_insufficient_control: '对照窗读数不足',
  calibration_invalid_treated: '处理窗校准无效',
  calibration_invalid_control: '对照窗校准无效',
  calibration_pending_treated: '处理窗校准待确认',
  calibration_pending_control: '对照窗校准待确认',
  calibration_uncovered_treated: '处理窗无校准覆盖',
  calibration_uncovered_control: '对照窗无校准覆盖',
  contaminated: '受其它步道污染',
};

export function formatReview(review) {
  const lines = [];
  lines.push(`# 照明证据审查（分组=${groupingText(review.grouping)}，审阅时点=${review.asOf === Infinity ? '全部资料' : `第 ${review.asOf} 夜`}）`);
  lines.push('');
  const usablePairs = review.zones.reduce((sum, zone) => sum + zone.eligibility.usable, 0);
  lines.push(
    `登记配对 ${review.pairCounts.registered} 个；通过配对筛选 ${review.pairCounts.eligible} 个；`
    + `两窗都有可用处理站与参考站、可做差值-差分的 ${usablePairs} 个。`
  );
  for (const zone of review.zones) {
    const eligibility = zone.eligibility;
    const filtered = [];
    if (eligibility.missingReference > 0) filtered.push(`${eligibility.missingReference} 个缺参考站`);
    if (eligibility.noUsableStations > 0) filtered.push(`${eligibility.noUsableStations} 个无可用处理站`);
    lines.push('');
    lines.push(`## ${zone.zone} 片区（步道 ${zone.path ?? '未知'}）`);
    lines.push('');
    lines.push(
      `配对：登记 ${eligibility.registered}，通过配对筛选 ${eligibility.eligible}，`
      + `可估计 ${eligibility.usable}${filtered.length ? `（${filtered.join('、')}）` : ''}。`
    );
    const exclusions = Object.entries(eligibility.excludedBy);
    if (exclusions.length > 0) {
      lines.push(`- 配对层排除：${exclusions.map(([reason, count]) => `${PAIR_TEXT[reason] ?? reason} ${count}`).join('、')}`);
    }
    const stationIssues = Object.entries(eligibility.stationIssues);
    if (stationIssues.length > 0) {
      lines.push(`- 站点层排除次数：${stationIssues.map(([reason, count]) => `${STATION_TEXT[reason] ?? reason} ${count}`).join('、')}`);
    }
    lines.push(`**结论：${CONCLUSION_TEXT[zone.conclusion.code] ?? zone.conclusion.code}**`);
    if (zone.conclusion.reasons.length > 0) {
      lines.push(`- 原因：${zone.conclusion.reasons.map(reasonText).join('；')}`);
    }

    lines.push('');
    lines.push('### 安全与运行约束');
    if (zone.safety.lowIsSafe) {
      lines.push(`- 低档 ${fmt(zone.safety.lowLux)} lux ≥ 应急照度 ${fmt(zone.safety.emergencyMinLux)} lux、季节下限 ${fmt(zone.safety.seasonFloor)} lux；巡查完整，登记最低档位允许低档。`);
    } else {
      for (const issue of zone.safety.issues) {
        lines.push(`- ⛔ ${SAFETY_TEXT[issue] ?? issue}`);
      }
    }

    lines.push('');
    lines.push('### 分层证据（Δmag 为参考站校正后的处理站差值；正值=低档更暗）');
    lines.push('');
    lines.push('| 季节 | 云量 | 状态 | 配对 | 独立夜 | Δmag | 95% 区间 | 站 |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | --- | --- |');
    for (const stratum of zone.strata) {
      lines.push(
        `| ${stratum.season} | ${stratum.weather} | ${STRATUM_TEXT[stratum.status] ?? stratum.status} | `
        + `${stratum.pairs} | ${stratum.nights} | ${fmt(stratum.mean)} | ${interval(stratum)} | ${stratum.stations.join(',') || '—'} |`
      );
    }

    lines.push('');
    lines.push('### 混淆诊断：是否只是碰巧少云');
    const diagnostics = zone.diagnostics;
    if (diagnostics.warning) {
      lines.push(`- ${diagnostics.warning}`);
    } else {
      lines.push('- 未发现明显的天气混淆。');
    }
    if (diagnostics.withinPairs.n > 0) {
      lines.push(
        `- 配对内分解（n=${diagnostics.withinPairs.n}）：处理站原始差 ${signed(diagnostics.withinPairs.raw)} mag，`
        + `参考站漂移 ${signed(diagnostics.withinPairs.drift)} mag，差值-差分 ${signed(diagnostics.withinPairs.differential)} mag。`
      );
    } else {
      lines.push('- 没有合格配对可供分解。');
    }

    if (zone.needs.length > 0) {
      lines.push('');
      lines.push('### 仍需补录的时窗');
      for (const need of zone.needs) {
        lines.push(`- ${need.message}`);
      }
    }

    lines.push('');
    lines.push('### 依从性');
    if (zone.compliance.deviationCount === 0 && zone.compliance.interrupted.length === 0) {
      lines.push('- 排期与实际执行一致，无安全事件打断。');
    } else {
      for (const deviation of zone.compliance.deviations) {
        lines.push(`- ${deviation.window}（夜 ${deviation.night}）：排期 ${deviation.planned} → 实际 ${deviation.actual}${deviation.interruptions.length ? `（${deviation.interruptions.join('|')}）` : ''}；仍留原分组。`);
      }
    }
  }
  return lines.join('\n');
}

function groupingText(grouping) {
  return grouping === 'planned' ? '排期' : '实际执行';
}

function reasonText(reason) {
  const map = {
    no_material_stratum: '没有任何分层达到最低样本量',
    negative_stratum: '存在方向为变亮的分层，需复核',
    no_positive_stratum: '没有任何分层测到可归因的变暗',
    not_all_strata_confirmed: '尚有分层未确认，不能推广',
    no_trial: '未登记试行',
  };
  return map[reason] ?? reason;
}

function interval(stratum) {
  if (stratum.low === null || stratum.high === null) return '—';
  return `[${fmt(stratum.low)}, ${fmt(stratum.high)}]`;
}

function fmt(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(3);
}

function signed(value) {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(3)}`;
}

export function formatDarkening(deltaMag) {
  if (deltaMag === null || deltaMag === undefined) return '—';
  const fraction = darkeningFraction(deltaMag);
  return `${deltaMag.toFixed(3)} mag（通量约 ${(fraction * 100).toFixed(1)}%）`;
}
