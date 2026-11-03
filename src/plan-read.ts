import { isDay, type Day } from './dates.js';
import { RESOURCE_NAME, RESOURCES_BAD_LIST, SCREENS, STATUSES, type Gate, type Lot, type LotRepoDecl, type Screen, type Status, type Verdict } from './plan.js';
import { readParent } from './plan-ids.js';
import { readPlanned } from './plan-window.js';

const GATE_INVALID = 'gate invalide : count: entier ≥ 1 et un critère spec: true ou screen: page attendus';

/** Lit `gate: { count: N, spec: true }` ou `{ count: N, screen: page }` ; toute autre forme est un problème du lot et une condition jamais remplie. */
function readGate(raw: unknown, problems: string[]): Gate | undefined {
  if (raw == null) return undefined;
  const invalid = (): Gate => {
    problems.push(GATE_INVALID);
    return { invalid: true };
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const g = raw as Record<string, unknown>;
  if (!Number.isInteger(g.count) || (g.count as number) < 1) return invalid();
  const criteria = [...(g.spec === true ? ['spec' as const] : []), ...(g.screen === 'page' ? ['screen' as const] : [])];
  const others = Object.keys(g).filter((k) => k !== 'count' && k !== 'spec' && k !== 'screen');
  if (criteria.length !== 1 || others.length || ('spec' in g && g.spec !== true) || ('screen' in g && g.screen !== 'page')) return invalid();
  return { count: g.count as number, criterion: criteria[0]! };
}

/** `state:` et `state_before:` écrits à la main avec un non-texte : signalés, la clé étant écartée. */
function checkStateNames(raw: Record<string, unknown>, problems: string[]): void {
  for (const k of ['state', 'state_before']) if (raw[k] != null && typeof raw[k] !== 'string') problems.push(`${k} : un nom d'état attendu (reçu « ${String(raw[k])} »)`);
}

/** `delivered: { date, sha }` : les deux faits ou rien (une clé mal formée est ignorée, comme `state_before:`). */
function readDelivered(raw: unknown): Pick<Lot, 'delivered'> {
  const { date, sha } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return isDay(date) && typeof sha === 'string' && sha.trim() !== '' ? { delivered: { date, sha: sha.trim() } } : {};
}

/** L'estimation d'un lot : celle du plan, ou 1 jour par défaut avec la marque `unestimated` (L467). */
function readEstimate(v: unknown): { estimate: number; unestimated?: true } {
  return typeof v === 'number' && v > 0 ? { estimate: v } : { estimate: 1, unestimated: true };
}

export function normalizeLot(raw: Record<string, unknown>, problems: string[] = []): Lot {
  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : 'todo';
  const asDay = (field: string): Day | undefined => {
    const v = raw[field];
    if (v == null) return undefined;
    if (isDay(v)) return v;
    problems.push(`${field} « ${String(v)} » n'est pas une date AAAA-MM-JJ`);
    return undefined;
  };
  const after = raw.after == null ? [] : Array.isArray(raw.after) ? raw.after.map(String) : [String(raw.after)];
  const last = asDay('last');
  let uses: string[] | undefined;
  if (raw.uses != null) {
    if (Array.isArray(raw.uses) && raw.uses.every((n) => typeof n === 'string' && RESOURCE_NAME.test(n))) uses = [...new Set(raw.uses as string[])];
    else problems.push(`uses ${RESOURCES_BAD_LIST}`);
  }
  let screen: Screen | undefined;
  if (raw.screen != null) {
    if (SCREENS.includes(raw.screen as Screen)) screen = raw.screen as Screen;
    else problems.push(`screen « ${String(raw.screen)} » inconnu (${SCREENS.join(', ')})`);
    if (screen && raw.visible !== true) problems.push(`screen « ${screen} » sans visible : un écran est un changement visible`);
  }
  let spec: true | undefined;
  if (raw.spec != null) {
    if (raw.spec === true) spec = true;
    else if (raw.spec !== false) problems.push(`spec : true ou false attendu (reçu « ${String(raw.spec)} »)`);
  }
  checkStateNames(raw, problems);
  const gate = readGate(raw.gate, problems);
  const okRaw = raw.docs_ok as Record<string, unknown> | undefined;
  const docsOk = okRaw && typeof okRaw === 'object' && typeof okRaw.reason === 'string' && okRaw.reason.trim() !== '' ? { date: String(okRaw.date ?? ''), reason: okRaw.reason.trim() } : undefined;
  return {
    id: String(raw.id),
    ...readParent(raw.parent, problems),
    title: String(raw.title ?? ''),
    status,
    ...(typeof raw.state === 'string' && raw.state.trim() !== '' ? { state: raw.state.trim() } : {}),
    ...(typeof raw.state_before === 'string' && raw.state_before.trim() !== '' ? { stateBefore: raw.state_before.trim() } : {}),
    ...readDelivered(raw.delivered),
    ...readEstimate(raw.estimate),
    quickwin: raw.quickwin === true,
    visible: raw.visible === true,
    ...(screen ? { screen } : {}),
    ...(spec ? { spec } : {}), ...(raw.local === true ? { local: true as const } : {}),
    ...(gate ? { gate } : {}),
    ...(typeof raw.public === 'string' && raw.public.trim() !== '' ? { public: raw.public.trim() } : {}),
    ...(typeof raw.goal === 'string' && raw.goal.trim() !== '' ? { goal: raw.goal.trim() } : {}),
    ...(Number.isInteger(raw.every) && (raw.every as number) > 0 ? { every: raw.every as number } : {}),
    ...(last ? { last } : {}),
    after,
    ...(uses?.length ? { uses } : {}),
    ...readPlanned(raw.planned, problems),
    created: asDay('created'),
    started: asDay('started'),
    finished: asDay('finished'),
    notes: Array.isArray(raw.notes)
      ? raw.notes.map((n: Record<string, unknown>) => ({ date: String(n.date ?? ''), text: String(n.text ?? '') }))
      : [],
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((t: Record<string, unknown>) => ({
          id: String(t.id),
          title: String(t.title ?? ''),
          status: STATUSES.includes(t.status as Status) ? (t.status as Status) : 'todo',
        }))
      : [],
    ...(repoList(raw.repos).length ? { repos: repoList(raw.repos) } : {}),
    ...(asVerdict(raw.ux) ? { ux: asVerdict(raw.ux) } : {}),
    ...(asVerdict(raw.review) ? { review: asVerdict(raw.review) } : {}),
    ...(docsOk ? { docsOk } : {}),
    problems,
  };
}

/**
 * Dépôts voisins déclarés : une chaîne (le chemin) ou un objet `{ path, cite }`, seuls ou en liste (une valeur seule vaut une
 * liste d'un dépôt). Une entrée sans chemin textuel est écartée ; un `cite` vide ou non textuel vaut pas de `cite`.
 */
function repoList(raw: unknown): LotRepoDecl[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: LotRepoDecl[] = [];
  for (const item of items) {
    const path = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string' ? ((item as Record<string, unknown>).path as string) : '';
    if (path.trim() === '') continue;
    const cite = item && typeof item === 'object' ? (item as Record<string, unknown>).cite : undefined;
    out.push({ path: path.trim(), ...(typeof cite === 'string' && cite.trim() !== '' ? { cite: cite.trim() } : {}) });
  }
  return out;
}

function asVerdict(raw: unknown): Verdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  // Écrit à la main sans verdict (clé absente, vide ou blanche) : rien n'a été dit de la revue, la porte
  // reste fermée — comme `raf ux` et `raf review` refusent d'enregistrer un verdict vide.
  if (String(v.verdict ?? '').trim() === '') return undefined;
  const verdict: Verdict = { date: String(v.date ?? ''), verdict: String(v.verdict) };
  // Champ présent mais vide : relu « jusqu'à rien », comme un verdict noté sans commit.
  if ('commit' in v) verdict.commit = v.commit == null || String(v.commit).trim() === '' ? null : String(v.commit).trim();
  if (v.repos && typeof v.repos === 'object' && !Array.isArray(v.repos)) {
    const repos = Object.entries(v.repos as Record<string, unknown>).map(([k, sha]) => [k, sha == null || String(sha).trim() === '' ? null : String(sha).trim()] as const);
    if (repos.length) verdict.repos = Object.fromEntries(repos);
  }
  const r = v.reporte as Record<string, unknown> | null | undefined;
  if (r && typeof r === 'object' && !Array.isArray(r) && r.de != null && r.vers != null) verdict.reporte = { de: String(r.de), vers: String(r.vers), patchId: String(r.patchId ?? '') };
  return verdict;
}
