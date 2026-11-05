// L632 (issue #42) : un lot dont l'objectif n'a pas pu être vérifié ne ressort pas « prêt » en silence.
// Trois gestes : l'alerte avant le lancement (le lot demande un cluster que la session n'a pas), la mention « objectif non vérifié »
// quand le rapport d'implémentation ou la revue le disent, la ligne des briefs.
import { isParts, type GateTest } from './gate-parts.js';
import { lotKey, type LotState } from './state.js';
import type { WorkReport } from './schemas.js';

/** Ce qui, dans un titre ou un objectif, demande un accès cluster : l'outil, le tunnel, la variable, le mot, ou l'URL d'un banc. */
const CLUSTER_WORDS = /\bkubectl\b|\bport-forward\b|\bKUBECONFIG\b|\bclusters?\b|https?:\/\/[^\s)]*(?:banc|bench|preprod|staging)/i;

/**
 * L'alerte du lancement et du `--dry-run` : orchestrate.prodAccess est faux (`prodAccess` à false), donc les sessions démarrent avec `KUBECONFIG=/dev/null` (sandbox.ts),
 * et le titre ou l'objectif du lot nomme un accès cluster. Null sinon. Le geste : lever la restriction, ou jouer le lot à la main.
 */
export function clusterAlert(l: Pick<LotState, 'project' | 'lot' | 'title' | 'goal'>, prodAccess: boolean): string | null {
  if (prodAccess) return null;
  const named = CLUSTER_WORDS.exec(`${l.title}\n${l.goal ?? ''}`)?.[0];
  if (!named) return null;
  return `⚠ ${lotKey(l.project, l.lot)} : le titre ou l'objectif nomme « ${named} » mais orchestrate.prodAccess est faux : les sessions démarrent sans accès cluster (KUBECONFIG=/dev/null), l'objectif ne pourra pas être vérifié — déclarer orchestrate.prodAccess: true dans cadence.yaml pour ce lancement, ou jouer ce lot à la main`;
}

/** Le motif d'un lot rendu prêt : « prêt à livrer », suivi de « objectif non vérifié : … » quand il l'est (journal de la vague, donc `--follow`, et tableau). */
export const readyOutcome = (l: Pick<LotState, 'title' | 'goal' | 'testsHorsPorte' | 'code'>): string => {
  const note = unverifiedGoal(l);
  return note ? `prêt à livrer — ${note}` : 'prêt à livrer';
};

/** Le verdict enregistré par `raf review` : la mention en bout de texte quand l'objectif n'est pas vérifié. */
export const withUnverifiedGoal = (verdict: string, l: Pick<LotState, 'title' | 'goal' | 'testsHorsPorte' | 'code'>): string => {
  const note = unverifiedGoal(l);
  return note ? `${verdict} ; ${note}` : verdict;
};

/** La ligne de chaque brief d'une session de la vague. */
const CLUSTER_LINE = 'This session has no cluster access (KUBECONFIG=/dev/null, no kubectl, no port-forward): a goal that needs a cluster or a bench URL is a question to the lead (under "questions"), never something to work around and never reported as verified.';

/** Le brief fini, la ligne du cluster en dernier — absente quand `prodAccess` lève la restriction : elle serait fausse (sans passer par un gabarit : un gabarit modifié change l'empreinte que d'autres tests gardent). */
export const withClusterLine = (brief: string, prodAccess: boolean): string => (prodAccess ? brief : `${brief.trimEnd()}\n\n${CLUSTER_LINE}\n`);

const squeeze = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * La porte du programme joue-t-elle cette commande ? Oui quand la commande annoncée (blancs réduits) contient celle de la porte (ou d'une de ses parties).
 * Une commande annoncée plus courte que la porte (`vitest run` pour `npx vitest run test/a.test.ts`) n'est pas couverte : elle joue autre chose.
 */
export function gateCovers(gate: GateTest | undefined, command: string): boolean {
  const claimed = squeeze(command);
  if (!gate || !claimed) return false;
  const runs = isParts(gate) ? gate.map((p) => p.run) : [gate];
  return runs.some((r) => squeeze(r) !== '' && claimed.includes(squeeze(r)));
}

/** Un état écrit avant ce lot peut ne porter ni objectif ni titre : rien à lire, chaîne vide. */
const firstLine = (text: string | undefined): string => (text ?? '').split('\n').find((x) => x.trim())?.trim() ?? '';

/** Une ligne de `nonVerifie` de la revue nomme-t-elle l'objectif : le mot (« objectif », « objective », « goal ») ou la première ligne de l'objectif. */
function namesGoal(entry: string, goal: string): boolean {
  return /\b(?:objectif|objective|goal)\b/i.test(entry) || (goal.length > 0 && entry.toLowerCase().includes(goal.toLowerCase()));
}

/**
 * « objectif non vérifié : <première ligne de l'objectif> » quand le rapport d'implémentation disait tests.vert faux avec une commande que la porte ne couvre pas (`testsHorsPorte`),
 * ou quand `nonVerifie` de la dernière revue nomme l'objectif ; null sinon. L'objectif est celui du lot (`goal`), à défaut son titre.
 */
export function unverifiedGoal(l: Pick<LotState, 'title' | 'goal' | 'testsHorsPorte' | 'code'>): string | null {
  const goal = firstLine(l.goal ?? '') || firstLine(l.title);
  const byReview = (l.code?.nonVerifie ?? []).some((e) => namesGoal(e, goal));
  return l.testsHorsPorte !== undefined || byReview ? `objectif non vérifié : ${goal}` : null;
}

/** Le suffixe de l'état d'un lot dans le tableau : « — objectif non vérifié : … » pour un lot prêt qui l'est. */
export const readySuffix = (l: LotState): string => {
  const note = l.status === 'ready' ? unverifiedGoal(l) : null;
  return note ? ` — ${note}` : '';
};

/** Le suffixe du total du tableau : « (dont N objectif non vérifié) » quand des lots prêts le sont. */
export const unverifiedSuffix = (lots: LotState[]): string => {
  const n = lots.filter((l) => l.status === 'ready' && unverifiedGoal(l)).length;
  return n ? ` (dont ${n} objectif non vérifié)` : '';
};

/**
 * Pose (ou lève) `testsHorsPorte` d'après le rapport d'écriture : la commande annoncée rouge que la porte ne joue pas. Rend vrai quand la session a annoncé des tests rouges (`tests.vert` faux),
 * que la porte la couvre ou non : ce que le cycle juge ensuite.
 */
export function redAnnounced(l: LotState, rep: Pick<WorkReport, 'tests'>, gate: GateTest | undefined): boolean {
  if (rep.tests.vert || gateCovers(gate, rep.tests.commande)) delete l.testsHorsPorte;
  else l.testsHorsPorte = rep.tests.commande;
  return !rep.tests.vert;
}

/** Les lignes que le lancement écrit avant la vague : celles du tirage `--continue` sur la sortie, puis l'alerte cluster de chaque lot sur la sortie d'erreur et au journal de la vague. */
export function announceLaunch(io: { out: (line: string) => void; err: (line: string) => void }, journal: (line: string) => void, lots: (Pick<LotState, 'project' | 'lot' | 'title' | 'goal'> & { prodAccess: boolean })[], drawn: string[]): void {
  for (const l of drawn) io.out(l);
  for (const alert of lots.map((l) => clusterAlert(l, l.prodAccess))) {
    if (!alert) continue;
    io.err(`orchestrate : ${alert}`);
    journal(`orchestrate : ${alert}`);
  }
}

/** L'alerte cluster d'un lot, en ligne de `--dry-run` (vide sans alerte). */
export const clusterAlertLines = (l: Pick<LotState, 'project' | 'lot' | 'title' | 'goal'>, prodAccess: boolean): string[] => {
  const alert = clusterAlert(l, prodAccess);
  return alert ? [`  ${alert}`] : [];
};
