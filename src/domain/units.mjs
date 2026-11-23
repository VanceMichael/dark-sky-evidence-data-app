/**
 * 亮度单位与汇总规则。
 *
 * 读数是 mag/arcsec²（对数亮度单位）。每增加 5 单位，通量减为原来的百分之一：
 *
 *   flux = 10^(-0.4 * mag)
 *
 * 因此**绝不能对 mag 直接取算术平均**来表达「平均亮度」。任何亮度水平的汇总都
 * 先换算到通量、在通量上平均，再换回 mag。差值的含义是对数亮度比（相当于通量
 * 比），可以线性组合，但报告时要说明它是几何平均意义下的光比。
 */

/** mag/arcsec² → 相对通量。 */
export function magToFlux(mag) {
  return Math.pow(10, -0.4 * mag);
}

/** 相对通量 → mag/arcsec²。 */
export function fluxToMag(flux) {
  assertPositiveFlux(flux);
  return -2.5 * Math.log10(flux);
}

/**
 * 把若干 mag 读数汇总为一个 mag：先在通量上平均，再换回 mag。
 * 这是「窗口亮度」的唯一正确口径。
 */
export function combineMagnitudes(mags) {
  if (!Array.isArray(mags) || mags.length === 0) {
    throw new Error('没有可用于汇总的读数');
  }
  for (const mag of mags) {
    if (!Number.isFinite(mag)) throw new Error(`读数 ${mag} 不是有限数值`);
  }
  const flux = mags.reduce((sum, mag) => sum + magToFlux(mag), 0) / mags.length;
  return fluxToMag(flux);
}

/** 若干通量的算术平均（已是通量口径，可直接平均）。 */
export function meanFlux(fluxes) {
  if (!Array.isArray(fluxes) || fluxes.length === 0) {
    throw new Error('没有可用于汇总的通量');
  }
  return fluxes.reduce((sum, flux) => sum + flux, 0) / fluxes.length;
}

/**
 * 两档亮度的差（mag_low - mag_normal）。
 * 正值表示低档更暗；配合 `darkeningFraction` 给出被削减的光通量比例。
 */
export function darkeningFraction(deltaMag) {
  if (!Number.isFinite(deltaMag)) throw new Error(`亮度差 ${deltaMag} 不是有限数值`);
  return 1 - Math.pow(10, -0.4 * deltaMag);
}

/** 通量比 → mag 差（正值 = 通量下降）。 */
export function fluxRatioToMag(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`通量比 ${ratio} 必须为正数`);
  return -2.5 * Math.log10(ratio);
}

function assertPositiveFlux(flux) {
  if (!Number.isFinite(flux) || flux <= 0) {
    throw new Error(`通量 ${flux} 必须为有限正数`);
  }
}
