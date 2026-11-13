import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lire, type Executeur } from '../src/bench/bras.js';
import { garderRapport, lireFlux } from '../src/rapport.js';
import { executerRun } from '../src/run/run.js';
import { commite, depot, io } from './run-outils.js';

// Issue #57 du compte pro (13-11) : un run --fond fini « integre » n'a gardé, dans son journal et son état, que le dernier message de la session, une réponse
// à une notification de tâche arrivée après le rapport ; le rapport (commits, tests scellés à resceller, vérifié / non vérifié) n'était plus que dans le transcript.
// Les flux sont capturés de vrais `claude -p --output-format stream-json --verbose --model haiku` (2.1.293, 13-11) ; seuls l'événement init (réduit à
// quelques champs) et les chemins ont été retouchés. La notification y est un événement system/task_notification, jamais un message user.
const fixture = (nom: string) => readFileSync(join(import.meta.dirname, 'fixtures', nom), 'utf8');
const TARDIVE = fixture('flux-notification-tardive-2.1.293.jsonl');
const PENDANT = fixture('flux-notification-pendant-le-travail-2.1.293.jsonl');

const ligne = (o: object) => JSON.stringify(o);
const assistant = (id: string, ...content: object[]) => ligne({ type: 'assistant', message: { id, role: 'assistant', content } });
const texte = (text: string) => ({ type: 'text', text });
const outil = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'git commit' } });
const notification = ligne({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'Background command completed' });
const resultat = (session: string, result: string, cout: number, erreur = false, subtype = 'success') =>
  ligne({ type: 'result', subtype, is_error: erreur, session_id: session, total_cost_usd: cout, ...(result ? { result } : {}) });
const QUOTA = 'You\'ve hit your weekly limit · resets Thu 9am (Europe/Paris)';
const AVANT = 'Fichier créé et commité, je lance la suite complète.'; // ce que la session a dit avant de s'arrêter : c'est là que le lead lit où elle en était
/** Joue un run avec un faux claude qui rend `sorties` dans l'ordre (une par session) ; rend l'état relu sur disque et le journal. */
function lancer(sorties: ReturnType<Executeur>[], opts: Partial<Parameters<typeof executerRun>[0]> = {}) {
  const repo = depot(), { l, out } = io(), appels: string[][] = [];
  const exec: Executeur = (args, o) => {
    appels.push(args);
    commite(appels.length === 1 ? 'fait.txt' : `fait${appels.length}.txt`)(o.cwd); // fait.txt : la porte du dépôt
    return sorties[appels.length - 1];
  };
  const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out, maintenant: () => new Date('2026-11-11T16:00:00Z'), attendre: null, ...opts });
  const etat = JSON.parse(readFileSync(e.fichier, 'utf8')) as { etat: string; detail: string; rapport?: string; messages?: { texte: string; tour: number }[] };
  return { e, etat, journal: l.join('\n'), appels };
}
const RAPPORT = 'fini. Commits : 1a2b3c4 (issue #57). Tests scellés à resceller : test/x.test.ts. Vérifié : suite verte. Non vérifié : la capture.';
const TARD = 'Notification tardive : rien de neuf, le rapport « fini » reste valable.';

describe('cadence run garde le rapport de fin de travail (issue #57)', () => {
  it('vrai flux : la réponse tardive, qui dit « Fini », reste au tour 2 ; le rapport est le message du tour du prompt', () => {
    const f = lireFlux(TARDIVE);
    expect(f.messages).toEqual([
      { texte: 'fini, commande lancée en fond.', tour: 1 },
      { texte: 'Fini : la commande en arrière-plan a bien terminé avec le code de sortie 0.', tour: 2 },
    ]);
    expect(f.travail?.result).toBe('fini, commande lancée en fond.');
    expect(f.fin?.total_cost_usd).toBeGreaterThan(f.travail?.total_cost_usd ?? Infinity); // le dernier result cumule
    expect(f.apres).toBe(true);
  });

  it('vrai flux : une notification pendant le travail ne change pas le tour ; le rapport est celui du tour 1, la réponse tardive va au tour 2', () => {
    const { messages } = lireFlux(PENDANT);
    expect(messages).toEqual([
      { texte: 'fini, trois commandes lancées.', tour: 1 },
      { texte: 'fini : la commande « tardif » en arrière-plan s\'est terminée avec le code 0.', tour: 2 },
    ]);
    const e: { rapport?: string } = {}, lignes: string[] = [];
    garderRapport(e, messages, (x) => lignes.push(x));
    expect(e.rapport).toBe('fini, trois commandes lancées.');
    expect(lignes).toEqual([
      'session, rapport : fini, trois commandes lancées.',
      'session, tour 2, après le rapport (notification de tâche ; ne change ni le rapport ni l\'état du run) : fini : la commande « tardif » en arrière-plan s\'est terminée avec le code 0.',
    ]);
  });

  it('run sur le vrai flux : le journal écrit tous les messages, dans l\'ordre ; l\'état garde le rapport, les messages et le coût cumulé', () => {
    const repo = depot(), { l, out } = io(), appels: string[][] = [];
    const exec: Executeur = (args, o) => {
      appels.push(args);
      commite('fait.txt')(o.cwd);
      const i = args.indexOf('--session-id');
      return { stdout: TARDIVE.replaceAll('4ac4aee7-0d65-49a0-b15d-51761b43a6a8', args[i + 1]), code: 0 };
    };
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec, out });
    expect(e.etat).toBe('integre');
    expect(appels[0]).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']));
    const etat = JSON.parse(readFileSync(e.fichier, 'utf8'));
    expect(etat.rapport).toBe('fini, commande lancée en fond.');
    expect(etat.messages.map((m: { tour: number }) => m.tour)).toEqual([1, 2]);
    expect(etat.cout_usd).toBeCloseTo(0.00773859);
    const journal = l.join('\n');
    expect(journal.indexOf('session, rapport : fini, commande lancée en fond.')).toBeGreaterThan(-1);
    expect(journal.indexOf('session, rapport : fini')).toBeLessThan(journal.indexOf('session, tour 2, après le rapport'));
  });

  it('un message « fini » pendant le travail, un appel d\'outil, puis le rapport : tous au journal, le rapport est le dernier du tour 1', () => {
    const flux = [assistant('a', texte('Agent lancé, fini pour cette étape.')), notification, assistant('b', outil('t')), assistant('c', texte(RAPPORT)),
      resultat('s', RAPPORT, 1), notification, assistant('d', texte(TARD)), resultat('s', TARD, 1.2)].join('\n');
    const e: { rapport?: string } = {}, lignes: string[] = [];
    garderRapport(e, lireFlux(flux).messages, (x) => lignes.push(x));
    expect(e.rapport).toBe(RAPPORT);
    expect(lignes).toEqual([
      'session, pendant le travail : Agent lancé, fini pour cette étape.',
      `session, rapport : ${RAPPORT}`,
      `session, tour 2, après le rapport (notification de tâche ; ne change ni le rapport ni l'état du run) : ${TARD}`,
    ]);
  });

  it('un tour tardif ne décide plus de la session : ni son erreur, ni son code de sortie, ni son texte de quota ; le coût reste le dernier', () => {
    const quota = 'You\'ve hit your limit · resets 6pm (Europe/Paris)';
    const flux = [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1), notification, assistant('b', texte(quota)), resultat('s', quota, 1.1, true)].join('\n');
    expect(lire({ stdout: flux, code: 1 })).toMatchObject({ echec: null, resultat: RAPPORT, session: 's', cout: 1.1 });
    const coupe = [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1), notification].join('\n'); // tué pendant le tour tardif, avant son result
    expect(lire({ stdout: coupe, code: 143, erreur: 'SIGTERM' }).echec).toBeNull();
    expect(lire({ stdout: [assistant('a', texte(RAPPORT)), resultat('s', RAPPORT, 1)].join('\n'), code: 1 }).echec).toBe('code 1'); // un seul tour : le code compte
  });

  it('un travail en échec reste un échec, même suivi d\'un tour réussi ; le détail nomme l\'erreur et la cite, jamais « success »', () => {
    const api = 'API Error: 500 {"type":"error"}\nrien de plus';
    const flux = [assistant('a', texte('Erreur.')), resultat('s', api, 1, true), notification, assistant('b', texte(TARD)), resultat('s', TARD, 1.1)].join('\n');
    expect(lire({ stdout: flux, code: 0 }).echec).toBe('session s : erreur (« API Error: 500 {"type":"error"} »)');
    expect(lire({ stdout: [assistant('a', texte('Erreur.')), resultat('s', '', 1, true)].join('\n'), code: 1 }).echec).toBe('session s : erreur, code 1');
    expect(lire({ stdout: [assistant('a', texte(AVANT)), resultat('s', '', 0.5, true, 'error_max_turns')].join('\n'), code: 1 }).echec).toBe('session s : error_max_turns, code 1');
  });

  it('flux coupé avant tout result : ce qui a été dit est gardé au tour 1 ; le détail dit l\'arrêt et le dernier message, « illisible » seulement sans message', () => {
    const flux = [assistant('a', texte('Je commence.')), assistant('b', outil('t'))].join('\n');
    expect(lireFlux(flux)).toMatchObject({ travail: null, messages: [{ texte: 'Je commence.', tour: 1 }], apres: false });
    expect(lire({ stdout: flux, code: 143, erreur: 'SIGTERM' }).echec).toBe('session arrêtée avant son result (SIGTERM) ; dernier message : Je commence.');
    expect(lire({ stdout: '{"type":"system","subtype":"init"}', code: 143 }).echec).toBe('sortie illisible (code 143) : {"type":"system","subtype":"init"}');
  });

  // Revue r2 de l'issue #57 (majeur 1) : les branches échec et quota de run.ts rendaient la main avant garderRapport ; sur un échec, un délai, un signal ou
  // un quota, rien de ce que la session avait dit n'allait au journal ni à l'état, là même où le lead en a besoin. Un test par fin de session.
  describe('les messages de la session vont au journal et à l\'état quelle que soit sa fin', () => {
    const coupe = [assistant('a', texte('Je commence.')), assistant('b', outil('t')), assistant('c', texte(AVANT))].join('\n'); // aucun result : tour coupé
    const avantArret = `session, dernier message avant l'arrêt (travail non fini) : ${AVANT}`;
    const attendu = (r: ReturnType<typeof lancer>) => {
      expect(r.etat.messages).toEqual([{ texte: 'Je commence.', tour: 1 }, { texte: AVANT, tour: 1 }]);
      expect(r.etat.rapport).toBeUndefined(); // pas de rapport : le travail n'a pas fini
      expect(r.journal.indexOf('session, pendant le travail : Je commence.')).toBeGreaterThan(-1);
      expect(r.journal.indexOf('session, pendant le travail : Je commence.')).toBeLessThan(r.journal.indexOf(avantArret));
    };

    it('échec (error_max_turns, code 1) : état echec, détail nommé, messages au journal et à l\'état', () => {
      const r = lancer([{ stdout: `${coupe}\n${resultat('s', '', 0.5, true, 'error_max_turns')}`, code: 1 }]);
      expect(r.etat).toMatchObject({ etat: 'echec', detail: 'session s : error_max_turns, code 1' });
      attendu(r);
    });

    it('délai de 4 h dépassé (flux coupé, SIGTERM par l\'enveloppe) : la cause puis les messages, dans l\'ordre', () => {
      const r = lancer([{ stdout: coupe, code: 143, erreur: 'SIGTERM', delaiMs: 4 * 3600_000 }]);
      expect(r.etat).toMatchObject({ etat: 'echec', detail: `session arrêtée avant son result (SIGTERM) ; dernier message : ${AVANT}` });
      expect(r.journal).toMatch(/délai de 4 h dépassé : le run a arrêté la session claude/);
      expect(r.journal.indexOf('délai de 4 h dépassé')).toBeLessThan(r.journal.indexOf('session, pendant le travail'));
      attendu(r);
    });

    it('signal reçu par la session (flux coupé, code 143) : messages au journal et à l\'état', () => {
      const r = lancer([{ stdout: coupe, code: 143, erreur: 'SIGTERM' }]);
      expect(r.etat).toMatchObject({ etat: 'echec', detail: `session arrêtée avant son result (SIGTERM) ; dernier message : ${AVANT}` });
      expect(r.journal).toMatch(/l'enveloppe de la session claude a été tuée par SIGTERM/);
      attendu(r);
    });

    it('quota hebdo : état quota, ce que la session a dit avant la limite est au journal et à l\'état', () => {
      const r = lancer([{ stdout: `${coupe}\n${resultat('s', QUOTA, 0.5, true)}`, code: 1 }]);
      expect(r.etat).toMatchObject({ etat: 'quota', detail: expect.stringMatching(/^limite hebdo atteinte/) });
      attendu(r);
    });

    it('limite Opus puis bascule sur fable : les messages des deux sessions se suivent, le rapport est celui de la session qui a fini', () => {
      const opus = 'You\'ve hit your Opus limit · resets Fri 10am (Europe/Paris)';
      const r = lancer([{ stdout: `${coupe}\n${resultat('s', opus, 0.5, true)}`, code: 1 }, { stdout: TARDIVE, code: 0 }]);
      expect(r.e).toMatchObject({ etat: 'integre', modele: 'fable' });
      expect(r.appels).toHaveLength(2);
      expect(r.etat.rapport).toBe('fini, commande lancée en fond.');
      expect(r.etat.messages!.map((m) => [m.tour, m.texte])).toEqual([
        [1, 'Je commence.'], [1, AVANT], [1, 'fini, commande lancée en fond.'],
        [2, 'Fini : la commande en arrière-plan a bien terminé avec le code de sortie 0.'],
      ]);
      const i = (s: string) => r.journal.indexOf(s);
      expect(i(avantArret)).toBeGreaterThan(-1);
      expect(i(avantArret)).toBeLessThan(i('limite Opus atteinte : bascule sur fable'));
      expect(i('limite Opus atteinte')).toBeLessThan(i('session, rapport : fini, commande lancée en fond.'));
      expect(i('session, rapport :')).toBeLessThan(i('session, tour 2, après le rapport'));
    });
  });

  it('un message en plusieurs événements (un par bloc, même id) ne compte que sans appel d\'outil', () => {
    const flux = [assistant('a', texte('Je regarde.')), assistant('a', outil('t')), assistant('b', texte('Le type est défini, voilà.')), resultat('s', 'x', 0)].join('\n');
    expect(lireFlux(flux).messages).toEqual([{ texte: 'Le type est défini, voilà.', tour: 1 }]);
  });

  it('la sortie json d\'avant (un seul objet) se lit encore : un tour, son message est celui du result', () => {
    expect(lireFlux(ligne({ session_id: 's', result: 'fini', total_cost_usd: 0 }))).toMatchObject({
      travail: { session_id: 's' }, messages: [{ texte: 'fini', tour: 1 }], apres: false,
    });
  });
});
