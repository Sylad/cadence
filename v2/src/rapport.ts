// Issue #57 (compte pro, 13-11) : en --output-format json, claude -p ne rend que le message final du DERNIER tour. Une notification de tâche arrivée après
// le rapport (un agent ou une commande de fond qui finit) ouvre un tour de plus, et sa réponse remplaçait le rapport dans le journal et l'état du run.
// La session parle donc en stream-json (../bench/bras.ts, argsClaude) : chaque message final de tour est lu, gardé dans l'ordre, jamais remplacé.

/** Message final d'un tour ; `notification` : le tour a été ouvert par une notification de tâche (<task-notification>), pas par le prompt. */
export interface Message { texte: string; notification: boolean }
type Evenement = { type?: string; result?: string; message?: { id?: string; content?: unknown } };
type Bloc = { type?: string; text?: string };

/** Sortie de claude -p, stream-json (une ligne par événement) ou json (un seul objet) : `fin`, le dernier événement result ; `messages`, le message final de chaque tour. */
export function lireFlux(stdout: string): { fin: Evenement | null; messages: Message[] } {
  const evs = stdout.split('\n').flatMap((l): Evenement[] => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? [j] : []; } catch { return []; } });
  // Un message de l'assistant peut arriver en plusieurs événements (un par bloc, même id) : il finit le tour s'il n'appelle aucun outil.
  const suite: ({ notification: true } | { texte: string; outil: boolean })[] = [], parId = new Map<string, { texte: string; outil: boolean }>();
  for (const [i, ev] of evs.entries()) {
    const blocs = typeof ev.message?.content === 'string' ? [{ type: 'text', text: ev.message.content }] : Array.isArray(ev.message?.content) ? ev.message.content as Bloc[] : [];
    if (ev.type === 'user' && blocs.some((b) => b.type === 'text' && b.text?.includes('<task-notification>'))) suite.push({ notification: true });
    if (ev.type !== 'assistant') continue;
    const id = ev.message?.id ?? `#${i}`, m = parId.get(id) ?? { texte: '', outil: false };
    if (!parId.has(id)) { parId.set(id, m); suite.push(m); }
    for (const b of blocs) { if (b.type === 'tool_use') m.outil = true; else if (b.type === 'text' && b.text) m.texte += m.texte ? `\n${b.text}` : b.text; }
  }
  const messages: Message[] = [];
  let notification = false;
  for (const x of suite) {
    if ('notification' in x) notification = true;
    else if (!x.outil && x.texte.trim()) { messages.push({ texte: x.texte, notification }); notification = false; }
  }
  const fin = evs.filter((e) => e.type === 'result' || (e.type === undefined && evs.length === 1)).at(-1) ?? null;
  return { fin, messages: messages.length || !fin?.result ? messages : [{ texte: fin.result, notification: false }] };
}

/** Le rapport : le message qui dit « fini » (le brief le demande en fin de travail), de préférence hors d'un tour de notification ; sinon le dernier hors notification. */
export function choisirRapport(messages: Message[]): number {
  const fini = (m: Message) => /(?<!\p{L})fini(?!\p{L})/iu.test(m.texte); // « fini », pas « défini » ni « finir »
  for (const p of [(m: Message) => fini(m) && !m.notification, fini, (m: Message) => !m.notification]) for (let i = messages.length - 1; i >= 0; i--) if (p(messages[i])) return i;
  return messages.length - 1;
}

/** Garde le rapport de la session dans l'état (`rapport`, et `messages` ajoutés, jamais remplacés) et l'écrit au journal, suivi de ce qui est venu après. */
export function garderRapport(e: { rapport?: string; messages?: Message[] }, messages: Message[], out: (l: string) => void): void {
  if (!messages.length) return;
  const i = choisirRapport(messages);
  e.rapport = messages[i].texte; e.messages = [...(e.messages ?? []), ...messages];
  out(`session, rapport : ${e.rapport}`);
  for (const m of messages.slice(i + 1)) out(`session, après le rapport${m.notification ? ' (réponse à une notification de tâche, le rapport reste celui ci-dessus)' : ''} : ${m.texte}`);
}
