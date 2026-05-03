// The coverage strip shows data density across the selected range.
// Two stacked rows: top = raw_signal_count (bar height proportional
// to log of count), bottom = segment seconds (bar opacity proportional
// to coverage fraction of the day).
//
// Click on the strip to jump to a date.

import { toYMD, dayStartUTC, dayEndUTC } from './api.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class CoverageStrip {
  constructor(svg, axis, onPick) {
    this.svg = svg;
    this.axis = axis;
    this.onPick = onPick;
    this.days = [];
    this.startYMD = null;
    this.endYMD = null;

    svg.addEventListener('click', (e) => this.handleClick(e));
  }

  /** days: array from /coverage. We store but only render between
      startYMD..endYMD (inclusive). */
  setData(days) {
    this.days = days;
    this.render();
  }

  setRange(startYMD, endYMD) {
    this.startYMD = startYMD;
    this.endYMD = endYMD;
    this.render();
  }

  render() {
    const { svg, days, startYMD, endYMD, axis } = this;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!days.length || !startYMD || !endYMD) return;

    const start = new Date(startYMD + 'T00:00:00Z');
    const end = new Date(endYMD + 'T00:00:00Z');
    const totalDays = Math.round((end - start) / 86400000) + 1;
    if (totalDays <= 0) return;

    // Build a quick lookup by YYYY-MM-DD.
    const byDay = new Map();
    for (const d of days) byDay.set(d.day, d);

    // Determine max raw count for log-scaling bar heights.
    let maxRaw = 1;
    for (const d of days) if (d.raw_signal_count > maxRaw) maxRaw = d.raw_signal_count;
    const logMax = Math.log10(maxRaw + 1);

    // Drawing setup. We use viewBox so the SVG scales with the
    // sidebar width.
    const W = 1000;       // virtual pixels; scales via viewBox
    const H = 24;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const colW = W / totalDays;

    // Background guide line — middle horizontal
    const guide = document.createElementNS(SVG_NS, 'line');
    guide.setAttribute('x1', 0);
    guide.setAttribute('x2', W);
    guide.setAttribute('y1', H / 2);
    guide.setAttribute('y2', H / 2);
    guide.setAttribute('stroke', 'var(--c-rule)');
    guide.setAttribute('stroke-width', '0.5');
    svg.appendChild(guide);

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const ymd = toYMD(d);
      const row = byDay.get(ymd);
      if (!row) continue;

      const x = i * colW;

      // Top half: raw signals (bars going up from middle).
      if (row.raw_signal_count > 0) {
        const h = (Math.log10(row.raw_signal_count + 1) / logMax) * (H / 2);
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', H / 2 - h);
        r.setAttribute('width', Math.max(colW * 0.8, 0.5));
        r.setAttribute('height', h);
        r.setAttribute('fill', 'var(--c-signal)');
        svg.appendChild(r);
      }
      // Bottom half: segment coverage as opacity.
      if (row.segment_seconds > 0) {
        const frac = Math.min(1, row.segment_seconds / 86400);
        const r = document.createElementNS(SVG_NS, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', H / 2);
        r.setAttribute('width', Math.max(colW * 0.8, 0.5));
        r.setAttribute('height', H / 2);
        r.setAttribute('fill', 'var(--c-visit)');
        r.setAttribute('opacity', String(0.2 + 0.8 * frac));
        svg.appendChild(r);
      }
    }

    // Axis labels.
    if (axis) {
      const months = [];
      const stride = totalDays > 730 ? 6 : totalDays > 180 ? 3 : 1;
      const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      while (cur <= end) {
        if (cur.getUTCMonth() % stride === 0) {
          months.push(cur.toLocaleString(undefined, {
            month: 'short', year: 'numeric',
          }));
        }
        cur.setUTCMonth(cur.getUTCMonth() + 1);
      }
      axis.textContent = '';
      // Show first and last labels at minimum.
      if (months.length === 0) {
        const left = document.createElement('span');
        left.textContent = startYMD;
        axis.appendChild(left);
        const right = document.createElement('span');
        right.textContent = endYMD;
        axis.appendChild(right);
      } else {
        const max = 5; // don't overcrowd
        const stepN = Math.max(1, Math.ceil(months.length / max));
        for (let i = 0; i < months.length; i += stepN) {
          const span = document.createElement('span');
          span.textContent = months[i];
          axis.appendChild(span);
        }
      }
    }
  }

  handleClick(e) {
    if (!this.startYMD || !this.endYMD || !this.onPick) return;
    const rect = this.svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const start = new Date(this.startYMD + 'T00:00:00Z').getTime();
    const end = new Date(this.endYMD + 'T00:00:00Z').getTime();
    const ms = start + fx * (end - start);
    this.onPick(toYMD(new Date(ms)));
  }
}
