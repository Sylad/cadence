import { lotWork } from '../audit.js';
import { planLoader } from '../config.js';
import { gitRoot, isAncestor } from '../git.js';
import { repoWork } from '../repos.js';
import { quotaReset } from './result.js';
import type { LotState, StepState, WaveState } from './state.js';

const k = (n: number) => `${Math.round(n / 1000)} k`;
const m = (n: number) => `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;

export const LABEL: Record<LotState['status'], string> = {
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

/** L'issue d'une escalade de modèle (L337), telle que le tableau la dit. */
const ESCALATION_TEXT = {
  rendu: "lot rendu malgré l'escalade : à l'humain ou à un arbitrage",
  'non jouée': 'non jouée, le budget du lot ne la couvrait pas',
  échec: "session escaladée sans résultat : le modèle n'a pas jugé le lot (est-il accessible à ce compte ?), reprise par le lead",
} as const;

/** La ligne « escalade » d'un lot : l'issue de l'escalade, lue avec l'état du lot (le tableau sert aussi à `--status` et à une vague suspendue). */
function escalationText(l: LotState): string {
  const e = l.escalation!;
  if (!e.issue) {
    // Sans issue : l'escalade a été engagée, personne ne l'a tranchée. « en cours » ne se dit que d'un lot qui tourne : un lot retiré (--drop), en échec ou rendu avant le verdict du modèle n'est pas vivant.
    if (l.status === 'handed-back' || l.status === 'failed') return 'engagée, lot rendu avant le verdict du modèle (retrait, incident ou erreur : voir la ligne du lot), le modèle ne l\'a pas jugé';
    return e.stage === 'fix' ? 'en cours (une correction puis une revue neuve à ce modèle)' : 'engagée, pas encore tranchée';
  }
  if (e.issue !== 'conforme') return ESCALATION_TEXT[e.issue];
  if (l.status === 'ready') return 'revue neuve conforme, lot rendu prêt';
  if (l.status === 'handed-back' || l.status === 'failed') return 'revue neuve conforme, lot rendu pour un autre motif (voir la ligne du lot)';
  return 'revue neuve conforme, le lot poursuit sa fin ordinaire';
}

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
/** L'état d'un lot (L395) : « porte tests (3 min) » tant que la commande de la porte du programme tourne dans une vague vivante, sinon l'étiquette de son statut. Une porte restée dans l'état d'une vague arrêtée (processus tué) ne tourne plus. */
const stateText = (l: LotState, wave: WaveState, now: number): string => {
  if (!l.gate || wave.status !== 'running') return LABEL[l.status];
  const since = Date.parse(l.gate.started);
  return `porte ${l.gate.label}${Number.isFinite(since) ? ` (${Math.max(0, Math.floor((now - since) / 60_000))} min)` : ''}`;
};

const minutes = (l: LotState) => Math.round(l.steps.reduce((n, s) => n + (s.ended ? Date.parse(s.ended) - Date.parse(s.started) : 0), 0) / 60_000);

/** Sha abrégés (7, comme `short` du cycle) des commits que git attribue au lot dans son dépôt, du plus ancien au plus récent (illisible ou sans plan : aucun). */
function gitCommitsOf(l: LotState): string[] {
  try {
    return lotWork(planLoader(l.repo)(), l.repo, l.lot).map((c) => c.sha.slice(0, 7)).reverse();
  } catch {
    return [];
  }
}

const sameCommit = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

/**
 * Sha des commits du lot dans son dépôt : ceux que git attribue au lot (une session en échec, au rapport illisible ou coupée
 * par le quota n'a pas rempli `steps[].commits` ; ceux d'une vague précédente n'y sont pas), du plus ancien au plus récent,
 * puis ceux des étapes que git n'a pas retrouvés (entrées `<sha> <sujet>` ; ceux d'un dépôt voisin, `[rel] sha`, sont écartés).
 * Ce second groupe suit le premier sans respecter l'ordre de l'historique (git écarte les commits plan-seuls et de version, qui
 * reviennent par les étapes) : le premier et le dernier commit s'obtiennent par ascendance (`oldest`, `newest`), pas par position.
 */
function own(l: LotState, fromGit: (l: LotState) => string[]): string[] {
  const out = [...new Set(fromGit(l))];
  for (const c of l.steps.flatMap((s) => s.commits ?? []).filter((c) => !c.startsWith('[')).map((c) => c.split(' ')[0])) {
    if (!out.some((o) => sameCommit(o, c))) out.push(c);
  }
  return out;
}

/** Le plus récent des commits par ascendance (jamais la position) : `best` cède la place à `c` quand il en est un ancêtre. */
function newest(repo: string, shas: string[], ancestor: (repo: string, a: string, b: string) => boolean): string {
  return shas.reduce((best, c) => (ancestor(repo, best, c) ? c : best));
}

/** Le plus ancien des commits par ascendance : `best` cède la place à `c` quand il en est un descendant. */
function oldest(repo: string, shas: string[], ancestor: (repo: string, a: string, b: string) => boolean): string {
  return shas.reduce((best, c) => (ancestor(repo, c, best) ? c : best));
}

/**
 * Lots empilés sur main (L76) : un lot prêt sous un lot non prêt n'est livrable que jusqu'à son dernier commit.
 * Par dépôt, le plus haut dernier commit d'un lot prêt qui n'a aucun commit d'un lot non prêt sous lui et en a au moins un au-dessus.
 */
function deliverable(lots: LotState[], ancestor: (repo: string, a: string, b: string) => boolean, fromGit: (l: LotState) => string[]): { ready: LotState; sha: string; under: LotState }[] {
  const out: { ready: LotState; sha: string; under: LotState }[] = [];
  const mine = new Map(lots.map((l) => [l, own(l, fromGit)]));
  for (const repo of new Set(lots.map((l) => l.repo))) {
    const here = lots.filter((l) => l.repo === repo);
    const blocked = here.filter((l) => l.status !== 'ready' && mine.get(l)!.length > 0).map((l) => ({ lot: l, first: oldest(repo, mine.get(l)!, ancestor) }));
    const ready = here.filter((l) => l.status === 'ready' && mine.get(l)!.length > 0).map((l) => ({ lot: l, last: newest(repo, mine.get(l)!, ancestor) }));
    const ok = ready.filter((r) => blocked.every((b) => !ancestor(repo, b.first, r.last)));
    const above = ok.map((r) => ({ ...r, under: blocked.find((b) => ancestor(repo, r.last, b.first))?.lot })).filter((r) => r.under);
    const top = above.find((r) => above.every((o) => ancestor(repo, o.last, r.last)));
    if (top) out.push({ ready: top.lot, sha: top.last, under: top.under! });
  }
  return out;
}

/**
 * Sha abrégés des commits de `l` dans `repo` que git lui attribue — dans le dépôt de son projet (commits qui citent le lot) ou, quand `repo` est
 * l'un de ses dépôts voisins (clé `repos:`, L62), dans ce voisin (`repoWork` : commits qui citent le lot, dans sa période, et sa chaîne `cite:`).
 * Contrairement à `gitCommitsOf`, une lecture impossible LÈVE : plan du projet illisible ou qui ne connaît pas le lot, dépôt qui n'est plus un dépôt
 * git. « Aucun commit » et « commits illisibles » ne se confondent pas ici : la garde de `deliver --sha` refuse le second.
 */
export function gitCommitsIn(l: LotState, repo: string): string[] {
  const plan = planLoader(l.repo)();
  if (!plan.lots().some((x) => x.id === l.lot)) throw new Error(`le plan de ${l.repo} ne connaît pas le lot ${l.lot}`);
  const neighbour = l.repo === repo ? undefined : (l.repos ?? []).find((r) => r.path === repo);
  const where = neighbour ? neighbour.path : l.repo;
  if (!gitRoot(where)) throw new Error(`${where} n'est pas un dépôt git`);
  const work = neighbour ? repoWork(plan, neighbour, l.lot) : lotWork(plan, l.repo, l.lot);
  return work.map((c) => c.sha.slice(0, 7)).reverse();
}

/** Sha des commits que les étapes de `l` ont notés dans `repo` : entrées `<sha> <sujet>` pour son dépôt, `[rel] <sha> <sujet>` pour un voisin. */
function stepCommits(l: LotState, repo: string): string[] {
  const entries = l.steps.flatMap((s) => s.commits ?? []);
  const prefixes = l.repo === repo ? [] : (l.repos ?? []).filter((r) => r.path === repo).map((r) => `[${r.rel}] `);
  if (prefixes.length === 0) return entries.filter((c) => !c.startsWith('[')).map((c) => c.split(' ')[0]);
  return entries.flatMap((c) => prefixes.filter((p) => c.startsWith(p)).map((p) => c.slice(p.length).split(' ')[0]));
}

/** Ce que la garde de `deliver --sha` a établi sur les lots de la vague : ceux qui empêchent de livrer, et ceux dont on n'a pu vérifier les commits. */
export interface WaveGuard {
  blocking: LotState[];
  unreadable: LotState[];
}

/**
 * Livrer au fil de l'eau (L277) : les lots de la vague qui empêchent de livrer `sha` dans `repo` — ceux qui ne sont pas prêts (en cours, en file,
 * en question, suspendus, rendus, échoués) et dont un commit est dans l'histoire de `sha`. `blocking` vide ET `unreadable` vide : tous les commits de
 * `sha` qui citent un lot de la vague citent des lots prêts, revus (« prêt » est l'état d'un lot dont la revue est conforme) ; `sha` est
 * « livrable jusqu'à » de la vague. Un lot sans commit ne bloque rien.
 *
 * Les commits d'un lot pas prêt sont l'union de ce que git lui attribue (`read`) et de ce que ses étapes ont noté : les entrées d'étape ne sont
 * écrites qu'à la fin d'une session au rapport valide, git voit tout de suite le commit d'une session en cours, coupée par le quota ou échouée,
 * dans son dépôt comme dans un voisin. Un lot dont les commits n'ont pu être lus (`read` lève) et dont aucun commit déjà connu ne bloque est
 * `unreadable` : on ne laisse passer que ce qu'on a pu vérifier.
 */
export function blockingLots(lots: LotState[], repo: string, sha: string, ancestor: (repo: string, a: string, b: string) => boolean = isAncestor, read: (l: LotState, repo: string) => string[] = gitCommitsIn): WaveGuard {
  const guard: WaveGuard = { blocking: [], unreadable: [] };
  for (const l of lots) {
    if (l.status === 'ready') continue;
    let found: string[] = [];
    let readable = true;
    try {
      found = read(l, repo);
    } catch {
      readable = false;
    }
    if ([...found, ...stepCommits(l, repo)].some((c) => ancestor(repo, c, sha))) guard.blocking.push(l);
    else if (!readable) guard.unreadable.push(l);
  }
  return guard;
}

/** Tests déjà rouges au départ listés un par un dans le tableau ; au-delà, un compte. */
const BASELINE_LISTED = 30;

/**
 * La commande de reprise d'une vague, SEULE forme que le programme imprime (L309) : `--resume --wave <id>` et non `--resume <id>`, car un id qui ressemble à un lot
 * (`suite2`) est lu comme un lot à lancer sans `--wave` (et refusé), et `--resume` sans vague est refusé dès que le dossier en garde plusieurs non terminées.
 * `extra` : les options qui suivent (`--drop a:L1`, `--integrate a:L1`...).
 */
export function resumeCommand(waveId: string, ...extra: string[]): string {
  return ['cadence orchestrate --resume --wave', waveId, ...extra].join(' ');
}

/** La commande qui répond à une question (L309) : la reprise ci-dessus, avec `--answer`. */
export function resumeAnswerHint(waveId: string, l: Pick<LotState, 'project' | 'lot'>): string {
  return resumeCommand(waveId, '--answer', `${l.project}:${l.lot}`, '"…"');
}

/** Les lignes d'un lot qui restent dans le tableau compact : une escalade et les avertissements sont des signaux, pas du détail. */
function signalLines(l: LotState): string[] {
  const out: string[] = [];
  if (l.escalation) out.push(`${l.project}:${l.lot} — escalade ${l.escalation.model} : ${escalationText(l)}`);
  for (const w of l.warnings) out.push(`${l.project}:${l.lot} — ⚠ ${w}`);
  return out;
}

/** Le détail d'un lot (L441) : ce que le tableau compact de `--status` n'imprime pas et que `--status --detail <lot>` donne. */
function detailLines(l: LotState): string[] {
  const out: string[] = [];
  if (l.goal) out.push(`${l.project}:${l.lot} — objectif donné : ${l.goal}`);
  if (l.uxNote) out.push(`${l.project}:${l.lot} — ${l.uxNote}`);
  if (l.uxCaptures) out.push(`${l.project}:${l.lot} — captures Playwright : ${l.uxCaptures}`);
  // Ligne de base des tests (L213) : les échecs déjà présents au sha de départ, à part de ceux du lot.
  const base = l.baseline;
  if (base?.failures.length) {
    const where = `${base.sha ? ` (${base.sha.slice(0, 7)}${base.verified ? '' : ', annoncé par la session, non vérifié'})` : ''}`;
    for (const t of base.failures.slice(0, BASELINE_LISTED)) out.push(`${l.project}:${l.lot} — déjà rouge au départ${where} : ${t}`);
    if (base.failures.length > BASELINE_LISTED) out.push(`${l.project}:${l.lot} — déjà rouge au départ${where} : … et ${base.failures.length - BASELINE_LISTED} autre(s)`);
  }
  for (const x of l.choix ?? []) out.push(`${l.project}:${l.lot} — choix fait : ${x}`);
  for (const h of l.hypotheses ?? []) out.push(`${l.project}:${l.lot} — hypothèse de la fiche : ${h}`);
  for (const p of l.proposals) out.push(`${l.project}:${l.lot} — proposé : ${p}`);
  if (l.uxVerdict && l.visible) out.push(`${l.project}:${l.lot} — verdict UX pour « raf ux » : ${l.uxVerdict}`);
  return out;
}

/**
 * `--status --detail <lot>` (L441) : les lignes de détail d'un lot de la vague, lues dans l'état de la vague (le fichier de chaque lot).
 * `sel` : `projet:lot` ou le seul `lot` s'il est unique dans la vague. Lot inconnu ou ambigu : lève.
 */
export function renderDetail(lots: LotState[], sel: string): string[] {
  const hit = lots.filter((l) => `${l.project}:${l.lot}` === sel);
  const found = hit.length ? hit : sel.includes(':') ? [] : lots.filter((l) => l.lot === sel);
  if (found.length === 0) throw new Error(`lot inconnu dans cette vague : ${sel} (lots : ${lots.map((l) => `${l.project}:${l.lot}`).join(', ')})`);
  if (found.length > 1) throw new Error(`lot ambigu : ${sel} (${found.map((l) => `${l.project}:${l.lot}`).join(', ')}) : donner projet:lot`);
  const l = found[0]!;
  const lines = detailLines(l);
  return lines.length ? lines : [`${l.project}:${l.lot} — aucun détail (ni objectif, capture, choix, proposition, ni verdict UX)`];
}

/** Le tableau de fin de vague (ou de `--status`), une ligne par lot puis le total et les questions. `compact` (L441, `--status`) : sans le détail des lots, une seule ligne renvoie à `--status --detail`. */
export function renderTable(wave: WaveState, lots: LotState[], deps: { isAncestor?: (repo: string, a: string, b: string) => boolean; lotCommits?: (l: LotState) => string[]; now?: number; compact?: boolean } = {}): string[] {
  const rows = lots.map((l) => [`${l.project}:${l.lot}`, stateText(l, wave, deps.now ?? Date.now()), String(l.pass), review(l), ux(l), String(commits(l)), k(counted(l)), `${minutes(l)} min`]);
  const head = ['lot', 'état', 'passes', 'revue', 'UX', 'commits', 'tokens', 'durée'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(head), ...rows.map(line)];
  const by = (s: LotState['status']) => lots.filter((l) => l.status === s).length;
  const tail = [`${by('ready')} prêt(s)`, by('question') ? `${by('question')} question(s)` : '', by('handed-back') + by('failed') ? `${by('handed-back') + by('failed')} rendu(s) au lead` : '', by('suspended') ? `${by('suspended')} suspendu(s)` : ''].filter(Boolean);
  out.push(`vague ${wave.id} : ${k(wave.consumed)} / ${m(wave.budget)} comptés (lecture de cache ${m(wave.cacheRead)}) — ${tail.join(', ')} — ${wave.status}`);
  for (const l of lots.filter((x) => x.status === 'question')) {
    out.push(`question : ${l.project}:${l.lot} — « ${l.questions.join(' / ')} » (${resumeAnswerHint(wave.id, l)})`);
  }
  for (const l of lots.filter((x) => x.status === 'handed-back' || x.status === 'failed' || x.status === 'suspended')) {
    out.push(`${l.project}:${l.lot} — ${l.outcome ?? LABEL[l.status]}`);
    for (const c of l.status === 'handed-back' ? l.constats : []) out.push(`    · [${c.gravite}] ${c.fichier ? `${c.fichier}${c.ligne ? `:${c.ligne}` : ''} — ` : ''}${c.texte.split('\n')[0]}`);
  }
  for (const d of deliverable(lots, deps.isAncestor ?? isAncestor, deps.lotCommits ?? gitCommitsOf)) {
    out.push(`${d.ready.project}:${d.ready.lot} — livrable jusqu'à ${d.sha} (dernier commit de ${d.ready.lot}, sous ${d.under.lot} ${d.under.status === 'handed-back' || d.under.status === 'failed' ? 'rendu' : LABEL[d.under.status]}) : git push origin ${d.sha}:main && cadence deliver --sha ${d.sha}`);
  }
  for (const l of lots) {
    out.push(...signalLines(l));
    if (deps.compact) continue;
    out.push(...detailLines(l));
  }
  const withDetail = lots.filter((l) => detailLines(l).length > 0).map((l) => `${l.project}:${l.lot}`);
  if (deps.compact && withDetail.length) out.push(`détail (objectif, captures, base de tests, choix, propositions, verdict UX) : cadence orchestrate --status --detail <projet:lot> — ${withDetail.join(', ')}`);
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
