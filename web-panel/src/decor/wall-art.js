/**
 * 山雾 A · 渲染器（落地版）
 *
 * 只带两个数据层，full 大图不进这个包：
 *   wall-trace-lite.js  lite 960×611 · 6 档 —— 正文区大图（55KB gzip）
 *   wall-trace-sil.js   sil  720×458 · 2 档 —— 侧栏下沿完整轮廓（9KB gzip）
 *
 * 形状来自真实长城照片的分色描摹（vtracer，贝塞尔边界、区域互不重叠），
 * 不是手绘。渲染只做三件事：
 *   1) 逐区叠色：每区 currentColor + 自带 opacity，天空留白
 *   2) 整幅一次「洗」：所有区域在同一组里做一次高斯模糊 + 轻度膨胀，
 *      相邻区共用同一次重采样，交界处不会露白缝
 *   3) 远山单独垫一层长距离模糊的雾，让山从雾里长出来
 */

import { LAYERS as LITE, TRACE_W as LITE_W, TRACE_H as LITE_H } from './wall-trace-lite.js';
import { LAYERS as SIL, TRACE_W as SIL_W, TRACE_H as SIL_H } from './wall-trace-sil.js';

const HAZE = [
  [0.135, 10, 0.55],
  [0.3, 4.0, 0.16],
];
const WASH_BLUR = 2.2;

const SETS = {
  lite: { L: LITE, W: LITE_W, H: LITE_H, haze: HAZE, wash: WASH_BLUR, mist: true },
  sil: { L: SIL, W: SIL_W, H: SIL_H, haze: [], wash: 2.0, mist: false },
};

/**
 * @param {string} scope  SVG 内 id 前缀，同页多份时必须不同
 * @param {string} [box]  viewBox，缺省用整幅
 * @param {'slice'|'meet'} [fit]
 * @param {'lite'|'sil'} [variant]
 * @param {boolean} [soft] false 时关掉虚化（用于对照）
 */
export function wallArt(scope = 'mb', box, fit = 'slice', variant = 'lite', soft = true) {
  const S = SETS[variant] || SETS.lite;
  const s = scope;
  const vb = box || `0 0 ${S.W} ${S.H}`;
  const path = (L) => `<path d="${L.d}" transform="${L.t}" fill="currentColor" opacity="${L.o}"/>`;

  const haze = soft ? S.haze : [];
  const hazeG = haze
    .map(([max, , dim], i) => {
      const ps = S.L.filter((L) => L.o <= max).map(path);
      return ps.length ? `<g filter="url(#${s}-h${i})" opacity="${dim}">${ps.join('')}</g>` : '';
    })
    .join('');

  const defsHaze = haze
    .map(
      ([, blur], i) =>
        `<filter id="${s}-h${i}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter>`,
    )
    .join('');

  const defsInk = `<filter id="${s}-i" x="-15%" y="-15%" width="130%" height="130%">
      <feMorphology operator="dilate" radius="0.8" result="solid"/>
      <feGaussianBlur in="solid" stdDeviation="${soft === false ? 0 : S.wash}"/>
    </filter>`;

  const defsMist = S.mist
    ? `<filter id="${s}-mist" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="20"/></filter>`
    : '';

  const mist = S.mist
    ? `<g filter="url(#${s}-mist)" fill="#fff" stroke="#fff" fill-opacity="0" stroke-opacity="0.09">
    <path d="M -60 ${Math.round(S.H * 0.6)} C ${Math.round(S.W * 0.3)} ${Math.round(S.H * 0.55)}
             ${Math.round(S.W * 0.62)} ${Math.round(S.H * 0.64)} ${Math.round(S.W * 1.08)} ${Math.round(S.H * 0.6)}"
          stroke-width="${Math.round(S.H * 0.09)}"/>
    <path d="M -60 ${Math.round(S.H * 0.4)} C ${Math.round(S.W * 0.35)} ${Math.round(S.H * 0.36)}
             ${Math.round(S.W * 0.72)} ${Math.round(S.H * 0.44)} ${Math.round(S.W * 1.08)} ${Math.round(S.H * 0.41)}"
          stroke-width="${Math.round(S.H * 0.06)}" stroke-opacity="0.07"/>
  </g>`
    : '';

  return `
<svg class="wall-art" viewBox="${vb}" preserveAspectRatio="xMidYMax ${fit}" aria-hidden="true" focusable="false">
  <defs>${defsHaze}${defsInk}${defsMist}</defs>
  ${hazeG}
  <g filter="url(#${s}-i)">${S.L.map(path).join('')}</g>
  ${mist}
</svg>`;
}
