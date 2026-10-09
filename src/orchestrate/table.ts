import { isAncestor } from '../git.js';
import { quotaReset } from './result.js';
import type { LotState, StepState, WaveState } from './state.js';

const k = (n: number) => `${Math.round(n / 1000)} k`;
const m = (n: number) => `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;

const LABEL: Record<LotState['status'], string> = {
  queued: 'en attente',
  implementing: 'implémentation',
  reviewing: 'revue',
  fixing: 'correction',
  question: 'question',
  ready: 'prêt à livrer',
  'handed-back': 'rendu au lead',
  failed: 'échec',
  suspended: 'suspendu',
};

function review(l: LotState): string {
  if (!l.code) return '—';
  const fixes = l.pass === 0 ? '' : ` après ${l.pass} correction${l.pass > 1 ? 's' : ''}`;
  if (l.status === 'ready') return `conforme${fixes}`;
  const verdict = l.code.conforme ? 'conforme' : `non conforme (${l.code.bloquants} bloquant, ${l.code.majeurs} majeur)`;
  // Rendu, échoué ou suspendu pour une autre cause que la revue (dépôt sale, session coupée…) : la colonne ne présente pas
  // un verdict de revue comme la cause ; elle donne le dernier verdict réel, la cause est dans les lignes sous le tableau.
  const stopped = l.status === 'handed-back' || l.status === 'failed' || l.status === 'suspended' || l.status === 'question';
  const last = l.steps[l.steps.length - 1];
  const byReview = !l.code.conforme && !!last && last.status === 'ok' && (last.kind === 'review' || last.kind === 'review-small');
  if (stopped && !byReview) return `${verdict} (dernier verdict ; rendu pour une autre cause)`;
  return verdict;
}

function ux(l: LotState): string {
  if (!l.visible) return '—';
  if (l.ux) return l.ux.conforme ? 'conforme (à enregistrer par le lead)' : `non conforme (${l.ux.bloquants + l.ux.majeurs})`;
  return 'à faire par le lead';
}

const commits = (l: LotState) => new Set(l.steps.flatMap((s: StepState) => s.commits ?? [])).size;
const counted = (l: LotState) => l.steps.reduce((n, s) => n + (s.tokens?.counted ?? 0), 0);
const minutes = (l: LotState) => Math.round(l.steps.reduce((n, s) => n + (s.ended ? Date.parse(s.ended) - Date.parse(s.started) : 0), 0) / 60_000);

/** Commits du lot dans son dépôt, du plus ancien au plus récent (ceux d'un dépôt voisin, `[rel] sha`, sont écartés). */
const own = (l: LotState): string[] => [...new Set(l.steps.flatMap((s) => s.commits ?? []).filter((c) => !c.startsWith('[')))];

/**
 * Lots empilés sur main (L76) : un lot prêt sous un lot non prêt n'est livrable que jusqu'à son dernier commit.
 * Par dépôt, le plus haut dernier commit d'un lot prêt qui n'a aucun commit d'un lot non prêt sous lui et en a au moins un au-dessus.
 */
function deliverable(lots: LotState[], ancestor: (repo: string, a: string, b: string) => boolean): { ready: LotState; sha: string; under: LotState }[] {
  const out: { ready: LotState; sha: string; under: LotState }[] = [];
  for (const repo of new Set(lots.map((l) => l.repo))) {
    const here = lots.filter((l) => l.repo === repo);
    const blocked = here.filter((l) => l.status !== 'ready' && own(l).length > 0).map((l) => ({ lot: l, first: own(l)[0] }));
    const ready = here.filter((l) => l.status === 'ready' && own(l).length > 0).map((l) => ({ lot: l, last: own(l).at(-1)! }));
    const ok = ready.filter((r) => blocked.every((b) => !ancestor(repo, b.first, r.last)));
    const above = ok.map((r) => ({ ...r, under: blocked.find((b) => ancestor(repo, r.last, b.first))?.lot })).filter((r) => r.under);
    const top = above.find((r) => above.every((o) => ancestor(repo, o.last, r.last)));
    if (top) out.push({ ready: top.lot, sha: top.last, under: top.under! });
  }
  return out;
}

/** Le tableau de fin de vague (ou de `--status`), une ligne par lot puis le total et les questions. */
export function renderTable(wave: WaveState, lots: LotState[], deps: { isAncestor?: (repo: string, a: string, b: string) => boolean } = {}): string[] {
  const rows = lots.map((l) => [`${l.project}:${l.lot}`, LABEL[l.status], String(l.pass), review(l), ux(l), String(commits(l)), k(counted(l)), `${minutes(l)} min`]);
  const head = ['lot', 'état', 'passes', 'revue', 'UX', 'commits', 'tokens', 'durée'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(head), ...rows.map(line)];
  const by = (s: LotState['status']) => lots.filter((l) => l.status === s).length;
  const tail = [`${by('ready')} prêt(s)`, by('question') ? `${by('question')} question(s)` : '', by('handed-back') + by('failed') ? `${by('handed-back') + by('failed')} rendu(s) au lead` : '', by('suspended') ? `${by('suspended')} suspendu(s)` : ''].filter(Boolean);
  out.push(`vague ${wave.id} : ${k(wave.consumed)} / ${m(wave.budget)} comptés (lecture de cache ${m(wave.cacheRead)}) — ${tail.join(', ')} — ${wave.status}`);
  for (const l of lots.filter((x) => x.status === 'question')) {
    out.push(`question : ${l.project}:${l.lot} — « ${l.questions.join(' / ')} » (cadence orchestrate --resume --answer ${l.project}:${l.lot} "…")`);
  }
  for (const l of lots.filter((x) => x.status === 'handed-back' || x.status === 'failed' || x.status === 'suspended')) {
    out.push(`${l.project}:${l.lot} — ${l.outcome ?? LABEL[l.status]}`);
    for (const c of l.status === 'handed-back' ? l.constats : []) out.push(`    · [${c.gravite}] ${c.fichier ? `${c.fichier}${c.ligne ? `:${c.ligne}` : ''} — ` : ''}${c.texte.split('\n')[0]}`);
  }
  for (const d of deliverable(lots, deps.isAncestor ?? isAncestor)) {
    out.push(`${d.ready.project}:${d.ready.lot} — livrable jusqu'à ${d.sha} (dernier commit de ${d.ready.lot}, sous ${d.under.lot} ${d.under.status === 'handed-back' || d.under.status === 'failed' ? 'rendu' : LABEL[d.under.status]}) : cadence deliver --sha ${d.sha}`);
  }
  for (const l of lots) {
    if (l.uxNote) out.push(`${l.project}:${l.lot} — ${l.uxNote}`);
    if (l.uxCaptures) out.push(`${l.project}:${l.lot} — captures Playwright : ${l.uxCaptures}`);
    for (const w of l.warnings) out.push(`${l.project}:${l.lot} — ⚠ ${w}`);
    for (const x of l.choix ?? []) out.push(`${l.project}:${l.lot} — choix fait : ${x}`);
    for (const p of l.proposals) out.push(`${l.project}:${l.lot} — proposé : ${p}`);
    if (l.uxVerdict && l.visible) out.push(`${l.project}:${l.lot} — verdict UX pour « raf ux » : ${l.uxVerdict}`);
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Le message de quota lisible : sans l'horodatage brut après « | », avec l'heure de remise locale quand il la donne. */
export function quotaText(message: string): string {
  const reset = quotaReset(message);
  const text = message.trim().replace(/\|\d{9,}\s*$/, '').trim();
  if (!reset) return text;
  return `${text} — remise le ${reset.getFullYear()}-${two(reset.getMonth() + 1)}-${two(reset.getDate())} à ${two(reset.getHours())}:${two(reset.getMinutes())}`;
}
