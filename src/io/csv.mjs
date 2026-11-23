/**
 * 严格的 CSV 读写。
 *
 * 交接资料使用 UTF-8、逗号分隔、无引号与内嵌换行（见 README）。这里不做通用
 * CSV 解析，只接受约定格式，遇到偏差时抛出带表名和行号的错误，避免把格式问题
 * 悄悄当成数据问题。
 */

/**
 * 把 CSV 文本解析为按字段名索引的对象数组。
 *
 * 每一行会附带一个**不可枚举**的 `line` 属性，记录它在原文件中的行号。不可枚举
 * 是为了让 `deepEqual`/`JSON.stringify` 等只看到业务字段。
 */
export function parseTable(content, fields, table) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    const row = Object.fromEntries(fields.map((field, position) => [field, cells[position]]));
    Object.defineProperty(row, 'line', { value: index + 2, enumerable: false });
    return row;
  });
}

/** 校验关系字段：空串表示未知，`-` 表示不适用，其余必须能在目标表中找到。 */
export function checkLinks(tables, links) {
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== '-' && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

/** 多值字段用竖线分隔；空串与 `-` 都表示没有取值。 */
export function splitList(value) {
  return value === '' || value === '-' ? [] : value.split('|');
}

/** 生成 CSV 文本，字段顺序由调用方给定。 */
export function toCsv(fields, rows) {
  const escape = value => {
    const text = value === undefined || value === null ? '' : String(value);
    if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
      throw new Error(`字段 ${JSON.stringify(text)} 含有约定之外的字符`);
    }
    return text;
  };
  return [fields.join(','), ...rows.map(row => fields.map(field => escape(row[field])).join(','))].join('\n') + '\n';
}
