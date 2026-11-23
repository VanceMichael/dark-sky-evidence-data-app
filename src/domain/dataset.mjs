/**
 * 资料集：把交接 CSV 读成带类型的业务对象，并在读取时做语义校验。
 *
 * 结构的字段/引用检查沿用 `tools/check-materials.mjs` 的约定；这里再补上分析真正
 * 依赖的不变量（如夜号、时间、天气枚举、亮度量纲、校准区间方向），让下游模块可以
 * 信任数据形状。
 */
import { readFile } from 'node:fs/promises';
import { parseTable, checkLinks, splitList } from '../io/csv.mjs';
import { MaterialsError, issue } from './errors.mjs';

const WEATHER = new Set(['clear', 'cloud', 'rain']);
const SETTING = new Set(['low', 'normal', '']);
const PATROL_COVERAGE = new Set(['full', 'partial']);

/** 各表字段顺序，与 fixtures/format.json 保持一致。 */
export const FIELDS = {
  stations: ['station', 'zone', 'affected_paths', 'calibration', 'night_min_readings'],
  windows: ['window', 'night', 'start', 'zone', 'planned', 'actual', 'weather', 'moon', 'interruption'],
  matches: ['left_window', 'right_window', 'max_moon_gap'],
  calibration: ['calibration', 'revision', 'known_night', 'first_night', 'last_night', 'valid'],
  operations: ['zone', 'path', 'minimum', 'patrol_coverage', 'signed_window', 'signed_night'],
  readings: ['window', 'station', 'minute', 'mag_arcsec2'],
  season: ['night', 'season', 'observation_zone', 'min_safety_lux'],
  paths: ['path', 'zone', 'low_lux', 'normal_lux', 'emergency_min_lux'],
};

export const LINKS = [
  ['readings', 'station', 'stations', 'station'],
  ['readings', 'window', 'windows', 'window'],
  ['matches', 'left_window', 'windows', 'window'],
  ['matches', 'right_window', 'windows', 'window'],
  ['stations', 'calibration', 'calibration', 'calibration'],
  ['windows', 'night', 'season', 'night'],
];

async function readRaw(source) {
  const tables = {};
  for (const [name, fields] of Object.entries(FIELDS)) {
    const content = await readFile(new URL(`${name}.csv`, source), 'utf8');
    tables[name] = parseTable(content, fields, name);
  }
  checkLinks(tables, LINKS);
  return tables;
}

/**
 * 读取并类型化资料集。
 *
 * @param {URL|string} source 含 CSV 的目录（以 / 结尾的 URL 或路径）
 * @param {{asOf?: number}} options `asOf` 为审阅时已知到哪一夜（含），默认全部已知
 */
export async function loadDataset(source, { asOf = Infinity } = {}) {
  const raw = await readRaw(source);
  return buildDataset(raw, { asOf });
}

/** 从已解析的原始表构造资料集；便于测试与在内存中改写排期。 */
export function buildDataset(raw, { asOf = Infinity } = {}) {
  const issues = [];

  const paths = raw.paths.map(row => ({
    path: row.path,
    zone: row.zone,
    lowLux: number(row, 'low_lux', 'paths', issues),
    normalLux: number(row, 'normal_lux', 'paths', issues),
    emergencyMinLux: number(row, 'emergency_min_lux', 'paths', issues),
    line: row.line,
  }));

  const seasons = raw.season.map(row => ({
    night: integer(row, 'night', 'season', issues),
    season: row.season,
    observationZone: row.observation_zone,
    minSafetyLux: number(row, 'min_safety_lux', 'season', issues),
    line: row.line,
  }));

  const stations = raw.stations.map(row => ({
    station: row.station,
    zone: row.zone,
    affectedPaths: splitList(row.affected_paths),
    calibration: row.calibration,
    nightMinReadings: integer(row, 'night_min_readings', 'stations', issues),
    line: row.line,
  }));

  const calibrationRecords = raw.calibration.map(row => ({
    calibration: row.calibration,
    revision: integer(row, 'revision', 'calibration', issues),
    knownNight: integer(row, 'known_night', 'calibration', issues),
    firstNight: integer(row, 'first_night', 'calibration', issues),
    lastNight: integer(row, 'last_night', 'calibration', issues),
    valid: row.valid === 'true',
    line: row.line,
  }));

  const windows = raw.windows.map(row => ({
    window: row.window,
    night: integer(row, 'night', 'windows', issues),
    start: row.start,
    zone: row.zone,
    planned: row.planned,
    actual: row.actual,
    weather: row.weather,
    moon: number(row, 'moon', 'windows', issues),
    interruption: row.interruption === '-' ? [] : row.interruption.split('|').filter(Boolean),
    line: row.line,
  }));

  const readings = raw.readings.map(row => ({
    window: row.window,
    station: row.station,
    minute: integer(row, 'minute', 'readings', issues),
    magArcsec2: number(row, 'mag_arcsec2', 'readings', issues),
    line: row.line,
  }));

  const matches = raw.matches.map(row => ({
    leftWindow: row.left_window,
    rightWindow: row.right_window,
    maxMoonGap: number(row, 'max_moon_gap', 'matches', issues),
    line: row.line,
  }));

  const operations = raw.operations.map(row => ({
    zone: row.zone,
    path: row.path,
    minimum: row.minimum,
    patrolCoverage: row.patrol_coverage,
    signedWindow: row.signed_window === '-' ? null : row.signed_window,
    signedNight: row.signed_night === '-' ? null : integer(row, 'signed_night', 'operations', issues),
    line: row.line,
  }));

  validateEnum(windows, 'planned', SETTING, 'windows', issues);
  validateEnum(windows, 'actual', SETTING, 'windows', issues);
  validateEnum(windows, 'weather', WEATHER, 'windows', issues);
  validateEnum(operations, 'patrolCoverage', PATROL_COVERAGE, 'operations', issues);
  validateRanges(calibrationRecords, issues);
  validateUnique(windows, 'window', 'windows', issues);
  validateUnique(stations, 'station', 'stations', issues);
  validateUnique(paths, 'path', 'paths', issues);
  validateUnique(seasons, 'night', 'season', issues);
  validateNightZones(windows, issues);

  if (issues.length > 0) {
    throw new MaterialsError(`资料集有 ${issues.length} 处语义问题`, issues);
  }

  const dataset = {
    asOf,
    paths,
    pathsByKey: indexBy(paths, 'path'),
    seasons,
    seasonByNight: indexBy(seasons, 'night'),
    stations,
    stationsByName: indexBy(stations, 'station'),
    calibrationRecords,
    calibrationByKey: groupBy(calibrationRecords, 'calibration'),
    windows,
    windowsByName: indexBy(windows, 'window'),
    readings,
    matches,
    operations,
    operationsByZone: indexBy(operations, 'zone'),
  };
  dataset.derived = derive(dataset);
  return dataset;
}

/** 派生映射：夜 → 分区 → 实际档位；夜 → 分区 → 窗口；窗口 → 站点 → 读数。 */
function derive(dataset) {
  const nightZoneSetting = new Map();
  const nightZoneWindow = new Map();
  for (const window of dataset.windows) {
    const settings = nightZoneSetting.get(window.night) ?? new Map();
    settings.set(window.zone, window.actual === '' ? null : window.actual);
    nightZoneSetting.set(window.night, settings);
    const byZone = nightZoneWindow.get(window.night) ?? new Map();
    byZone.set(window.zone, window);
    nightZoneWindow.set(window.night, byZone);
  }

  const stationPaths = new Map();
  for (const station of dataset.stations) {
    for (const path of station.affectedPaths) {
      const list = stationPaths.get(path) ?? [];
      list.push(station.station);
      stationPaths.set(path, list);
    }
  }

  const readingsByCell = new Map();
  for (const reading of dataset.readings) {
    const key = cellKey(reading.window, reading.station);
    const list = readingsByCell.get(key) ?? [];
    list.push(reading.magArcsec2);
    readingsByCell.set(key, list);
  }

  return { nightZoneSetting, nightZoneWindow, stationPaths, readingsByCell };
}

/**
 * 某条路径在某一夜实际交付的档位。
 * 用同夜同分区的窗口的 actual 表示；同夜没有该分区窗口时为 null（未知）。
 */
export function deliveredSetting(dataset, path, night) {
  const zone = dataset.pathsByKey.get(path)?.zone;
  if (!zone) return null;
  const settings = dataset.derived.nightZoneSetting.get(night);
  if (!settings || !settings.has(zone)) return null;
  return settings.get(zone);
}

export function cellKey(window, station) {
  return `${window}\u0000${station}`;
}

export function readingsFor(dataset, window, station) {
  return dataset.derived.readingsByCell.get(cellKey(window, station)) ?? [];
}

export function stationsForPath(dataset, path) {
  return dataset.derived.stationPaths.get(path) ?? [];
}

function number(row, field, table, issues) {
  const text = row[field];
  if (text === '' || text === '-') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) {
    issues.push(issue(table, row, `${field} 的值 ${JSON.stringify(text)} 不是数值`));
    return null;
  }
  return value;
}

function integer(row, field, table, issues) {
  const value = number(row, field, table, issues);
  if (value === null) return null;
  if (!Number.isInteger(value)) {
    issues.push(issue(table, row, `${field} 的值 ${value} 不是整数`));
    return null;
  }
  return value;
}

function validateEnum(rows, field, allowed, table, issues) {
  for (const row of rows) {
    if (!allowed.has(row[field])) {
      issues.push(issue(table, row, `${field} 的值 ${JSON.stringify(row[field])} 不在约定取值内`));
    }
  }
}

function validateRanges(records, issues) {
  for (const record of records) {
    if (record.firstNight === null || record.lastNight === null) continue;
    if (record.firstNight > record.lastNight) {
      issues.push(issue('calibration', record, `first_night ${record.firstNight} 晚于 last_night ${record.lastNight}`));
    }
  }
}

function validateUnique(rows, field, table, issues) {
  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row[field])) {
      issues.push(issue(table, row, `${field} 的 ${row[field]} 重复`));
    }
    seen.set(row[field], row);
  }
}

/** 同夜同一分区至多一个窗口；否则「该夜该分区的实际档位」无定义。 */
function validateNightZones(windows, issues) {
  const seen = new Map();
  for (const window of windows) {
    const key = `${window.night}\u0000${window.zone}`;
    if (seen.has(key)) {
      issues.push(issue('windows', window, `第 ${window.night} 夜 ${window.zone} 分区有多个窗口，实际档位无定义`));
    }
    seen.set(key, window);
  }
}

function indexBy(rows, field) {
  return new Map(rows.map(row => [row[field], row]));
}

function groupBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[field]) ?? [];
    list.push(row);
    map.set(row[field], list);
  }
  return map;
}
