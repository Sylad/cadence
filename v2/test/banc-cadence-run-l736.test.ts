// L736 (M1 de docs/etudes/banc3-lenteur.md) : le banc court joue le vrai cadence run. Avant, cli.ts passait `pieces: []`
// à lancerBras (l'aiguillage choisissait toujours le brief de A) et le bras aiguillé perdait le modèle de bras.yaml.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piecesBanc, chargerBanc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';
import { dossierTemp } from './temp.js';

const BRIEFS = join(import.meta.dirname, '..', 'briefs');
function racine(): string {
  const r = dossierTemp('bench-l736-');
  for (const id of ['1-avec', '2-sans']) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', id, 'demande.md'), id === '1-avec' ? 'Voir la capture pieces/classement.png : le classement est faux.' : 'Corrige le classement.');
  }
  mkdirSync(join(r, 'bancs', '1-avec', 'pieces', 'sous'), { recursive: true });
  writeFileSync(join(r, 'bancs', '1-avec', 'pieces', 'classement.png'), 'x'); writeFileSync(join(r, 'bancs', '1-avec', 'pieces', 'sous', 'note.md'), 'n');
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${join(BRIEFS, 'bras-A.md')}\ncadence-run-sonnet:\n  modele: sonnet\n  brief: ${join(BRIEFS, 'bras-A.md')}\n  aiguillage: true\n`);
  return r;
}
const prep = (_b: unknown, cible: string) => {
  mkdirSync(cible, { recursive: true });
  execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
  return { testsBase: 0 };
};
type Appel = { banc: string; args: string[]; env: NodeJS.ProcessEnv };
const faux = (appels: Appel[]): Executeur => (args, o) => {
  if (existsSync(join(o.cwd, '.git'))) {
    appels.push({ banc: o.cwd.split('/').slice(-2, -1)[0], args, env: o.env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'bras'], { cwd: o.cwd });
  }
  return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
};
const prompt = (a: Appel) => a.args[a.args.indexOf('-p') + 1];
const arg = (a: Appel, k: string) => (a.args.includes(k) ? a.args[a.args.indexOf(k) + 1] : undefined);

describe('banc court : le bras aiguillage joue cadence run (L736)', () => {
  it('piecesBanc : fichiers de bancs/<id>/pieces, sous-dossiers compris, absolus et triés ; aucun sans dossier', () => {
    const r = racine();
    expect(piecesBanc(chargerBanc(r, '1-avec'))).toEqual([join(r, 'bancs', '1-avec', 'pieces', 'classement.png'), join(r, 'bancs', '1-avec', 'pieces', 'sous', 'note.md')]);
    expect(piecesBanc(chargerBanc(r, '2-sans'))).toEqual([]);
  });

  it('banc à pièces : brief complet, réglages du hook, pièces au hook, modèle de bras.yaml ; banc sans pièce : brief de A', async () => {
    const r = racine(); const appels: Appel[] = [];
    await passage({ racine: r, ref: 'A', cand: 'cadence-run-sonnet', hebdo: false, juge: 'opus', niveau: 'mecanique', exec: faux(appels), prep: prep as never,
      maintenant: new Date('2026-11-15T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    const deA = (banc: string) => appels.filter((a) => a.banc === banc && arg(a, '--model') === 'opus');
    const duCand = (banc: string) => appels.filter((a) => a.banc === banc && arg(a, '--model') === 'sonnet');
    // Modèle déclaré gardé (avant : opus, celui du bras choisi par l'aiguillage)
    expect(duCand('1-avec')).toHaveLength(1); expect(duCand('2-sans')).toHaveLength(1);
    expect(deA('1-avec')).toHaveLength(1); expect(deA('2-sans')).toHaveLength(1);

    const [c] = duCand('1-avec');
    expect(prompt(c)).toContain('Taille fixée par le gardien : fonction.');
    expect(prompt(c)).not.toBe(prompt(deA('1-avec')[0]).replaceAll(deA('1-avec')[0].env.PWD ?? '', ''));
    expect(arg(c, '--settings')).toBeDefined();
    expect(JSON.parse(c.env.CADENCE_PIECES ?? '[]')).toEqual([join(r, 'bancs', '1-avec', 'pieces', 'classement.png'), join(r, 'bancs', '1-avec', 'pieces', 'sous', 'note.md')]);
    expect(c.env.CADENCE_BANC_RACINE).toBe(r);

    const [s] = duCand('2-sans');
    expect(prompt(s)).not.toContain('Taille fixée par le gardien');
    expect(arg(s, '--settings')).toBeUndefined();
    const sansChemin = (a: Appel) => prompt(a).replace(/\S*\/c[12]\b/g, 'CLONE');
    expect(sansChemin(s)).toBe(sansChemin(deA('2-sans')[0]));
  });
});
