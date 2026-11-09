/**
 * 山雾 A · 挂载
 *
 * 只做三件事：
 *   1) 在纸页外壳里放 .mb-yard（正文大图），在侧栏里放 .mb-side（下沿轮廓）
 *   2) 滚动时给 --mb-par 一个 ≤18px 的位移（纯 transform，不读布局）
 *   3) 结构被重建时补回来（Vue 路由切换、热更新都不怕）
 *
 * 开关不在这里：面板已有「氛围效果」按钮，给祖先加 .no-atmosphere 即可，
 * 本文件不持有任何状态，也不写 localStorage。
 */
import { wallArt } from './wall-art.js';

const state = new WeakMap();

/**
 * @param {object} [opts]
 * @param {string|Element} [opts.host]      纸页外壳（position: relative），默认 '.mb-mist'
 * @param {string} [opts.sidebar]           侧栏容器，默认 '.sidebar'
 * @param {'lite'|'sil'} [opts.variant]     正文大图精度，默认 'lite'
 * @param {boolean} [opts.side]             是否挂侧栏轮廓，默认 true
 * @param {string} [opts.scroller]          滚动容器，默认 'main'
 * @param {boolean} [opts.parallax]         是否要滚动视差，默认 true
 */
export function mountMist(opts = {}) {
  const {
    host = '.mb-mist',
    sidebar = '.sidebar',
    variant = 'lite',
    side = true,
    scroller = 'main',
    parallax = true,
  } = opts;

  const root = typeof host === 'string' ? document.querySelector(host) : host;
  if (!root) return null;
  if (state.has(root)) return state.get(root);

  root.classList.add('mb-mist');

  const ensure = () => {
    let yard = root.querySelector(':scope > .mb-yard');
    if (!yard) {
      yard = document.createElement('div');
      yard.className = 'mb-yard';
      yard.setAttribute('aria-hidden', 'true');
      yard.innerHTML = wallArt('mb', null, 'slice', variant);
      root.prepend(yard);
    }
    if (!side) return;
    const bar = root.querySelector(sidebar);
    if (bar && !bar.querySelector(':scope > .mb-side')) {
      const el = document.createElement('div');
      el.className = 'mb-side';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = wallArt('mb-side', null, 'slice', 'sil', false);
      bar.prepend(el);
    }
  };
  ensure();

  // 首帧淡入：装饰先以透明挂上，下一帧再放行，避免懒加载完成后「跳出来」
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('mb-ready')));

  // 结构重建后补挂（只在装饰层缺失时才动 DOM）
  const mo = new MutationObserver(() => {
    if (!root.querySelector(':scope > .mb-yard')) ensure();
  });
  mo.observe(root, { childList: true, subtree: true });

  // 滚动视差：一帧最多写一次变量
  let raf = 0;
  const scrollEl = (scroller && document.querySelector(scroller)) || null;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = scrollEl ? scrollEl.scrollTop : window.scrollY;
      const shift = Math.min(18, Math.max(-18, top * 0.05));
      root.style.setProperty('--mb-par', `${shift.toFixed(1)}px`);
    });
  };
  if (parallax && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    (scrollEl || window).addEventListener('scroll', onScroll, { passive: true });
  }

  const ctrl = {
    root,
    destroy() {
      mo.disconnect();
      (scrollEl || window).removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      root.querySelector(':scope > .mb-yard')?.remove();
      root.querySelector(`${sidebar} > .mb-side`)?.remove();
      root.classList.remove('mb-mist', 'mb-ready');
      root.style.removeProperty('--mb-par');
      state.delete(root);
    },
  };
  state.set(root, ctrl);
  return ctrl;
}

export { wallArt };
