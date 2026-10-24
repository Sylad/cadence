import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RafError } from './plan.js';

/** Les causes d'une passe de correction (L165), dans l'ordre où le rapport les liste. */
export const CAUSES = ['spec-floue', 'regle-inventee', 'derive-architecture', 'donnees-sql', 'bug-code', 'test-manquant', 'faux-constat'] as const;
export type Cause = (typeof CAUSES)[number];
/** `sans-constat` : passe sans constat de revue à lire (tests rouges juste après l'écriture) : comptée à part, jamais envoyée au modèle. */
export type CauseOrNone = Cause | 'sans-constat' | 'non-classe';

const LABELS: Record<CauseOrNone, string> = {
  'spec-floue': 'spec floue ou critère absent',
  'regle-inventee': 'règle de gestion inventée',
  'derive-architecture': "dérive d'architecture",
  'donnees-sql': 'données / SQL',
  'bug-code': 'bug de code',
  'test-manquant': 'test manquant',
  'faux-constat': 'faux constat de revue',
  'sans-constat': 'sans revue (tests rouges)',
  'non-classe': 'non classé',
};

/** Une passe « fix » d'un lot et les constats de la revue qui la précède. */
export interface FixPass {
  /** `<vague>/<projet>--<lot>/<n° du pas>` : clé stable du classement. */
  key: string;
  project: string;
  lot: string;
  visible: boolean;
  findings: string[];
  commits: string[];
}

export interface LotRecord {
  project: string;
  lot: string;
  visible: boolean;
  fixes: number;
}

export interface Runs {
  lots: LotRecord[];
  passes: FixPass[];
}

export interface Classification {
  cause: Cause;
  /** `ollama:<modèle>` */
  by: string;
  /** Cause posée à la main sur l'échantillon relu : elle prime et mesure l'accord du modèle. */
  manual?: Cause;
}

interface RawStep {
  n: number;
  kind: string;
  status: string;
  report?: string;
  commits?: string[];
  ended?: string;
  started?: string;
  model?: unknown;
  tokens?: { counted?: unknown; input?: unknown; cacheWrite?: unknown; cacheRead?: unknown; output?: unknown };
}

export const isReview = (kind: string) => kind.startsWith('review') || kind === 'ux';

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Les textes des constats d'un rapport de revue (champ `structured`, sinon le JSON de `result`). */
function findingsOf(report: any): string[] {
  let body = report?.structured;
  if (!body && typeof report?.result === 'string') {
    try {
      body = JSON.parse(report.result);
    } catch {
      body = null;
    }
  }
  const list = Array.isArray(body?.constats) ? body.constats : [];
  return list.map((c: any) => (typeof c === 'string' ? c : c?.texte)).filter((t: unknown): t is string => typeof t === 'string' && t.length > 0);
}

/** Les quatre compteurs d'une session, rendus ensemble ou pas du tout (R16). */
export interface StepUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Une étape d'un journal, telle que le lecteur partagé la rend (`tokens.counted` : le compte du budget, absent sans jetons lisibles ; `usage` : les quatre compteurs, absents d'un journal ancien qui ne porte que `counted`). */
export interface JournalStep {
  n: number;
  kind: string;
  status: string;
  model?: string;
  started?: string;
  ended?: string;
  counted?: number;
  usage?: StepUsage;
}

const USAGE_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
/** Les quatre compteurs d'une étape quand ce sont tous des nombres. */
function usageOf(tokens: RawStep['tokens']): StepUsage | undefined {
  if (!tokens || !USAGE_KEYS.every((k) => typeof tokens[k] === 'number')) return undefined;
  return { input: tokens.input as number, cacheWrite: tokens.cacheWrite as number, cacheRead: tokens.cacheRead as number, output: tokens.output as number };
}

/** Une passe de correction et la date de fin de son étape fix (absente sans date lisible). */
export interface JournalPass extends FixPass {
  fixEnded?: string;
  /** Sorte de la revue dont les constats ont déclenché la passe (`review`, `review-small`, `ux`) ; absente d'une passe sans constat à lire. */
  reviewKind?: string;
}

/** Un journal `<vague>/<projet>--<lot>.json` lu, avec ce que `readRuns` et `cadence perf` en tirent. */
export interface Journal {
  wave: string;
  /** `created` du wave.json de la vague (absent sans date lisible). */
  waveCreated?: string;
  /** Faux quand le wave.json de la vague est absent ou illisible : `cadence perf` écarte alors la vague (R17), `readRuns` la lit comme avant. */
  waveReadable: boolean;
  project: string;
  lot: string;
  visible: boolean;
  /** Petit lot (champ `small` du journal) ; faux pour un journal ancien qui ne le porte pas. */
  small: boolean;
  status: string;
  budget?: number;
  /** Verdict du contrôle préalable (`precheckVerdict` du journal, L288) ; absent d'un journal ancien ou d'un lot sans contrôle. */
  precheck?: 'oui' | 'partiel' | 'non';
  steps: JournalStep[];
  /** Une session implement a abouti (sous la borne `until` éventuelle). */
  implemented: boolean;
  passes: JournalPass[];
}

/**
 * Lit TOUS les journaux de vague `<runs>/<vague>/<projet>--<lot>.json` lisibles (seuls un journal sans `steps` lisible ou, sous `until` ou `since`, une vague sans date de création lisible sont écartés) : c'est la lecture que partagent `readRuns` et `cadence perf` (L225), le filtre « session implement aboutie » n'est pas ici mais dans leurs prédicats (`implemented`). Chaque pas `fix` abouti est une passe, rattachée aux constats de la dernière revue qui la précède.
 * `until` : date ISO, ne lit que les vagues créées jusque-là et, dans chacune, les étapes terminées (`ended`) jusque-là ; une vague ou une étape sans date lisible est écartée. `since` : date ISO, ne garde que les vagues créées strictement après.
 */
/**
 * Verdict du contrôle préalable d'un journal : `precheckVerdict` (L288) ; pour un journal d'avant, relu de ce qu'il garde : le lot
 * rendu « livrable déjà présent » est un « oui », celui qui porte le constat du précheck (`precheck`) un « partiel », tout autre
 * lot dont l'étape precheck a abouti un « non ». Sans étape precheck aboutie, aucun verdict.
 */
function precheckVerdictOf(rec: Record<string, any>, steps: RawStep[]): 'oui' | 'partiel' | 'non' | undefined {
  if (rec.precheckVerdict === 'oui' || rec.precheckVerdict === 'partiel' || rec.precheckVerdict === 'non') return rec.precheckVerdict;
  if (!steps.some((s) => s.kind === 'precheck' && s.status === 'ok')) return undefined;
  if (typeof rec.outcome === 'string' && rec.outcome.startsWith('livrable déjà présent')) return 'oui';
  return typeof rec.precheck === 'string' && rec.precheck !== '' ? 'partiel' : 'non';
}

export function readJournals(runsDir: string, until?: string, since?: string): Journal[] {
  const journals: Journal[] = [];
  if (!existsSync(runsDir)) return journals;
  const limit = until === undefined ? Infinity : Date.parse(until);
  const from = since === undefined ? undefined : Date.parse(since);
  // Sous `until`, une étape compte si elle est terminée avant la date ; sans date de fin lisible, elle est écartée.
  const inTime = (s: RawStep) => until === undefined || Date.parse(s.ended ?? '') <= limit;
  for (const wave of readdirSync(runsDir).sort()) {
    const waveDir = join(runsDir, wave);
    if (!statSync(waveDir).isDirectory()) continue;
    const waveJson = readJson(join(waveDir, 'wave.json'));
    // Les vagues nommées à la main (ol-gains-1) n'ont pas d'horodatage dans leur nom : on lit `created` dans wave.json.
    const created = Date.parse(waveJson?.created);
    if (until !== undefined && !(created <= limit)) continue;
    // `since` est strict : une vague créée pile à la borne reste dans l'avant de `until` (inclusif), les deux mesures ne se recouvrent jamais ; sans date de création lisible, la vague est dans aucune.
    if (from !== undefined && !(created > from)) continue;
    const waveReadable = waveJson !== null && typeof waveJson === 'object';
    const waveCreated = Number.isNaN(created) ? undefined : (waveJson.created as string);
    for (const file of readdirSync(waveDir).sort()) {
      if (!file.endsWith('.json') || file === 'wave.json') continue;
      const rec = readJson(join(waveDir, file));
      if (!rec || !Array.isArray(rec.steps)) continue;
      const steps = (rec.steps as RawStep[]).filter((s) => s && typeof s === 'object');
      const done = (s: RawStep) => s.status === 'ok' && inTime(s);
      const name = basename(file, '.json');
      const fixSteps = steps.filter((s) => s.kind === 'fix' && done(s));
      const passes = fixSteps.map((fix): JournalPass => {
        const review = [...steps].reverse().find((s) => s.n < fix.n && isReview(s.kind) && s.report);
        // Une passe fix entre la revue et celle-ci a déjà traité ces constats : cette passe-ci (tests rouges) n'en a pas.
        const handled = review ? fixSteps.some((f) => f.n > review.n && f.n < fix.n) : false;
        const findings = review?.report && !handled ? findingsOf(readJson(join(waveDir, name, review.report))) : [];
        return { key: `${wave}/${name}/${fix.n}`, project: rec.project, lot: rec.lot, visible: !!rec.visible, findings, commits: fix.commits ?? [], ...(fix.ended ? { fixEnded: fix.ended } : {}), ...(findings.length > 0 && review ? { reviewKind: review.kind } : {}) };
      });
      journals.push({
        wave,
        ...(waveCreated ? { waveCreated } : {}),
        waveReadable,
        project: rec.project,
        lot: rec.lot,
        visible: !!rec.visible,
        small: !!rec.small,
        status: String(rec.status),
        ...(typeof rec.budget === 'number' ? { budget: rec.budget } : {}),
        ...(precheckVerdictOf(rec, steps) ? { precheck: precheckVerdictOf(rec, steps) } : {}),
        steps: steps.map((s) => {
          const usage = usageOf(s.tokens);
          return { n: s.n, kind: s.kind, status: s.status, ...(typeof s.model === 'string' ? { model: s.model } : {}), ...(s.started ? { started: s.started } : {}), ...(s.ended ? { ended: s.ended } : {}), ...(typeof s.tokens?.counted === 'number' ? { counted: s.tokens.counted } : {}), ...(usage ? { usage } : {}) };
        }),
        implemented: steps.some((s) => s.kind === 'implement' && done(s)),
        passes,
      });
    }
  }
  return journals;
}

/**
 * Les lots et passes de correction des journaux de `<runs>`. Un lot compte (dénominateur) dès qu'une session d'écriture a abouti (`until` : date ISO, ne lit que les vagues créées jusque-là et, dans chacune, les étapes terminées (`ended`) jusque-là, pour une mesure que ni les vagues suivantes ni une vague encore en cours ne changent ; `since` : date ISO, ne garde que les lots des vagues créées strictement après, avec toutes leurs passes : une vague rend tous ses briefs depuis la copie de l'outil figée à sa création, c'est la date de la vague, non celle du début d'un lot, qui dit quel brief il a reçu, sauf pour une vague reprise sans instantané ou, avec `--budget projet:lot=+N`, depuis un instantané d'avant L223 : elle tourne alors avec le dist/ et les gabarits courants ; `--until` plus `--since` ne font le total sans borne que si aucune vague créée avant la borne n'est encore reprenable).
 */
export function readRuns(runsDir: string, until?: string, since?: string): Runs {
  const lots: LotRecord[] = [];
  const passes: FixPass[] = [];
  for (const j of readJournals(runsDir, until, since)) {
    if (!j.implemented) continue;
    lots.push({ project: j.project, lot: j.lot, visible: j.visible, fixes: j.passes.length });
    for (const { fixEnded: _ended, reviewKind: _kind, ...pass } of j.passes) passes.push(pass);
  }
  return { lots, passes };
}

export interface Tally {
  lots: number;
  atLeast1: number;
  atLeast2: number;
  passes: number;
}

export interface Measure {
  total: Tally;
  byProject: Record<string, Tally>;
  byVisibility: { visible: Tally; hidden: Tally };
  byCause: Record<CauseOrNone, number>;
  /** Les causes par visibilité du lot : la référence de l'étape spec est celle des lots visibles, non « tous lots » (L176). */
  byVisibilityCause: { visible: Record<CauseOrNone, number>; hidden: Record<CauseOrNone, number> };
  byProjectCause: Record<string, Record<CauseOrNone, number>>;
  agreement: { reviewed: number; agree: number };
}

const tally = (): Tally => ({ lots: 0, atLeast1: 0, atLeast2: 0, passes: 0 });
const causes = (): Record<CauseOrNone, number> => ({ ...Object.fromEntries([...CAUSES, 'sans-constat', 'non-classe'].map((c) => [c, 0])) } as Record<CauseOrNone, number>);

export function measure(data: Runs, cache: Map<string, Classification>): Measure {
  const m: Measure = { total: tally(), byProject: {}, byVisibility: { visible: tally(), hidden: tally() }, byCause: causes(), byVisibilityCause: { visible: causes(), hidden: causes() }, byProjectCause: {}, agreement: { reviewed: 0, agree: 0 } };
  for (const l of data.lots) {
    const groups = [m.total, (m.byProject[l.project] ??= tally()), l.visible ? m.byVisibility.visible : m.byVisibility.hidden];
    for (const t of groups) {
      t.lots++;
      t.passes += l.fixes;
      if (l.fixes >= 1) t.atLeast1++;
      if (l.fixes >= 2) t.atLeast2++;
    }
  }
  for (const p of data.passes) {
    const c = cache.get(p.key);
    const cause: CauseOrNone = p.findings.length === 0 ? 'sans-constat' : c ? (c.manual ?? c.cause) : 'non-classe';
    m.byCause[cause]++;
    (p.visible ? m.byVisibilityCause.visible : m.byVisibilityCause.hidden)[cause]++;
    (m.byProjectCause[p.project] ??= causes())[cause]++;
    if (c?.manual && cause !== 'sans-constat') {
      m.agreement.reviewed++;
      if (c.manual === c.cause) m.agreement.agree++;
    }
  }
  return m;
}

/** Extrait une cause connue d'une réponse (JSON `{cause}` ou texte libre) ; null sinon. */
export function parseCause(text: string): Cause | null {
  try {
    const c = JSON.parse(text)?.cause;
    if (typeof c === 'string' && (CAUSES as readonly string[]).includes(c)) return c as Cause;
    return null;
  } catch {
    return CAUSES.find((c) => text.includes(c)) ?? null;
  }
}

export type Classifier = (pass: FixPass) => Promise<Cause | null>;

const SYSTEM = `Tu classes la CAUSE d'une passe de correction dans un projet logiciel mené par vagues d'agents : une session a écrit du code, une revue a formulé des constats, une session de correction les a traités. Réponds par UNE cause, celle du constat le plus grave, en cherchant la racine de ce qui a obligé à corriger.
Règle de départ : si le code livré ne fait pas ce que le lot ou le commit annonce, ou fait faux (logique, cas limite, condition trop large, rendu qui ne s'applique pas, accessibilité, état périmé, travail annoncé mais non fait), c'est bug-code.
- bug-code : le code livré est faux ou incomplet par rapport à une intention CLAIRE ;
- spec-floue : UNIQUEMENT si le constat dit que l'énoncé du lot est ambigu, muet, contradictoire ou sans critère mesurable et que la session a dû deviner ; un constat qui compare le code à un énoncé précis n'est PAS spec-floue ;
- regle-inventee : la session a ajouté de son chef une règle de gestion, un seuil, un message ou un comportement que le lot ne demandait pas ;
- derive-architecture : une convention ou une règle écrite du projet (CLAUDE.md, README, documentation, structure, duplication, couche contournée, agent ou brief incohérent) n'est pas suivie ;
- donnees-sql : requête, schéma, migration, format ou contenu de données faux ;
- test-manquant : le code est juste mais un comportement n'est pas couvert, ou un test ne vérifie pas ce que son titre promet ;
- faux-constat : la revue se trompe (le code était correct, constat infondé, hors lot, sans effet réel).`;

/** Classeur sur un modèle local servi par Ollama (/api/chat, température 0, sortie contrainte par un schéma) : hors quota Anthropic. */
export function ollamaClassifier(opts: { url: string; model: string; fetch?: typeof fetch }): Classifier {
  const doFetch = opts.fetch ?? fetch;
  return async (pass) => {
    const findings = pass.findings.length ? pass.findings.map((f, i) => `${i + 1}. ${f.slice(0, 1500)}`).join('\n') : '(aucun constat lisible)';
    const user = `Lot ${pass.project} ${pass.lot}.\nConstats de la revue :\n${findings}\n\nCommits de la correction :\n${pass.commits.join('\n') || '(aucun)'}`;
    try {
      const res = await doFetch(`${opts.url.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          stream: false,
          options: { temperature: 0 },
          format: { type: 'object', properties: { cause: { type: 'string', enum: [...CAUSES] }, raison: { type: 'string' } }, required: ['cause', 'raison'] },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { message?: { content?: string } };
      return parseCause(body.message?.content ?? '');
    } catch {
      return null;
    }
  };
}

/** Classe les passes absentes du cache, une à une ; un échec n'entre pas au cache (une relance le reprend). */
export async function classifyAll(passes: FixPass[], cache: Map<string, Classification>, classify: Classifier, model: string, progress?: (done: number, total: number) => void, checkpoint?: { every: number; save: () => void }): Promise<void> {
  const todo = passes.filter((p) => p.findings.length > 0 && !cache.has(p.key));
  let done = 0;
  for (const p of todo) {
    const cause = await classify(p);
    if (cause) cache.set(p.key, { cause, by: `ollama:${model}` });
    done++;
    progress?.(done, todo.length);
    // Sauvegarde périodique : une interruption (Ctrl-C, Ollama tombé) ne perd que les derniers classements.
    if (checkpoint && done % checkpoint.every === 0) checkpoint.save();
  }
  if (checkpoint && done % checkpoint.every !== 0) checkpoint.save();
}

/** n clés réparties à intervalle régulier dans l'ordre trié : le même échantillon à chaque lecture. */
export function sampleKeys(keys: string[], n: number): string[] {
  const sorted = [...keys].sort();
  if (sorted.length <= n) return sorted;
  const step = sorted.length / n;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)]!);
}

export function readCache(file: string): Map<string, Classification> {
  let raw: unknown = null;
  if (existsSync(file)) {
    // Un fichier illisible lu comme vide serait réécrit par --classify et perdrait les relectures saisies à la main.
    raw = readJson(file);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RafError(`${file} : JSON illisible (un objet clé → classement est attendu), corrigez ou supprimez le fichier`);
  }
  const known = (c: unknown) => typeof c === 'string' && (CAUSES as readonly string[]).includes(c);
  const entries = Object.entries((raw ?? {}) as Record<string, Classification>);
  // Une cause inconnue (faute de frappe dans une relecture) ferait disparaître la passe des tableaux : on refuse le fichier.
  for (const [key, c] of entries) {
    if (!known(c?.cause)) throw new RafError(`${file} : cause inconnue pour ${key} : ${String(c?.cause)}`);
    if (c.manual !== undefined && !known(c.manual)) throw new RafError(`${file} : relecture inconnue pour ${key} : ${String(c.manual)} (causes : ${CAUSES.join(', ')})`);
  }
  return new Map(entries);
}

export function serializeCache(cache: Map<string, Classification>): string {
  return JSON.stringify(Object.fromEntries([...cache].sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n';
}

const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)} %`);
/** Les causes qu'une meilleure spécification évite (critère de réussite de l'étape spec). */
const SPEC_CAUSES: Cause[] = ['spec-floue', 'regle-inventee', 'test-manquant'];
const row = (name: string, t: Tally) => `| ${name} | ${t.lots} | ${t.atLeast1} (${pct(t.atLeast1, t.lots)}) | ${t.atLeast2} (${pct(t.atLeast2, t.lots)}) | ${t.passes} |`;

export function renderReport(m: Measure): string {
  const all = [...CAUSES, 'sans-constat', 'non-classe'] as CauseOrNone[];
  const used = all.filter((c) => (c !== 'non-classe' && c !== 'sans-constat') || m.byCause[c] > 0);
  const projects = Object.keys(m.byProject).sort();
  const passes = m.total.passes;
  const out: string[] = [];
  out.push(`**${m.total.lots} lots** passés par une session d'écriture, **${passes} passes de correction** : ${pct(m.total.atLeast1, m.total.lots)} des lots ont eu au moins une correction, ${pct(m.total.atLeast2, m.total.lots)} au moins deux.`, '');
  out.push('### Par cause', '', '| Cause | Passes | Part |', '|---|---|---|', ...used.map((c) => `| ${LABELS[c]} | ${m.byCause[c]} | ${pct(m.byCause[c], passes)} |`), '');
  out.push('### Par cause et par projet (passes)', '', `| Projet | ${used.map((c) => LABELS[c]).join(' | ')} | Total |`, `|---|${used.map(() => '---').join('|')}|---|`);
  for (const p of projects) out.push(`| ${p} | ${used.map((c) => m.byProjectCause[p]?.[c] ?? 0).join(' | ')} | ${m.byProject[p]!.passes} |`);
  out.push('', '### Lots avec correction', '', '| Projet | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |', '|---|---|---|---|---|', ...projects.map((p) => row(p, m.byProject[p]!)), row('**Total**', m.total), '');
  out.push('### Lots visibles et non visibles', '', '| Lots | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |', '|---|---|---|---|---|', row('visibles', m.byVisibility.visible), row('non visibles', m.byVisibility.hidden), '');
  out.push('### Par cause et par visibilité (passes)', '', `| Lots | Lots | Passes | ${used.map((c) => LABELS[c]).join(' | ')} | Spec floue, règle inventée ou test manquant |`, `|---|---|---|${used.map(() => '---').join('|')}|---|`);
  for (const [name, t, byC] of [['visibles', m.byVisibility.visible, m.byVisibilityCause.visible], ['non visibles', m.byVisibility.hidden, m.byVisibilityCause.hidden]] as const) {
    const spec = SPEC_CAUSES.reduce((n, c) => n + byC[c], 0);
    out.push(`| ${name} | ${t.lots} | ${t.passes} | ${used.map((c) => byC[c]).join(' | ')} | ${spec} (${pct(spec, t.passes)}) |`);
  }
  out.push('');
  if (m.agreement.reviewed > 0) out.push(`Échantillon relu à la main : ${m.agreement.reviewed} passes, le modèle local est d'accord avec la relecture sur ${m.agreement.agree} (${pct(m.agreement.agree, m.agreement.reviewed)}) ; la cause relue prime dans les tableaux.`, '');
  return out.join('\n');
}
