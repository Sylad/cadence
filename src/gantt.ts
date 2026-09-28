import type { Day } from './dates.js';
import type { Bar } from './schedule.js';

export interface GanttData {
  project: string;
  today: Day;
  generated: string;
  bars: {
    id: string;
    title: string;
    status: string;
    quickwin: boolean;
    start: Day;
    end: Day;
    projected: boolean;
    commits: number;
    estimate: number;
    after: string[];
    tasks: { done: number; total: number };
    notes: { date: Day; text: string }[];
  }[];
}

export function ganttData(project: string, bars: Bar[], today: Day, generated: string): GanttData {
  return {
    project,
    today,
    generated,
    bars: bars.map((b) => ({
      id: b.lot.id,
      title: b.lot.title,
      status: b.lot.status,
      quickwin: b.lot.quickwin,
      start: b.start,
      end: b.end,
      projected: b.projected,
      commits: b.commits,
      estimate: b.lot.estimate,
      after: b.lot.after,
      tasks: { done: b.lot.tasks.filter((t) => t.status === 'done').length, total: b.lot.tasks.length },
      notes: b.lot.notes,
    })),
  };
}

/** A single self-contained HTML file: data, style and script inline, no network access. */
export function renderGantt(data: GanttData): string {
  // `</` fermerait la balise script : on l'échappe dans le JSON embarqué.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = escapeHtml(`${data.project} — reste à faire`);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p class="meta">Généré le <span id="generated"></span> par raf · aujourd'hui <span id="today"></span></p>
  <div class="controls">
    <label><input type="checkbox" id="show-done" checked> terminés</label>
    <label><input type="checkbox" id="show-dropped"> abandonnés</label>
    <span class="legend">
      <i class="sw todo"></i>à faire <i class="sw doing"></i>en cours <i class="sw done"></i>terminé <i class="sw dropped"></i>abandonné <b>⚡</b> quickwin
    </span>
  </div>
</header>
<main>
  <div id="chart" role="img" aria-label="Diagramme de Gantt du plan"></div>
  <div id="tip" hidden></div>
  <table>
    <thead><tr><th>Lot</th><th>Titre</th><th>Statut</th><th>Est. (j)</th><th>Début</th><th>Fin</th><th>Commits</th><th>Dernière note</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</main>
<script type="application/json" id="raf-data">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root { --bg:#fff; --fg:#1b1f24; --muted:#636c76; --grid:#e3e6ea; --todo:#8c959f; --doing:#0969da; --done:#1a7f37; --dropped:#cf222e; --today:#bf8700; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --grid:#262c36; --todo:#6e7781; --doing:#4493f8; --done:#3fb950; --dropped:#f85149; --today:#d29922; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header, main { padding: 16px 24px; }
h1 { margin:0 0 4px; font-size:20px; }
.meta { margin:0 0 8px; color:var(--muted); }
.controls { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
.legend { color:var(--muted); display:flex; gap:6px; align-items:center; }
.sw { display:inline-block; width:12px; height:12px; border-radius:2px; margin-left:8px; }
.sw.todo { background:var(--todo); } .sw.doing { background:var(--doing); } .sw.done { background:var(--done); } .sw.dropped { background:var(--dropped); }
#chart { overflow-x:auto; border:1px solid var(--grid); border-radius:6px; }
svg text { fill:var(--fg); font-size:12px; }
svg .axis { fill:var(--muted); }
svg .grid { stroke:var(--grid); }
svg .today { stroke:var(--today); stroke-width:2; }
svg .bar { rx:3; }
svg .bar.todo { fill:var(--todo); } svg .bar.doing { fill:var(--doing); } svg .bar.done { fill:var(--done); } svg .bar.dropped { fill:var(--dropped); }
svg .bar.projected { fill-opacity:.55; stroke-dasharray:4 3; stroke:var(--fg); stroke-opacity:.35; }
svg .row:hover .bar { stroke:var(--fg); stroke-opacity:.8; }
#tip { position:fixed; max-width:360px; padding:8px 10px; border-radius:6px; background:var(--fg); color:var(--bg); font-size:12px; pointer-events:none; z-index:2; }
#tip p { margin:2px 0; }
table { width:100%; border-collapse:collapse; margin-top:20px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--grid); vertical-align:top; }
th { color:var(--muted); font-weight:600; }
td.st-doing { color:var(--doing); } td.st-done { color:var(--done); } td.st-dropped { color:var(--dropped); }
`;

// Script du navigateur : construit le SVG avec l'API DOM (jamais innerHTML sur les données).
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('raf-data').textContent);
  var NS = 'http://www.w3.org/2000/svg';
  var DAY = 86400000, COL = 18, ROW = 26, LABEL = 280, HEAD = 34;
  var LABELS = { todo: 'à faire', doing: 'en cours', done: 'terminé', dropped: 'abandonné' };
  document.getElementById('generated').textContent = data.generated;
  document.getElementById('today').textContent = data.today;
  var ms = function (d) { return Date.parse(d + 'T00:00:00Z'); };
  var el = function (name, attrs, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };
  var tip = document.getElementById('tip');
  function showTip(ev, b) {
    tip.replaceChildren();
    var lines = [b.id + ' — ' + b.title, LABELS[b.status] + (b.projected ? ' (prévision)' : '') + ' · ' + b.start + ' → ' + b.end,
      'estimation ' + b.estimate + ' j · ' + b.commits + ' commit(s)' + (b.tasks.total ? ' · sous-tâches ' + b.tasks.done + '/' + b.tasks.total : '')];
    if (b.after.length) lines.push('après ' + b.after.join(', '));
    b.notes.slice(-3).forEach(function (n) { lines.push(n.date + ' : ' + n.text); });
    lines.forEach(function (t, i) { var p = document.createElement('p'); p.textContent = t; if (i === 0) p.style.fontWeight = '600'; tip.appendChild(p); });
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - 380) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
  }
  function render() {
    var showDone = document.getElementById('show-done').checked;
    var showDropped = document.getElementById('show-dropped').checked;
    var bars = data.bars.filter(function (b) { return (showDone || b.status !== 'done') && (showDropped || b.status !== 'dropped'); });
    var chart = document.getElementById('chart');
    chart.replaceChildren();
    if (!bars.length) { chart.textContent = 'Rien à afficher.'; return; }
    var min = Math.min.apply(null, bars.map(function (b) { return ms(b.start); }).concat([ms(data.today)])) - 2 * DAY;
    var max = Math.max.apply(null, bars.map(function (b) { return ms(b.end); }).concat([ms(data.today)])) + 3 * DAY;
    var days = Math.round((max - min) / DAY);
    var x = function (d) { return LABEL + Math.round((ms(d) - min) / DAY) * COL; };
    var svg = el('svg', { width: LABEL + days * COL + 10, height: HEAD + bars.length * ROW + 10 });
    for (var i = 0; i <= days; i++) {
      var t = new Date(min + i * DAY);
      if (t.getUTCDay() === 1) {
        var gx = LABEL + i * COL;
        svg.appendChild(el('line', { x1: gx, x2: gx, y1: HEAD - 6, y2: HEAD + bars.length * ROW, class: 'grid' }));
        svg.appendChild(el('text', { x: gx + 3, y: 18, class: 'axis' }, t.toISOString().slice(5, 10)));
      }
    }
    bars.forEach(function (b, r) {
      var y = HEAD + r * ROW;
      var g = el('g', { class: 'row', tabindex: 0 });
      g.appendChild(el('text', { x: 8, y: y + 17 }, (b.quickwin ? '⚡ ' : '') + b.id + '  ' + (b.title.length > 34 ? b.title.slice(0, 33) + '…' : b.title)));
      var bx = x(b.start), bw = Math.max(COL - 2, x(b.end) + COL - bx - 2);
      g.appendChild(el('rect', { x: bx, y: y + 5, width: bw, height: ROW - 10, class: 'bar ' + b.status + (b.projected && b.status !== 'doing' ? ' projected' : '') }));
      g.addEventListener('mousemove', function (ev) { showTip(ev, b); });
      g.addEventListener('mouseleave', function () { tip.hidden = true; });
      svg.appendChild(g);
    });
    var tx = x(data.today) + COL / 2;
    svg.appendChild(el('line', { x1: tx, x2: tx, y1: HEAD - 10, y2: HEAD + bars.length * ROW, class: 'today' }));
    chart.appendChild(svg);
    var today = x(data.today) - LABEL;
    chart.scrollLeft = Math.max(0, today - chart.clientWidth / 3);

    var rows = document.getElementById('rows');
    rows.replaceChildren();
    bars.forEach(function (b) {
      var tr = document.createElement('tr');
      var last = b.notes.length ? b.notes[b.notes.length - 1] : null;
      [b.id, (b.quickwin ? '⚡ ' : '') + b.title, LABELS[b.status], String(b.estimate), b.start, b.end, String(b.commits), last ? last.date + ' : ' + last.text : '']
        .forEach(function (v, i) { var td = document.createElement('td'); td.textContent = v; if (i === 2) td.className = 'st-' + b.status; tr.appendChild(td); });
      rows.appendChild(tr);
    });
  }
  document.getElementById('show-done').addEventListener('change', render);
  document.getElementById('show-dropped').addEventListener('change', render);
  render();
})();
`;
