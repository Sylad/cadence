// Issue #57 (compte pro, 13-11) : en --output-format json, claude -p ne rend que le message final du DERNIER tour. Une notification de tâche arrivée après
// le rapport (un agent ou une commande de fond qui finit) ouvre un tour de plus, et sa réponse remplaçait le rapport dans le journal et l'état du run.
// La session parle donc en stream-json (../bench/bras.ts, argsClaude) : chaque tour finit par un événement `result`. Le tour 1 est celui du prompt ; un tour
// suivant n'a pas été ouvert par le prompt (en vrai flux, après un événement system/task_notification, rien dans un message user :
// test/fixtures/flux-notification-tardive-2.1.293.jsonl). Les tours se comptent donc sur les `result`, quel que soit le format de la notification.
// Issue #58 (L728) : l'inverse. Le tour du prompt finit sur une ligne d'attente pendant que la suite tourne en fond ; la session reprend le travail aux tours
// ouverts par les notifications, et le vrai rapport est au dernier (test/fixtures/flux-attente-tache-de-fond-2.1.293.jsonl). Deviner le rapport à la forme
// du flux (outils appelés, tâches de fond actives) a cédé cinq fois dans la journée : le lecteur ne devine plus, la session le dit (revue L728).
// CONSIGNE EXPLICITE : le brief demande que le rapport final commence par la ligne MARQUEUR, seule sur sa ligne, et nulle part ailleurs (ni ligne
// d'attente, ni réponse à une notification). Le rapport retenu est le DERNIER message qui commence par cette ligne ; le result de son tour décide de l'état.
// Sans aucun marqueur, le dernier message de la session, et l'état, la ligne de fin et --liste disent « rapport sans marqueur : à vérifier dans le journal ».

/** La ligne qui ouvre le rapport final d'une session (briefs/bras-A.md, briefs/bras-sequence-v2d.md, consignes de reprise de run/run.ts). */
export const MARQUEUR = '=== FINI ===';
/** Le message commence par la ligne MARQUEUR (seule sur sa ligne, espaces autour tolérés). */
export const marque = (texte: string) => texte.trimStart().split('\n')[0].trimEnd() === MARQUEUR;

/** Message de l'assistant sans appel d'outil ; `tour` : 1 pour le tour du prompt, 2 et plus pour un tour ouvert après lui (une notification de tâche) ;
 * `marque` : il commence par MARQUEUR ; `apres` : il vient après le rapport (dans son tour ou un tour suivant), il ne le remplace pas (issue #57) ;
 * `sujet` : la session ne faisait pas le travail demandé mais autre chose (L723 : « résolution du conflit au rebase »). */
export interface Message { texte: string; tour: number; marque?: true; apres?: true; sujet?: string }
export type Evenement = { type?: string; result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string; task_id?: string;
  modelUsage?: Record<string, Record<string, number>>; message?: { id?: string; content?: unknown } };
type Bloc = { type?: string; text?: string };
/** `travail` : le result du tour du rapport (il décide de l'état) ; `fin` : le dernier result (coût et jetons, cumulés depuis le début de la session) ;
 * `apres` : un tour a commencé après celui du rapport (une notification de tâche, ou une réponse de l'assistant), même coupé avant son result. */
export interface Flux { travail: Evenement | null; fin: Evenement | null; messages: Message[]; apres: boolean }
/** Un tour : `result` absent si le flux a été coupé pendant le tour. */
interface Tour { result?: Evenement }

function evenements(stdout: string): Evenement[] {
  return stdout.split('\n').flatMap((l): Evenement[] => {
    try {
      const j = JSON.parse(l);
      return j && typeof j === 'object' ? [j] : [];
    } catch {
      return [];
    }
  });
}

function blocs(ev: Evenement): Bloc[] {
  const c = ev.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as Bloc[]) : [];
}

/** Sortie de claude -p, stream-json (une ligne par événement) ou json (un seul objet, un seul tour). */
export function lireFlux(stdout: string): Flux {
  const evs = evenements(stdout);
  const estResultat = (e: Evenement) => e.type === 'result' || (e.type === undefined && evs.length === 1);
  const debutTour = (e: Evenement) => e.type === 'assistant' || (e.type === 'system' && e.subtype === 'task_notification');
  const messages: Message[] = [], tours: Tour[] = [];
  // Un message de l'assistant peut arriver en plusieurs événements (un par bloc, même id) : il compte s'il n'appelle aucun outil.
  let enCours = new Map<string, { texte: string; outil: boolean }>();
  let outil = false, ouvert = false;
  const fermerTour = (r?: Evenement) => {
    const avant = messages.length, tour = tours.length + 1;
    for (const m of enCours.values()) {
      if (!m.outil && m.texte.trim()) messages.push({ texte: m.texte, tour, ...(marque(m.texte) ? { marque: true } : {}) });
    }
    if (messages.length === avant && r?.result) messages.push({ texte: r.result, tour, ...(marque(r.result) ? { marque: true } : {}) });
    tours.push(r ? { result: r } : {});
    enCours = new Map();
    outil = false;
    ouvert = false;
  };
  for (const [i, ev] of evs.entries()) {
    if (estResultat(ev)) {
      fermerTour(ev);
      continue;
    }
    if (debutTour(ev)) ouvert = true;
    if (ev.type !== 'assistant') continue;
    const id = ev.message?.id ?? `#${i}`;
    const m = enCours.get(id) ?? { texte: '', outil: false };
    enCours.set(id, m);
    for (const b of blocs(ev)) {
      if (b.type === 'tool_use') m.outil = outil = true;
      else if (b.type === 'text' && b.text) m.texte += m.texte ? `\n${b.text}` : b.text;
    }
  }
  const coupe = ouvert; // un tour a commencé sans finir : flux coupé avant son result (signal, délai)
  if (enCours.size || outil) fermerTour(); // ce qui a été dit reste ; un tour coupé qui travaillait compte (le travail n'a pas fini)
  // Le rapport : le dernier message marqué ; sans marqueur, le dernier message, et le dernier tour décide (coupé : la session n'a pas fini).
  let ir = -1;
  for (const [i, m] of messages.entries()) if (m.marque) ir = i;
  const r = ir >= 0 ? messages[ir].tour - 1 : tours.length - 1;
  for (const [i, m] of messages.entries()) if (ir >= 0 && i > ir) m.apres = true;
  const apres = tours.length > r + 1 || (coupe && tours.length === r + 1 && !!tours[r].result); // un tour après celui du rapport, fini ou coupé
  return { travail: tours[r]?.result ?? null, fin: tours.filter((t) => t.result).at(-1)?.result ?? null, messages, apres };
}

/** Garde la session dans l'état (`messages` ajoutés, jamais remplacés) et écrit au journal chaque message, dans l'ordre, quelle que soit la fin de la session.
 * `fini` : le travail a fini ; le dernier message non `apres` (lireFlux) est alors le rapport (`rapport` de l'état, son tour dans `rapport_tour`,
 * `rapport_sans_marqueur` s'il ne commence pas par MARQUEUR : à vérifier dans le journal).
 * Sinon (échec, délai, signal, quota), l'état ne reçoit pas de rapport et le journal nomme ce dernier message pour ce qu'il est : le dernier dit avant l'arrêt,
 * celui où le lead lit ce qui a été fait et ce qui reste.
 * `sujet` (L723) : la session faisait autre chose que le travail (une résolution de conflit) ; ses messages vont à l'état et au journal, marqués de leur sujet,
 * et le rapport reste celui du travail : un « fini » de résolution ne le remplace jamais. */
export function garderRapport(e: EtatRapport, messages: Message[], out: (l: string) => void, fini = true, sujet?: string): void {
  const travail = messages.filter((m) => !m.apres), dernier = travail.at(-1);
  if (fini && dernier && !sujet) {
    e.rapport = dernier.texte; e.rapport_tour = dernier.tour;
    if (dernier.marque) delete e.rapport_sans_marqueur; else e.rapport_sans_marqueur = true;
  }
  e.messages = [...(e.messages ?? []), ...messages.map((m) => (sujet ? { ...m, sujet } : m))];
  for (const m of messages) {
    const tour = m.tour > 1 ? `tour ${m.tour}, ` : '';
    if (m.apres) out(`session, tour ${m.tour}, après le rapport (ne change ni le rapport ni l'état du run) : ${m.texte}`);
    else if (sujet) out(`session, ${tour}${sujet}${m === dernier ? (fini ? ', fin (ne remplace pas le rapport du travail)' : ', dernier message avant l\'arrêt') : ''} : ${m.texte}`);
    else if (m !== dernier) out(`session, ${tour}pendant le travail : ${m.texte}`);
    else if (fini) out(`session, rapport${origineJournal(m)} : ${m.texte}`);
    else out(`session, ${tour}dernier message avant l'arrêt (travail non fini) : ${m.texte}`);
  }
}

/** Ce que l'état garde du rapport (run/run.ts, Etat). */
export interface EtatRapport { rapport?: string; rapport_tour?: number; rapport_sans_marqueur?: true; messages?: Message[] }
const SANS_MARQUEUR = 'rapport sans marqueur : à vérifier dans le journal';
const origineJournal = (m: Message) => (!m.marque ? ' (sans marqueur : le dernier message de la session, à vérifier)'
  : m.tour > 1 ? ` (marqué, tour ${m.tour})` : '');
/** D'où vient le rapport, pour la ligne de fin et --liste : marqué et son tour, ou sans marqueur (L728). */
export const origineRapport = (e: EtatRapport) => (e.rapport_sans_marqueur ? SANS_MARQUEUR : `rapport marqué, tour ${e.rapport_tour}`);
/** La consigne de fin partagée par les reprises d'une session (quota, bascule, conflit, correction) : même consigne que les briefs. */
export const CONSIGNE_FINI = `puis dis « fini » dans un message qui commence par la ligne « ${MARQUEUR} » (seule sur sa ligne, et nulle part ailleurs)`;
