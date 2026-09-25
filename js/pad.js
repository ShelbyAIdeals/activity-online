// Drawing surface. Points are stored normalised to the canvas width, so a
// drawing looks the same on every screen and survives resizes. Strokes are
// sent in small segments while drawing so other players see them live.
import { icon } from './icons.js';

export const PAD_COLORS = ['#1f2328', '#e5484d', '#3e63dd', '#2f9e5b'];
const PAPER = '#ffffff';
const WIDTHS = { thin: 0.007, thick: 0.018, eraser: 0.06 };
const RATIO = 0.75;
const MAX_POINTS = 400;

export function validSeg(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.id !== 'string' || s.id.length > 16) return false;
  if (typeof s.c !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.c)) return false;
  if (typeof s.w !== 'number' || !(s.w > 0 && s.w <= 0.1)) return false;
  const p = s.p;
  if (!Array.isArray(p) || p.length < 2 || p.length > MAX_POINTS * 2 || p.length % 2) return false;
  return p.every((n) => typeof n === 'number' && n >= -0.05 && n <= 1.05);
}

const round = (n) => Math.round(n * 10000) / 10000;

export class Pad {
  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'pad';
    this.root.innerHTML = `<div class="pad-tools">
      ${PAD_COLORS.map((c) => `<button type="button" class="sw" data-pad="color" data-v="${c}" style="--c:${c}"></button>`).join('')}
      <button type="button" data-pad="width" data-v="thin">${icon('thin')}</button>
      <button type="button" data-pad="width" data-v="thick">${icon('thick')}</button>
      <button type="button" data-pad="eraser">${icon('eraser')}</button>
      <span class="sep"></span>
      <button type="button" data-pad="clear">${icon('trash')}</button>
    </div><canvas></canvas>`;
    this.tools = this.root.querySelector('.pad-tools');
    this.canvas = this.root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.segs = [];
    this.w = 0;
    this.editable = false;
    this.color = PAD_COLORS[0];
    this.width = 'thin';
    this.erasing = false;
    this.stroke = null;
    this.flushTimer = 0;
    this.onSeg = null;
    this.onClear = null;

    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', () => this.up());
    this.canvas.addEventListener('pointercancel', () => this.up());
    this.tools.addEventListener('click', (e) => this.tool(e));
    this.syncTools();
  }

  setLabels(l) {
    const set = (sel, text) => this.tools.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-label', text));
    set('[data-pad="color"]', l.color);
    set('[data-v="thin"]', l.thin);
    set('[data-v="thick"]', l.thick);
    set('[data-pad="eraser"]', l.eraser);
    set('[data-pad="clear"]', l.clear);
  }

  setEditable(on) {
    if (!on) this.up();
    this.editable = on;
    this.root.classList.toggle('editable', on);
    this.tools.hidden = !on;
  }

  tool(e) {
    const b = e.target.closest('[data-pad]');
    if (!b || !this.editable) return;
    const kind = b.dataset.pad;
    if (kind === 'color') {
      this.color = b.dataset.v;
      this.erasing = false;
    } else if (kind === 'width') {
      this.width = b.dataset.v;
      this.erasing = false;
    } else if (kind === 'eraser') {
      this.erasing = !this.erasing;
    } else if (kind === 'clear') {
      this.clear();
      this.onClear?.();
    }
    this.syncTools();
  }

  syncTools() {
    this.tools.querySelectorAll('[data-pad]').forEach((b) => {
      const k = b.dataset.pad;
      const on =
        (k === 'color' && !this.erasing && b.dataset.v === this.color) ||
        (k === 'width' && !this.erasing && b.dataset.v === this.width) ||
        (k === 'eraser' && this.erasing);
      if (k !== 'clear') b.setAttribute('aria-pressed', String(on));
    });
  }

  resize() {
    const width = this.canvas.getBoundingClientRect().width;
    if (!width || (Math.abs(width - this.w) < 0.5 && this.canvas.width)) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = width;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(width * RATIO * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  redraw() {
    this.ctx.fillStyle = PAPER;
    this.ctx.fillRect(0, 0, this.w, this.w * RATIO);
    for (const s of this.segs) this.paint(s);
  }

  paint(s) {
    const k = this.w;
    const ctx = this.ctx;
    const p = s.p;
    ctx.strokeStyle = ctx.fillStyle = s.c;
    ctx.lineWidth = Math.max(1, s.w * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (p.length === 2) {
      ctx.arc(p[0] * k, p[1] * k, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.moveTo(p[0] * k, p[1] * k);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * k, p[i + 1] * k);
    ctx.stroke();
  }

  add(s) {
    if (!validSeg(s)) return;
    this.segs.push(s);
    if (this.w) this.paint(s);
  }

  load(list) {
    this.segs = Array.isArray(list) ? list.filter(validSeg) : [];
    if (this.w) this.redraw();
  }

  clear() {
    this.stroke = null;
    this.segs = [];
    if (this.w) this.redraw();
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [round((e.clientX - r.left) / r.width), round((e.clientY - r.top) / r.width)];
  }

  down(e) {
    if (!this.editable || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.stroke = {
      id: Math.random().toString(36).slice(2, 10),
      c: this.erasing ? PAPER : this.color,
      w: WIDTHS[this.erasing ? 'eraser' : this.width],
      pts: this.point(e),
      prev: null,
    };
    this.flush();
  }

  move(e) {
    if (!this.stroke) return;
    const events = e.getCoalescedEvents?.() || [e];
    for (const ev of events) this.stroke.pts.push(...this.point(ev));
    if (this.stroke.pts.length >= MAX_POINTS) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
  }

  up() {
    if (!this.stroke) return;
    this.flush();
    this.stroke = null;
  }

  // Each segment repeats the last point of the previous one so the line stays
  // continuous when segments are drawn separately on other screens.
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    const st = this.stroke;
    if (!st || !st.pts.length) return;
    const p = st.prev ? [...st.prev, ...st.pts] : st.pts;
    const seg = { id: st.id, c: st.c, w: st.w, p };
    st.prev = p.slice(-2);
    st.pts = [];
    this.add(seg);
    this.onSeg?.(seg);
  }
}
