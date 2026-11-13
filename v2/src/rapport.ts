// Issue #57 (compte pro, 13-11) : en --output-format json, claude -p ne rend que le message final du DERNIER tour. Une notification de tâche arrivée après
// le rapport (un agent ou une commande de fond qui finit) ouvre un tour de plus, et sa réponse remplaçait le rapport dans le journal et l'état du run.
// La session parle donc en stream-json (../bench/bras.ts, argsClaude) : chaque tour finit par un événement `result`. Le tour 1 est celui du prompt, celui
// qui fait le travail ; un tour suivant n'a pas été ouvert par le prompt (en vrai flux, après un événement system/task_notification, rien dans un message
// user : test/fixtures/flux-notification-tardive-2.1.293.jsonl). Les tours se comptent donc sur les `result`, quel que soit le format de la notification.

/** Message de l'assistant sans appel d'outil ; `tour` : 1 pour le tour du prompt, 2 et plus pour un tour ouvert après lui (une notification de tâche) ;
 * `sujet` : la session ne faisait pas le travail demandé mais autre chose (L723 : « résolution du conflit au rebase »). */
export interface Message { texte: string; tour: number; sujet?: string }
export type Evenement = { type?: string; result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean; subtype?: string;
  modelUsage?: Record<string, Record<string, number>>; message?: { id?: string; content?: unknown } };
type Bloc = { type?: string; text?: string };
/** `travail` : le result du tour 1 (il décide de l'état) ; `fin` : le dernier result (coût et jetons, cumulés depuis le début de la session) ;
 * `apres` : un tour a commencé après celui du travail (une notification de tâche, ou une réponse de l'assistant), même coupé avant son result. */
export interface Flux { travail: Evenement | null; fin: Evenement | null; messages: Message[]; apres: boolean }

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
  const resultats = evs.filter(estResultat);
  const debutTour = (e: Evenement) => e.type === 'assistant' || (e.type === 'system' && e.subtype === 'task_notification');
  const apres = resultats.length > 0 && evs.slice(evs.indexOf(resultats[0]) + 1).some(debutTour);
  const messages: Message[] = [];
  // Un message de l'assistant peut arriver en plusieurs événements (un par bloc, même id) : il compte s'il n'appelle aucun outil.
  let tour = 1;
  let enCours = new Map<string, { texte: string; outil: boolean }>();
  const fermerTour = (r?: Evenement) => {
    const avant = messages.length;
    for (const m of enCours.values()) {
      if (!m.outil && m.texte.trim()) messages.push({ texte: m.texte, tour });
    }
    if (messages.length === avant && r?.result) messages.push({ texte: r.result, tour });
    enCours = new Map();
    tour++;
  };
  for (const [i, ev] of evs.entries()) {
    if (estResultat(ev)) {
      fermerTour(ev);
      continue;
    }
    if (ev.type !== 'assistant') continue;
    const id = ev.message?.id ?? `#${i}`;
    const m = enCours.get(id) ?? { texte: '', outil: false };
    enCours.set(id, m);
    for (const b of blocs(ev)) {
      if (b.type === 'tool_use') m.outil = true;
      else if (b.type === 'text' && b.text) m.texte += m.texte ? `\n${b.text}` : b.text;
    }
  }
  if (enCours.size) fermerTour(); // flux coupé avant son result (signal, délai) : ce qui a été dit reste
  return { travail: resultats[0] ?? null, fin: resultats.at(-1) ?? null, messages, apres };
}

/** Garde la session dans l'état (`messages` ajoutés, jamais remplacés) et écrit au journal chaque message, dans l'ordre, quelle que soit la fin de la session.
 * `fini` : le travail du tour 1 a fini ; son dernier message est alors le rapport (`rapport` de l'état). Sinon (échec, délai, signal, quota), l'état ne reçoit
 * pas de rapport et le journal nomme ce dernier message pour ce qu'il est : le dernier dit avant l'arrêt, celui où le lead lit ce qui a été fait et ce qui reste.
 * `sujet` (L723) : la session faisait autre chose que le travail (une résolution de conflit) ; ses messages vont à l'état et au journal, marqués de leur sujet,
 * et le rapport reste celui du travail : un « fini » de résolution ne le remplace jamais. */
export function garderRapport(e: { rapport?: string; messages?: Message[] }, messages: Message[], out: (l: string) => void, fini = true, sujet?: string): void {
  const travail = messages.filter((m) => m.tour === 1), dernier = travail.at(-1);
  if (fini && dernier && !sujet) e.rapport = dernier.texte;
  e.messages = [...(e.messages ?? []), ...messages.map((m) => (sujet ? { ...m, sujet } : m))];
  for (const m of messages) {
    if (m.tour > 1) out(`session, tour ${m.tour}, après le rapport (notification de tâche ; ne change ni le rapport ni l'état du run) : ${m.texte}`);
    else if (sujet) out(`session, ${sujet}${m === dernier ? (fini ? ', fin (ne remplace pas le rapport du travail)' : ', dernier message avant l\'arrêt') : ''} : ${m.texte}`);
    else if (m !== dernier) out(`session, pendant le travail : ${m.texte}`);
    else if (fini) out(`session, rapport : ${m.texte}`);
    else out(`session, dernier message avant l'arrêt (travail non fini) : ${m.texte}`);
  }
}
