// Issue #57 (compte pro, 13-11) : en --output-format json, claude -p ne rend que le message final du DERNIER tour. Une notification de tâche arrivée après
// le rapport (un agent ou une commande de fond qui finit) ouvre un tour de plus, et sa réponse remplaçait le rapport dans le journal et l'état du run.
// La session parle donc en stream-json (../bench/bras.ts, argsClaude) : chaque tour finit par un événement `result`. Le tour 1 est celui du prompt ; un tour
// suivant n'a pas été ouvert par le prompt (en vrai flux, après un événement system/task_notification, rien dans un message user :
// test/fixtures/flux-notification-tardive-2.1.293.jsonl). Les tours se comptent donc sur les `result`, quel que soit le format de la notification.
// Issue #58 (L728) : l'inverse. Le tour du prompt finit sur une ligne d'attente pendant que la suite tourne en fond ; la session reprend le travail aux tours
// ouverts par les notifications, et le vrai rapport est au dernier (test/fixtures/flux-attente-tache-de-fond-2.1.293.jsonl). Le flux dit quand une tâche de
// fond démarre (system/task_started) et finit (system/task_notification) : voir tourDuRapport.

/** Message de l'assistant sans appel d'outil ; `tour` : 1 pour le tour du prompt, 2 et plus pour un tour ouvert après lui (une notification de tâche) ;
 * `apres` : son tour vient après celui du rapport, il ne le remplace pas (issue #57) ;
 * `sujet` : la session ne faisait pas le travail demandé mais autre chose (L723 : « résolution du conflit au rebase »). */
export interface Message { texte: string; tour: number; apres?: true; sujet?: string }
export type Evenement = { type?: string; result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string; task_id?: string;
  modelUsage?: Record<string, Record<string, number>>; message?: { id?: string; content?: unknown } };
type Bloc = { type?: string; text?: string };
/** `travail` : le result du tour du rapport (il décide de l'état) ; `fin` : le dernier result (coût et jetons, cumulés depuis le début de la session) ;
 * `apres` : un tour a commencé après celui du rapport (une notification de tâche, ou une réponse de l'assistant), même coupé avant son result. */
export interface Flux { travail: Evenement | null; fin: Evenement | null; messages: Message[]; apres: boolean }
/** Un tour : `outil` s'il a appelé un outil (il travaille ; sinon, après le tour 1, il ne fait que répondre à une notification), `actives` : les tâches de fond
 * encore en cours à sa fin, `result` : absent si le flux a été coupé pendant le tour. */
interface Tour { outil: boolean; actives: number; result?: Evenement }

/** Le tour du rapport : le premier tour de travail (le tour 1, ou un tour suivant qui appelle un outil) qui finit sans tâche de fond active ; un tour qui
 * ne fait que répondre à une notification n'est jamais le rapport (issue #57), ni après ce point ni avant. À défaut de signal (aucun task_started, ou des
 * tâches encore actives à la fin du dernier tour de travail), le dernier tour de travail. */
function tourDuRapport(tours: Tour[], signal: boolean): number {
  const travail = tours.flatMap((t, i) => (i === 0 || t.outil ? [i] : []));
  return (signal ? travail.find((i) => tours[i].result && !tours[i].actives) : undefined) ?? travail.at(-1) ?? 0;
}

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
  const messages: Message[] = [], tours: Tour[] = [], actives = new Set<string>();
  // Un message de l'assistant peut arriver en plusieurs événements (un par bloc, même id) : il compte s'il n'appelle aucun outil.
  let enCours = new Map<string, { texte: string; outil: boolean }>(), outil = false, signal = false, ouvert = false;
  const fermerTour = (r?: Evenement) => {
    const avant = messages.length, tour = tours.length + 1;
    for (const m of enCours.values()) {
      if (!m.outil && m.texte.trim()) messages.push({ texte: m.texte, tour });
    }
    if (messages.length === avant && r?.result) messages.push({ texte: r.result, tour });
    tours.push({ outil, actives: actives.size, ...(r ? { result: r } : {}) });
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
    if (ev.type === 'system' && ev.task_id && ev.subtype === 'task_started') { actives.add(ev.task_id); signal = true; }
    if (ev.type === 'system' && ev.task_id && ev.subtype === 'task_notification') actives.delete(ev.task_id);
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
  const r = tourDuRapport(tours, signal);
  for (const m of messages) if (m.tour > r + 1) m.apres = true;
  const apres = tours.length > r + 1 || (coupe && tours.length === r + 1 && !!tours[r].result); // un tour après celui du rapport, fini ou coupé
  return { travail: tours[r]?.result ?? null, fin: tours.filter((t) => t.result).at(-1)?.result ?? null, messages, apres };
}

/** Garde la session dans l'état (`messages` ajoutés, jamais remplacés) et écrit au journal chaque message, dans l'ordre, quelle que soit la fin de la session.
 * `fini` : le travail a fini ; le dernier message du tour du rapport (lireFlux) est alors le rapport (`rapport` de l'état, son tour dans `rapport_tour`).
 * Sinon (échec, délai, signal, quota), l'état ne reçoit pas de rapport et le journal nomme ce dernier message pour ce qu'il est : le dernier dit avant l'arrêt,
 * celui où le lead lit ce qui a été fait et ce qui reste.
 * `sujet` (L723) : la session faisait autre chose que le travail (une résolution de conflit) ; ses messages vont à l'état et au journal, marqués de leur sujet,
 * et le rapport reste celui du travail : un « fini » de résolution ne le remplace jamais. */
export function garderRapport(e: { rapport?: string; rapport_tour?: number; messages?: Message[] }, messages: Message[], out: (l: string) => void, fini = true, sujet?: string): void {
  const travail = messages.filter((m) => !m.apres), dernier = travail.at(-1);
  if (fini && dernier && !sujet) { e.rapport = dernier.texte; e.rapport_tour = dernier.tour; }
  e.messages = [...(e.messages ?? []), ...messages.map((m) => (sujet ? { ...m, sujet } : m))];
  for (const m of messages) {
    const tour = m.tour > 1 ? `tour ${m.tour}, ` : '';
    if (m.apres) out(`session, tour ${m.tour}, après le rapport (notification de tâche ; ne change ni le rapport ni l'état du run) : ${m.texte}`);
    else if (sujet) out(`session, ${tour}${sujet}${m === dernier ? (fini ? ', fin (ne remplace pas le rapport du travail)' : ', dernier message avant l\'arrêt') : ''} : ${m.texte}`);
    else if (m !== dernier) out(`session, ${tour}pendant le travail : ${m.texte}`);
    else if (fini) out(`session, rapport${m.tour > 1 ? ` (${origineRapport(m.tour)})` : ''} : ${m.texte}`);
    else out(`session, ${tour}dernier message avant l'arrêt (travail non fini) : ${m.texte}`);
  }
}

/** De quel tour vient le rapport, pour le journal, la ligne de fin et --liste (issue #58). */
export const origineRapport = (tour: number) => (tour === 1 ? 'tour 1, celui du prompt'
  : `tour ${tour} : la session a repris le travail sur notification de tâche, après le tour du prompt`);
