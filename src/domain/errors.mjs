/**
 * 业务错误。
 *
 * `issues` 里每条都带 `table`/`line`（若可定位），便于资料录入时把问题指回原始行。
 */
export class MaterialsError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'MaterialsError';
    this.issues = issues;
  }
}

export function issue(table, row, message) {
  return { table, line: row?.line ?? null, message };
}

export function fail(table, row, message) {
  throw new MaterialsError(message, [issue(table, row, message)]);
}
