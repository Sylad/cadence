// L724 : la reprise après une porte rouge remplaçait le rapport du travail par le « fini » de la session de correction (même famille que l'issue #57 et
// que le conflit de rebase, L723). Le rapport reste celui du travail ; la correction est ajoutée à l'état (`corrections`) et au journal.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { executerRun, repondreRun, type Etat } from '../src/run/run.js';
import { commite, depot, fauxClaude, io, sortie } from './run-outils.js';

/** Faux claude dont chaque session rend son propre dernier message (`reponses`), comme un vrai rapport de travail puis une réponse de correction. */
const parlant = (exec: Executeur, reponses: string[]): Executeur => (args, o) => {
  const r = exec(args, o), j = JSON.parse(r.stdout);
  return { ...r, stdout: sortie(j.session_id, reponses.shift() ?? j.result) };
};
const RAPPORT = 'fini. Commit : ajoute autre.txt. Vérifié : suite ciblée. Non vérifié : la porte complète.';
const CORRECTION = 'fini : fait.txt manquait, ajouté et commité.';
const relire = (e: Etat) => JSON.parse(readFileSync(e.fichier, 'utf8')) as Etat;

describe('cadence run : correction après porte rouge (L724)', () => {
  it('run complet porte rouge → correction → porte verte : rapport du travail intact, correction visible dans l\'état et au journal', () => {
    const repo = depot(), { l, out } = io();
    const e = executerRun({ repo, demande: 'Crée fait.txt', exec: parlant(fauxClaude([commite('autre.txt'), commite('fait.txt')]), [RAPPORT, CORRECTION]), out });
    const etat = relire(e), journal = l.join('\n');
    expect(etat.etat).toBe('integre');
    expect(etat.rapport).toBe(RAPPORT); // le « fini » de la correction ne le remplace pas
    expect(etat.corrections).toEqual([{ rouge: '$ test -f fait.txt\n', message: CORRECTION, verte: true }]);
    expect(etat.messages).toEqual([{ texte: RAPPORT, tour: 1 }, { texte: CORRECTION, tour: 1, sujet: 'correction après porte rouge' }]);
    expect(etat.detail).toBe(`porte rouge ($ test -f fait.txt) corrigée par la session, porte verte ensuite ; la session : ${CORRECTION}`);
    const lignes = [
      `session, rapport : ${RAPPORT}`,
      'porte rouge : reprise de la session pour corriger :\n$ test -f fait.txt',
      `session, correction après porte rouge, fin (ne remplace pas le rapport du travail) : ${CORRECTION}`,
      etat.detail,
      `cadence run ${e.id} : integre (main = ${e.integre})`,
    ];
    const positions = lignes.map((x) => journal.indexOf(x));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b)); // dans cet ordre
    expect(journal.slice(journal.indexOf(`cadence run ${e.id} : integre`))).toContain(`\n${etat.detail}`); // la ligne de fin nomme la correction
  });

  it('porte encore rouge après la correction : rapport intact, correction gardée non verte, rendu en porte-rouge', () => {
    const repo = depot();
    const e = executerRun({ repo, demande: 'x', exec: parlant(fauxClaude([commite('a.txt'), commite('b.txt')]), [RAPPORT, 'fini, corrigé je crois']), out: () => {} });
    const etat = relire(e);
    expect(etat.etat).toBe('porte-rouge');
    expect(etat.rapport).toBe(RAPPORT);
    expect(etat.corrections).toEqual([{ rouge: '$ test -f fait.txt\n', message: 'fini, corrigé je crois', verte: false }]);
  });

  it('porte-rouge puis --reponse : la réponse est une correction, le rapport du travail reste, la porte verte ensuite est notée', () => {
    const repo = depot(), exec = parlant(fauxClaude([commite('a.txt'), commite('b.txt'), commite('fait.txt')]), [RAPPORT, 'raté', CORRECTION]);
    const e1 = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(e1.etat).toBe('porte-rouge');
    const { l, out } = io(), e2 = repondreRun(e1.id, repo, 'crée fait.txt', { exec, out });
    const etat = relire(e2);
    expect(etat.etat).toBe('integre');
    expect(etat.rapport).toBe(RAPPORT);
    expect(etat.corrections?.map((c) => [c.message, c.verte])).toEqual([['raté', false], [CORRECTION, true]]);
    expect(l.join('\n')).toContain(`session, correction après porte rouge, fin (ne remplace pas le rapport du travail) : ${CORRECTION}`);
  });
});
