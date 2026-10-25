import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFailedEntries } from '../src/state.js';
import { tempDir } from './helpers.js';

function classOf(...lines: string[]) {
  const dir = tempDir();
  writeFileSync(join(dir, 'deliveries-failed.log'), `${lines.map((l) => `2026-10-20 abc1234 ${l}`).join('\n')}\n`);
  return readFailedEntries(dir).map((e) => e.cls);
}

describe('L331 — classe des livraisons rouges d\'avant [cls], déduite du libellé', () => {
  it('R1 — « script de livraison en échec (code 2) » est un refus, tout autre code un déploiement (ligne maritime livrer.sh)', () => {
    expect(classOf(
      'script de livraison en échec (code 2) : ./scripts/livrer.sh',
      'script de livraison en échec (code 1) : ./scripts/livrer.sh',
      'script de livraison en échec (code 12) : ./scripts/livrer.sh',
      'script de livraison en échec (délai dépassé) : ./scripts/livrer.sh',
    )).toEqual(['refus', 'deploiement', 'deploiement', 'deploiement']);
  });

  it('R2 — « déploiement en échec » est un déploiement', () => {
    expect(classOf('déploiement en échec (code 1) : kubectl apply -f x.yaml')).toEqual(['deploiement']);
  });

  it('R3 — « CI en échec » (commande ou runs GitHub) et « gh run list en échec » sont de classe ci', () => {
    expect(classOf('CI en échec (code 1) : npm test', 'CI en échec : build (failure)', 'gh run list en échec : HTTP 502')).toEqual(['ci', 'ci', 'ci']);
  });

  it('R4 — « vérification en échec » est une vérification', () => {
    expect(classOf('vérification en échec après 120 s : GET https://x.dev — 503')).toEqual(['verification']);
  });

  it('R7 — les libellés CADENCE_DEPLOYED_FILE de deliver (sha déclaré invalide, fichier illisible) sont des déploiements', () => {
    expect(classOf(
      'CADENCE_DEPLOYED_FILE : « HEAD » n\'est pas un sha de commit du dépôt (le script doit y écrire le sha hexadécimal qu\'il a déployé, ni HEAD ni une branche, ou rien)',
      'CADENCE_DEPLOYED_FILE illisible : EACCES: permission denied',
    )).toEqual(['deploiement', 'deploiement']);
  });

  it('R8 — « CI non terminée après N s » est de classe ci, quel que soit N', () => {
    expect(classOf('CI non terminée après 1800 s', 'CI non terminée après 600 s')).toEqual(['ci', 'ci']);
  });

  it('R9 — « aucun run CI pour ce sha après N min » est de classe ci, quel que soit N', () => {
    expect(classOf(
      'aucun run CI pour ce sha après 5 min (le commit poussé est-il celui que la CI construit ?)',
      'aucun run CI pour ce sha après 10 min (le commit poussé est-il celui que la CI construit ?)',
    )).toEqual(['ci', 'ci']);
  });

  it('R5 — un libellé inconnu reste sans classe, et le libellé doit commencer la raison', () => {
    expect(classOf('quelque chose a cassé', 'le script de livraison en échec (code 2) : x', '')).toEqual([null, null, null]);
  });

  it('R6 — une classe écrite [cls] prime sur le libellé, et la raison garde son texte', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'deliveries-failed.log'), '2026-10-20 abc [ci] script de livraison en échec (code 2) : x\n2026-10-20 def script de livraison en échec (code 2) : x\n');
    expect(readFailedEntries(dir).map((e) => [e.cls, e.reason])).toEqual([
      ['ci', 'script de livraison en échec (code 2) : x'],
      ['refus', 'script de livraison en échec (code 2) : x'],
    ]);
  });
});
