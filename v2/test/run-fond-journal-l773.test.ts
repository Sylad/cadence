import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdRun } from '../src/run/cli.js';
import { purger } from '../src/run/purger.js';
import { executerRun, nouvelIdRun, type Etat } from '../src/run/run.js';
import { attendre, depot, etats, fauxClaude, git } from './run-outils.js';
import { dossierTemp } from './temp.js';

// L773 (issue #64 du compte pro) : deux `cadence run --fond` lancés dans la même seconde depuis le même dépôt écrivaient dans le même journal
// `fond-<AAAAMMJJHHMMSS>.log` et y mêlaient leurs lignes. Le journal porte désormais l'id du run : `fond-<id>.log`.
const FOND = join(import.meta.dirname, 'fond');
const PLAFOND = 60_000;

/** Faux claude : commite un fichier propre à son worktree (deux runs ne se gênent pas à l'intégration) et rend l'id de --session-id. */
function fauxClaudeUnique(): string {
  const bin = join(dossierTemp('fond-l773-bin-'), 'claude');
  writeFileSync(bin, `#!/bin/bash
sid=; prec=; for a in "$@"; do [ "$prec" = --session-id ] && sid=$a; prec=$a; done
# le second attend que le premier soit intégré : deux intégrations simultanées dans un même arbre principal sont hors du sujet de ce test
case "$*" in *second*) for i in $(seq 300); do git -C "$(dirname "$PWD")/../projet" log --format=%s | grep -q '^ajoute fait-' && break; sleep 0.1; done; sleep 1;; esac
f="fait-$(basename "$PWD").txt"; echo ok > "$f"; git add -A; git -c user.email=t@t -c user.name=t commit -qm "ajoute $f"
printf '{"session_id":"%s","total_cost_usd":0,"result":"=== FINI ===\\\\nfini","subtype":"success"}' "$sid"
`);
  chmodSync(bin, 0o755);
  return dirname(bin);
}

/** Lance un `cadence run --fond` dans un vrai processus ; rend sa sortie quand le lanceur a rendu la main. */
const lancer = (repo: string, bin: string, demande: string) => new Promise<string>((fini) => {
  const p = spawn(process.execPath, ['--import', join(FOND, 'ts.mjs'), join(FOND, 'cadence.mjs'), 'run', demande, '--fond'],
    { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  let s = ''; p.stdout.on('data', (d) => { s += d; }); p.stderr.on('data', (d) => { s += d; }); p.on('exit', () => fini(s));
});

describe('un journal par run --fond, nommé d\'après l\'id du run (L773, issue #64)', { timeout: 4 * PLAFOND }, () => {
  it('deux runs --fond lancés dans la même seconde : deux journaux distincts, chacun cité par son run, retrouvés par --liste et --purger', async () => {
    const bin = fauxClaudeUnique();
    let repo = '', sorties: string[] = [];
    for (let essai = 0; essai < 5; essai++) { // les deux lancements doivent tomber dans la même seconde, le cas de l'issue
      repo = depot('ls fait-*');
      sorties = await Promise.all([lancer(repo, bin, 'Crée le premier'), lancer(repo, bin, 'Crée le second')]);
      const ids = sorties.map((s) => /cadence run (\S+) lancé en arrière-plan/.exec(s)?.[1]);
      if (ids.every(Boolean) && ids[0]!.slice(0, 14) === ids[1]!.slice(0, 14)) break;
    }
    const lances = sorties.map((s) => { const m = /cadence run (\S+) lancé en arrière-plan ; journal : (\S+) ;/.exec(s); expect(m, s).toBeTruthy(); return { id: m![1], journal: m![2] }; });
    expect(lances[0].id.slice(0, 14)).toBe(lances[1].id.slice(0, 14)); // même seconde
    expect(lances[0].id).not.toBe(lances[1].id);
    for (const l of lances) expect(basename(l.journal)).toBe(`fond-${l.id}.log`);

    const finis = await attendre(() => { const x = etats(repo); return x.length === 2 && x.every((e) => e.etat !== 'en-cours') ? x : undefined; }, PLAFOND, 'les deux runs n\'ont pas fini');
    for (const l of lances) {
      const e = finis.find((x) => x.id === l.id)!;
      expect(e, `aucun état pour ${l.id}`).toBeTruthy();
      expect(e.journal).toBe(l.journal);
      expect(e.etat, e.detail).toBe('integre');
      const autre = lances.find((x) => x !== l)!, texte = readFileSync(l.journal, 'utf8');
      expect(texte).toContain(`cadence run ${l.id} : integre`); // sa propre ligne de fin
      expect(texte).not.toContain(autre.id); // rien de l'autre run
    }
    const journaux = readdirSync(join(dirname(repo), '.cadence-run')).filter((f) => f.startsWith('fond-'));
    expect(journaux.sort()).toEqual(lances.map((l) => `fond-${l.id}.log`).sort());

    const sortie: string[] = [], io = { cwd: repo, env: {}, now: () => new Date(), out: (x: string) => sortie.push(x), err: (x: string) => sortie.push(x) };
    expect(await cmdRun(['--liste'], io)).toBe(0);
    for (const l of lances) expect(sortie.join('\n')).toMatch(new RegExp(`^${l.id}  integre`, 'm'));

    // --purger retire chaque journal avec son run, et lui seul
    const l: string[] = [];
    purger(git(repo, 'rev-parse', '--show-toplevel'), join(dirname(repo), '.cadence-run'), { dryRun: true, out: (x) => l.push(x), maintenant: () => new Date(Date.now() + 30 * 86_400_000) });
    for (const x of lances) {
      const ligne = l.find((y) => y.includes(x.id))!;
      expect(ligne, l.join('\n')).toContain(`fond-${x.id}.log`);
      expect(ligne).not.toContain(`fond-${lances.find((y) => y !== x)!.id}.log`);
    }
    expect(existsSync(lances[0].journal) && existsSync(lances[1].journal)).toBe(true); // --dry-run ne retire rien
  });
});

describe('l\'id du run (L773)', () => {
  it('deux processus dans la même seconde ont deux ids', () => {
    const t = new Date('2026-11-18T08:33:29.123Z');
    expect(nouvelIdRun(100, t)).toBe('20261118083329-100');
    expect(nouvelIdRun(100, t)).not.toBe(nouvelIdRun(101, t));
  });

  it('executerRun prend l\'id que le lanceur --fond a choisi, et refuse un id mal formé avant de créer quoi que ce soit', () => {
    const repo = depot(), exec = fauxClaude([(cwd) => { writeFileSync(join(cwd, 'fait.txt'), 'ok'); git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fait'); }]);
    const e: Etat = executerRun({ id: '20261118083329-4242', repo, demande: 'Crée fait.txt', exec, out: () => {}, attendre: null });
    expect(e.id).toBe('20261118083329-4242');
    expect(basename(e.fichier)).toBe('projet-20261118083329-4242.json');
    expect(e.etat).toBe('integre');
    const repo2 = depot();
    expect(() => executerRun({ id: '../x', repo: repo2, demande: 'Crée fait.txt', exec, out: () => {}, attendre: null })).toThrow(/id de run mal formé/);
    expect(existsSync(join(dirname(repo2), '.cadence-run'))).toBe(false);
  });
});
