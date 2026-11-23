#!/usr/bin/env node
/**
 * 照明证据审查命令行。
 *
 * 子命令：
 *   review    读取一周资料，输出审查结论（文本或 JSON）
 *   scenario  比较方案组合，标出改动一个片区后另一片区结论是否仍适用
 *   ledger    生成审阅快照，并比较两次审阅（校准更正后的变化）
 *
 * 资料目录默认 ./fixtures/，也可用 --data 指定。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadDataset } from '../src/domain/dataset.mjs';
import { review } from '../src/domain/review.mjs';
import { formatReview } from '../src/domain/report.mjs';
import { applySchedule, pinZone, compareCombinations } from '../src/domain/scenario.mjs';
import { captureReview, diffReviews } from '../src/domain/ledger.mjs';

const HELP = `用法: node bin/review.mjs <子命令> [选项]

子命令:
  review     审查资料并给出结论
  scenario   比较方案组合（--change zone=档位，可重复）
  ledger     生成或比较审阅快照（--as-of、--snapshot、--compare）

通用选项:
  --data <目录>       资料目录，默认 ./fixtures/
  --group <口径>      planned（默认）或 actual
  --json              输出 JSON

review 选项:
  --min-pairs <n>     每分层最低配对数，默认 4
  --min-nights <n>    每分层最低独立夜，默认 4
  --min-effect <x>    最低可判定效应，默认 0.05 mag

scenario 选项:
  --change <zone=档位> 把某片区整段排期固定为 low/normal，可重复
  --change <夜:zone=档位> 只改某一夜某片区，可重复

ledger 选项:
  --as-of <夜>        审阅时点（校准只看到该夜为止），默认全部
  --reviewed-at <日期>  快照日期，默认今天
  --approve <zone>    记录当时批准的片区，可重复
  --snapshot <文件>   写出快照 JSON
  --compare <文件>    与既有快照比较
`;

export function parseArgv(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { command: '', help: true };
  }
  const [command = '', ...rest] = argv;
  const options = { command, data: null, group: null, json: false, changes: [], approve: [], thresholds: {} };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    switch (token) {
      case '--data': options.data = next(rest, index += 1); break;
      case '--group': options.group = next(rest, index += 1); break;
      case '--json': options.json = true; break;
      case '--min-pairs': options.thresholds.minPairs = Number(next(rest, index += 1)); break;
      case '--min-nights': options.thresholds.minNights = Number(next(rest, index += 1)); break;
      case '--min-effect': options.thresholds.minEffectMag = Number(next(rest, index += 1)); break;
      case '--change': options.changes.push(next(rest, index += 1)); break;
      case '--as-of': options.asOf = Number(next(rest, index += 1)); break;
      case '--reviewed-at': options.reviewedAt = next(rest, index += 1); break;
      case '--approve': options.approve.push(next(rest, index += 1)); break;
      case '--snapshot': options.snapshot = next(rest, index += 1); break;
      case '--compare': options.compare = next(rest, index += 1); break;
      case '-h':
      case '--help': options.help = true; break;
      default: throw new Error(`未知选项 ${token}`);
    }
  }
  return options;
}

function next(args, index) {
  if (index >= args.length) throw new Error('选项缺少取值');
  return args[index];
}

function dataSource(options) {
  return options.data ? new URL(`file://${options.data.endsWith('/') ? options.data : `${options.data}/`}`) : new URL('../fixtures/', import.meta.url);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  if (options.help || options.command === '') {
    process.stdout.write(HELP);
    return 0;
  }
  const source = dataSource(options);
  const asOf = options.asOf === undefined ? Infinity : options.asOf;
  const dataset = await loadDataset(source, { asOf });
  const grouping = options.group ?? undefined;

  if (options.command === 'review') {
    const result = review(dataset, { grouping, thresholds: options.thresholds });
    if (options.json) {
      process.stdout.write(JSON.stringify(serializeReview(result), null, 2) + '\n');
    } else {
      process.stdout.write(formatReview(result) + '\n');
    }
    return result.zones.every(zone => zone.conclusion.code !== 'blocked_safety') ? 0 : 2;
  }

  if (options.command === 'scenario') {
    const scenarios = [{ name: '现状', dataset }];
    for (const change of options.changes) {
      const parsed = parseChange(change);
      const name = parsed.kind === 'pin' ? `${parsed.zone}=${parsed.setting}` : `夜${parsed.night}/${parsed.zone}=${parsed.setting}`;
      const scenarioDataset = parsed.kind === 'pin'
        ? pinZone(dataset, parsed.zone, parsed.setting)
        : applySchedule(dataset, [{ night: parsed.night, zone: parsed.zone, actual: parsed.setting }]);
      scenarios.push({ name, dataset: scenarioDataset });
    }
    const comparison = compareCombinations(scenarios, dataset, { grouping, thresholds: options.thresholds });
    if (options.json) {
      process.stdout.write(JSON.stringify(comparison, null, 2) + '\n');
    } else {
      process.stdout.write(formatComparison(comparison) + '\n');
    }
    return 0;
  }

  if (options.command === 'ledger') {
    const snapshot = captureReview(dataset, {
      reviewedAt: options.reviewedAt ?? today(),
      approved: options.approve.length > 0 ? { zones: options.approve } : null,
      grouping,
      thresholds: options.thresholds,
    });
    if (options.snapshot) await writeFile(options.snapshot, JSON.stringify(snapshot, null, 2) + '\n');
    if (options.compare) {
      const previous = JSON.parse(await readFile(options.compare, 'utf8'));
      const diff = diffReviews(previous, snapshot);
      process.stdout.write((options.json ? JSON.stringify(diff, null, 2) : formatDiff(diff)) + '\n');
    } else {
      process.stdout.write((options.json ? JSON.stringify(snapshot, null, 2) : `已记录审阅快照（${snapshot.reviewedAt}，审阅时点 ${snapshot.asOf === Infinity ? '全部资料' : `第 ${snapshot.asOf} 夜`}）\n`) );
    }
    return 0;
  }

  throw new Error(`未知子命令 ${options.command}`);
}

function parseChange(change) {
  const match = change.match(/^(?:(\d+):)?([a-z]+)=([a-z]+)$/);
  if (!match) throw new Error(`--change 格式应为 zone=档位 或 夜:zone=档位，收到 ${change}`);
  const [, night, zone, setting] = match;
  if (setting !== 'low' && setting !== 'normal') throw new Error(`档位只能是 low 或 normal，收到 ${setting}`);
  if (night !== undefined) return { kind: 'night', night: Number(night), zone, setting };
  return { kind: 'pin', zone, setting };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function serializeReview(result) {
  return {
    asOf: result.asOf === Infinity ? 'all' : result.asOf,
    grouping: result.grouping,
    thresholds: result.thresholds,
    pairCounts: result.pairCounts,
    zones: result.zones.map(zone => ({
      zone: zone.zone,
      path: zone.path,
      conclusion: zone.conclusion,
      safety: zone.safety,
      eligibility: zone.eligibility,
      compliance: zone.compliance,
      trial: zone.trial,
      diagnostics: {
        naive: zone.diagnostics.naive.map(entry => ({
          station: entry.station,
          lowWindows: entry.lowWindows,
          normalWindows: entry.normalWindows,
          naiveDelta: entry.naiveDelta,
        })),
        withinPairs: zone.diagnostics.withinPairs,
        weatherBalance: zone.diagnostics.weatherBalance,
        warning: zone.diagnostics.warning,
      },
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
      needs: zone.needs,
    })),
  };
}

function formatComparison(comparison) {
  const lines = ['# 方案组合比较（基线：现状）', ''];
  for (const scenario of comparison.scenarios) {
    lines.push(`## ${scenario.name}`);
    for (const zone of scenario.zones) {
      lines.push(`- ${zone.zone}：${zone.conclusion.code}（可用配对 ${zone.eligible}）${zone.conclusion.reasons.length ? `；${zone.conclusion.reasons.join(',')}` : ''}`);
    }
    lines.push('');
  }
  for (const pair of comparison.pairwise) {
    lines.push(`## 改动：${pair.right}`);
    if (pair.mechanism) {
      lines.push(`- 耦合机制：${pair.mechanism.explanation}`);
    }
    for (const change of pair.changes) {
      if (!change.changed && change.stationsGained.length === 0 && change.stationsLost.length === 0) {
        lines.push(`- ${change.zone}：结论不变（${change.after.code}）`);
        continue;
      }
      if (change.changed) {
        lines.push(`- ${change.zone}：结论 ${change.before.code} → ${change.after.code}；结论需重新审议`);
      } else {
        lines.push(`- ${change.zone}：结论码不变（${change.after.code}），但证据构成变化，需重新审议`);
      }
      if (change.stationsGained.length > 0) {
        lines.push(`  - 新增可用处理站：${change.stationsGained.join(',')}`);
      }
      if (change.stationsLost.length > 0) {
        lines.push(`  - 失去可用处理站：${change.stationsLost.join(',')}`);
      }
      const before = new Map(change.before.strata.map(stratum => [`${stratum.season}/${stratum.weather}`, stratum]));
      for (const after of change.after.strata) {
        const key = `${after.season}/${after.weather}`;
        const prior = before.get(key);
        if (!prior) continue;
        if (prior.status !== after.status || prior.pairs !== after.pairs) {
          lines.push(`  - ${key}：${prior.status}(${prior.pairs} 对) → ${after.status}(${after.pairs} 对)`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatDiff(diff) {
  const lines = [
    `# 审阅对比（${diff.before.reviewedAt} → ${diff.after.reviewedAt}）`,
    '',
    '## 校准更正',
  ];
  if (diff.calibrationCorrections.length === 0) {
    lines.push('- 无');
  } else {
    for (const correction of diff.calibrationCorrections) {
      lines.push(`- ${correction.station}／${correction.calibration} 夜 ${correction.night}：${correction.before?.status ?? '无记录'} → ${correction.after?.status ?? '无记录'}`);
      if (correction.affectedPairs?.length > 0) {
        const pairs = correction.affectedPairs
          .map(pair => `${pair.pairId}(${pair.zone}${pair.eligibleBefore !== pair.eligibleAfter ? `，资格 ${pair.eligibleBefore ? '合格' : '不合格'}→${pair.eligibleAfter ? '合格' : '不合格'}` : ''})`)
          .join('、');
        lines.push(`  - 涉及配对：${pairs}`);
      }
      if (correction.changedAdoptedSample) {
        lines.push('  - 该更正改变了被采纳的观测样本');
      }
    }
  }
  lines.push('', '## 仍有效的安全安排');
  lines.push(...(diff.stillValid.length ? diff.stillValid.map(item => `- ${item}`) : ['- 无']));
  lines.push('', '## 需重新审议');
  lines.push(...(diff.needsReconsideration.length ? diff.needsReconsideration.map(item => `- ${item}`) : ['- 无']));
  if (diff.approvalImpact.status === 'reconsider') {
    lines.push('', `⚠ ${diff.approvalImpact.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`错误：${error.message}\n`);
    if (error.issues) {
      for (const issue of error.issues) {
        process.stderr.write(`  ${issue.table}.${issue.line ?? '?'}: ${issue.message}\n`);
      }
    }
    process.exitCode = 1;
  });
}
