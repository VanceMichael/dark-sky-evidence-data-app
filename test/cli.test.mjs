import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin', 'review.mjs');

async function withTemp(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-'));
  try {
    return await callback(directory);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(directory, { recursive: true, force: true });
  }
}

test('review subcommand prints a conclusion and never claims a benefit was proven', async () => {
  // 存在安全阻断时退出码为 2，因此用 catch 取回输出。
  const { stdout } = await run(process.execPath, [cli, 'review'], { cwd: root }).catch(reason => reason);
  assert.match(stdout, /west 片区/);
  assert.match(stdout, /east 片区/);
  assert.match(stdout, /证据不足/);
  assert.match(stdout, /安全约束阻断/);
  assert.doesNotMatch(stdout, /支持恢复高亮/);
});

test('review --json is machine-readable and exit code signals a safety block', async () => {
  const error = await run(process.execPath, [cli, 'review', '--json'], { cwd: root }).catch(reason => reason);
  const parsed = JSON.parse(error.stdout);
  assert.equal(parsed.zones.length, 2);
  const east = parsed.zones.find(zone => zone.zone === 'east');
  assert.equal(east.conclusion.code, 'blocked_safety');
  // 退出码 2 表示存在安全阻断。
  assert.equal(error.code, 2);
});

test('scenario subcommand marks the untouched zone as needing reconsideration when evidence moves', async () => {
  const { stdout } = await run(process.execPath, [cli, 'scenario', '--change', 'east=normal'], { cwd: root });
  assert.match(stdout, /改动：east=normal/);
  assert.match(stdout, /west：结论/);
  assert.match(stdout, /需重新审议|结论不变/);
});

test('ledger subcommand writes a snapshot and diffs it against a later review', async () => {
  await withTemp(async directory => {
    const snapshot = join(directory, 'meeting.json');
    await run(process.execPath, [cli, 'ledger', '--as-of', '4', '--reviewed-at', '2026-06-01', '--snapshot', snapshot], { cwd: root });
    const saved = JSON.parse(await readFile(snapshot, 'utf8'));
    assert.equal(saved.asOf, 4);

    const { stdout } = await run(
      process.execPath,
      [cli, 'ledger', '--as-of', '99', '--reviewed-at', '2026-06-10', '--compare', snapshot],
      { cwd: root }
    );
    assert.match(stdout, /校准更正/);
    assert.match(stdout, /S4／C04 夜 2/);
    assert.match(stdout, /仍有效的安全安排/);
    assert.match(stdout, /需重新审议/);
  });
});

test('next week can be entered as new rows and re-reviewed end to end', async () => {
  await withTemp(async directory => {
    // 复制现有一周资料，追加新的一夜（夜 30）两片区窗口与读数。
    for (const file of ['stations', 'windows', 'matches', 'calibration', 'operations', 'readings', 'season', 'paths']) {
      await cp(join(root, 'fixtures', `${file}.csv`), join(directory, `${file}.csv`));
    }
    await cp(join(root, 'fixtures', 'format.json'), join(directory, 'format.json'));

    const season = await readFile(join(directory, 'season.csv'), 'utf8');
    await writeFile(join(directory, 'season.csv'), `${season}30,late,local,2\n`);

    const windows = await readFile(join(directory, 'windows.csv'), 'utf8');
    await writeFile(
      join(directory, 'windows.csv'),
      `${windows}W70,30,20:00,west,low,low,clear,0.2,-\nW71,30,20:00,east,normal,normal,clear,0.2,-\n`
    );

    const reads = [];
    for (const [window, station, base] of [
      ['W70', 'S1', 18.5], ['W70', 'S3', 18.5], ['W70', 'S4', 18.8],
      ['W71', 'S1', 18.2], ['W71', 'S2', 18.2], ['W71', 'S4', 18.8],
    ]) {
      reads.push(`${window},${station},4,${base}`);
      reads.push(`${window},${station},9,${base}`);
    }
    const readingCsv = await readFile(join(directory, 'readings.csv'), 'utf8');
    await writeFile(join(directory, 'readings.csv'), readingCsv + reads.join('\n') + '\n');

    const matches = await readFile(join(directory, 'matches.csv'), 'utf8');
    await writeFile(join(directory, 'matches.csv'), `${matches}W70,W71,0.1\n`);

    const { stdout } = await run(process.execPath, [cli, 'review', '--data', directory, '--json'], { cwd: root }).catch(reason => reason);
    const parsed = JSON.parse(stdout);
    const west = parsed.zones.find(zone => zone.zone === 'west');
    assert.ok(west.strata.some(stratum => stratum.nights > 0));
  });
});

test('malformed new rows are rejected with a line pointer', async () => {
  await withTemp(async directory => {
    for (const file of ['stations', 'windows', 'matches', 'calibration', 'operations', 'readings', 'season', 'paths']) {
      await cp(join(root, 'fixtures', `${file}.csv`), join(directory, `${file}.csv`));
    }
    const windows = await readFile(join(directory, 'windows.csv'), 'utf8');
    // 缺少字段的坏行。
    await writeFile(join(directory, 'windows.csv'), `${windows}BADROW,30,20:00,west,low\n`);

    const error = await run(process.execPath, [cli, 'review', '--data', directory], { cwd: root }).catch(reason => reason);
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /windows/);
    assert.match(error.stderr, /行/);
  });
});

test('--help works without a subcommand', async () => {
  const { stdout } = await run(process.execPath, [cli, '--help'], { cwd: root });
  assert.match(stdout, /用法/);
  assert.match(stdout, /review/);
  assert.match(stdout, /scenario/);
  assert.match(stdout, /ledger/);
});
