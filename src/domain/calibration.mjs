/**
 * 校准记录的有效期与「当时可知」版本。
 *
 * 关键业务点：
 * - 有效期含两端（first_night <= night <= last_night）。
 * - 同一 calibration 标识下，后来的修订只在其给定区间内覆盖原记录；区间内取
 *   修订号最高的一条。
 * - `known_night` 表示该条记录在当晚之后才可用。审阅时（knowledge cut）只能看到
 *   `known_night <= cut` 的记录。因此**同一份资料可以有两个都正确的答案**：会议
 *   当时看到的版本，和后来补录校准后的版本。工具必须能分别复现，不能覆盖历史。
 */

export const CALIBRATION_STATUS = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  PENDING: 'pending', // 区间有记录，但审阅时尚未可知
  UNCOVERED: 'uncovered', // 没有任何记录覆盖该夜
});

/**
 * 解析某校准标识在某夜的有效性。
 *
 * @param {Array} records 该标识下的全部校准记录（已按类型化字段）
 * @param {number} night 观测夜
 * @param {number} knownThrough 审阅时已知到哪一夜（含）；Infinity 表示全部已知
 * @returns {{status: string, revision: number|null, record: object|null}}
 */
export function resolveCalibration(records, night, knownThrough = Infinity) {
  const covering = records.filter(record => night >= record.firstNight && night <= record.lastNight);
  const known = covering.filter(record => record.knownNight <= knownThrough);
  if (known.length > 0) {
    const record = known.reduce((best, current) =>
      current.revision > best.revision ? current : best
    );
    return {
      status: record.valid ? CALIBRATION_STATUS.VALID : CALIBRATION_STATUS.INVALID,
      revision: record.revision,
      record,
    };
  }
  if (covering.some(record => record.knownNight > knownThrough)) {
    return { status: CALIBRATION_STATUS.PENDING, revision: null, record: null };
  }
  return { status: CALIBRATION_STATUS.UNCOVERED, revision: null, record: null };
}

/**
 * 校准有效性的「状态差异」：两次审阅之间是否发生更正。
 * 用于把「会后确认的校准」标成需要复核的结论。
 */
export function calibrationChanged(before, after) {
  return before.status !== after.status || before.revision !== after.revision;
}
