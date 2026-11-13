import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lire, type Executeur } from '../src/bench/bras.js';
import { garderRapport, lireFlux } from '../src/rapport.js';
import { cmdRun } from '../src/run/cli.js';
import { executerRun } from '../src/run/run.js';
import { commite, depot, io } from './run-outils.js';

// Issue #58 du compte pro (13-11), l'inverse de #57 : une session cadence run --fond a fini le tour du prompt sur une ligne d'attente (« La recette navigateur
// complète tourne ; je surveille les échecs et sa fin. ») ; sept tours ont suivi, chacun ouvert par une notification de tâche, et le dernier tenait le vrai
// rapport. L'état a gardé la ligne d'attente. Règle tenue pour les deux cas : le rapport est celui du premier tour de travail (le prompt, ou un tour qui
// appelle un outil) qui finit sans tâche de fond active ; un tour qui ne fait que répondre à une notification ne le remplace pas (#57).
// flux-attente-tache-de-fond : vrai `claude -p --output-format stream-json --verbose --model haiku` (2.1.293, 13-11), une suite lancée en fond, une ligne
// d'attente, puis au tour 2 la sortie lue (Read), écrite (Bash) et le rapport ; seuls les événements hook et init (réduits) et les chemins ont été retouchés.
const fixture = (nom: string) => readFileSync(join(import.meta.dirname, 'fixtures', nom), 'utf8');
const ATTENTE = fixture('flux-attente-tache-de-fond-2.1.293.jsonl');
const TARDIVE = fixture('flux-notification-tardive-2.1.293.jsonl'); // #57 : rapport au tour 1, tour 2 qui ne fait que répondre à la notification
const LIGNE_ATTENTE = 'La suite tourne ; je surveille sa fin.';
const RAPPORT = 'Rapport : la suite est terminée avec le code de sortie 0. Sa sortie, lue avec l\'outil Read, est « suite: 12 tests verts ». Elle est écrite dans '
  + '`resultat.txt`, dans le dossier scratchpad de la session, et le fichier relu contient bien cette ligne.';

const ligne = (o: object) => JSON.stringify(o);
const assistant = (id: string, ...content: object[]) => ligne({ type: 'assistant', message: { id, role: 'assistant', content } });
const texte = (text: string) => ({ type: 'text', text });
const outil = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'git status' } });
const demarre = (task_id: string) => ligne({ type: 'system', subtype: 'task_started', task_id, is_backgrounded: true });
const notification = (task_id: string) => ligne({ type: 'system', subtype: 'task_notification', task_id, status: 'completed' });
const resultat = (result: string, cout: number) => ligne({ type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: cout, result });

/** Un run complet sur `flux` (l'id de session de la fixture remplacé par celui du run) ; rend l'état relu, le journal et la sortie de --liste. */
async function jouer(flux: string, session: string) {
  const repo = depot(), { l, out } = io();
  const exec: Executeur = (args, o) => {
    commite('fait.txt')(o.cwd);
    return { stdout: flux.replaceAll(session, args[args.indexOf('--session-id') + 1]), code: 0 };
  };
  const e = executerRun({ repo, demande: 'Lance la suite en fond et rends le rapport', exec, out });
  const liste: string[] = [];
  await cmdRun(['--liste'], { cwd: repo, env: {}, out: (x) => liste.push(x), err: () => {}, now: () => new Date() });
  return { e, etat: JSON.parse(readFileSync(e.fichier, 'utf8')), journal: l.join('\n'), liste: liste.join('\n') };
}

describe('cadence run : le rapport est celui du tour qui finit le travail (issue #58), un tour tardif ne le remplace pas (issue #57)', () => {
  it('vrai flux #58 : la ligne d\'attente du tour du prompt n\'est pas le rapport ; le tour 2, qui travaille et finit sans tâche active, l\'est', () => {
    const f = lireFlux(ATTENTE);
    expect(f.messages).toEqual([{ texte: LIGNE_ATTENTE, tour: 1 }, { texte: RAPPORT, tour: 2 }]);
    expect(f.travail?.result).toBe(RAPPORT);
    expect(f.apres).toBe(false);
    const e: { rapport?: string; rapport_tour?: number } = {}, lignes: string[] = [];
    garderRapport(e, f.messages, (x) => lignes.push(x));
    expect(e).toMatchObject({ rapport: RAPPORT, rapport_tour: 2 });
    expect(lignes).toEqual([
      `session, pendant le travail : ${LIGNE_ATTENTE}`,
      `session, rapport (tour 2 : la session a repris le travail sur notification de tâche, après le tour du prompt) : ${RAPPORT}`,
    ]);
  });

  it('vrai flux #57 : le tour 2 ne fait que répondre à la notification, le rapport reste au tour 1', () => {
    const f = lireFlux(TARDIVE);
    expect(f.messages).toEqual([
      { texte: 'fini, commande lancée en fond.', tour: 1 },
      { texte: 'Fini : la commande en arrière-plan a bien terminé avec le code de sortie 0.', tour: 2, apres: true },
    ]);
    expect(f.travail?.result).toBe('fini, commande lancée en fond.');
    expect(f.apres).toBe(true);
  });

  it('run sur le vrai flux #58 : état, journal, ligne de fin et --liste disent le rapport du tour 2', async () => {
    const r = await jouer(ATTENTE, 'e4e9732e-b2c0-4da2-83f5-8a01af4a3c8f');
    expect(r.e.etat).toBe('integre');
    expect(r.etat).toMatchObject({ rapport: RAPPORT, rapport_tour: 2 });
    expect(r.journal).toContain(`session, pendant le travail : ${LIGNE_ATTENTE}`);
    expect(r.journal).toMatch(/cadence run \S+ : integre \(main = \w+\) · \d+ s · [\d.]+ \$ · rapport : tour 2 : la session a repris le travail sur notification de tâche/);
    expect(r.liste).toContain('· rapport : tour 2 : la session a repris le travail sur notification de tâche, après le tour du prompt');
  });

  it('run sur le vrai flux #57 : le rapport reste celui du tour 1, la ligne de fin et --liste le disent', async () => {
    const r = await jouer(TARDIVE, '4ac4aee7-0d65-49a0-b15d-51761b43a6a8');
    expect(r.etat).toMatchObject({ rapport: 'fini, commande lancée en fond.', rapport_tour: 1 });
    expect(r.journal).toContain('session, tour 2, après le rapport (notification de tâche ; ne change ni le rapport ni l\'état du run) : Fini');
    expect(r.journal).toMatch(/ \$ · rapport : tour 1, celui du prompt/);
    expect(r.liste).toContain('· rapport : tour 1, celui du prompt');
  });

  it('plusieurs tours d\'attente : le rapport est le premier tour de travail qui finit sans tâche active ; un tour tardif qui travaille ensuite ne le remplace pas', () => {
    const flux = [assistant('a', outil('t1')), demarre('b1'), assistant('b', texte('La suite tourne.')), resultat('La suite tourne.', 1),
      notification('b1'), assistant('c', outil('t2')), demarre('b2'), assistant('d', texte('Une suite échoue, je la relance.')), resultat('relance', 1.1),
      notification('b2'), assistant('e', outil('t3')), assistant('f', texte('Rapport final.')), resultat('Rapport final.', 1.2),
      notification('x'), assistant('g', outil('t4')), assistant('h', texte('Rien de neuf.')), resultat('Rien de neuf.', 1.3)].join('\n');
    const f = lireFlux(flux);
    expect(f.messages.map((m) => [m.tour, m.texte, m.apres])).toEqual([
      [1, 'La suite tourne.', undefined], [2, 'Une suite échoue, je la relance.', undefined], [3, 'Rapport final.', undefined], [4, 'Rien de neuf.', true],
    ]);
    expect(f.travail?.result).toBe('Rapport final.');
    expect(f.fin?.total_cost_usd).toBe(1.3);
  });

  it('à défaut de signal (aucun task_started) : le rapport est le dernier tour de travail, jamais un tour qui ne fait que répondre', () => {
    const flux = [assistant('a', texte('J\'attends la suite.')), resultat('J\'attends la suite.', 1), notification('b1'),
      assistant('b', outil('t')), assistant('c', texte('Rapport.')), resultat('Rapport.', 1.1), notification('b2'), assistant('d', texte('Rien.')), resultat('Rien.', 1.2)].join('\n');
    expect(lireFlux(flux).messages.map((m) => [m.tour, m.apres])).toEqual([[1, undefined], [2, undefined], [3, true]]);
    expect(lireFlux(flux).travail?.result).toBe('Rapport.');
  });

  it('session coupée pendant un tour de travail qui suit l\'attente : échec nommé, jamais la ligne d\'attente comme rapport', () => {
    const coupe = ATTENTE.split('\n').filter(Boolean);
    const avant = coupe.slice(0, coupe.findIndex((l) => l.includes('"name":"Read"')) + 1).join('\n');
    expect(lire({ stdout: avant, code: 143, erreur: 'SIGTERM' }).echec).toBe(`session arrêtée avant son result (SIGTERM) ; dernier message : ${LIGNE_ATTENTE}`);
  });
});
