import { spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inscrireCreneau, prendreVerrou, rendreVerrou, roleVerrou } from '../v2/src/verrou.js';
import { tempDir } from './helpers.js';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { COLLECTOR: string };

// L687 (D-1) : la bande montre les cadence run et leur état. Le collecteur Python joué pour de vrai sur des états écrits au format de v2/src/run/run.ts
// (`<parent du dépôt>/.cadence-run/<dépôt>-<id>.json`), avec le verrou et l'inscription posés par les vraies fonctions de v2/src/verrou.ts :
// un champ renommé d'un côté rougit ce test.

const verrous: string[] = [];
afterEach(() => {
  for (const v of verrous.splice(0)) rendreVerrou(v);
});

type Shown = { id: string; repo: string; lot: string | null; etat: string; role: string | null; titre: string; modele?: string; cout?: number; reprise?: string | null };

function etat(dir: string, id: string, champs: Record<string, unknown>, ageMs = 0): string {
  const fichier = join(dir, `proj-${id}.json`);
  writeFileSync(fichier, JSON.stringify({ id, repo: join(dir, '..', 'proj'), branche: `cadence/run-${id}`, etat: 'en-cours', demande: `L1 — run ${id}\nla suite`, debut: '2026-11-13T08:00:00.000Z', cout_usd: 0.5, modele: 'opus', detail: '', ...champs }, null, 1));
  if (ageMs) utimesSync(fichier, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return fichier;
}

it('L687 R1 — le collecteur rend les runs à montrer avec leur état : vivant (session, attente du quota), interrompu, fini récent ; pas un intégré de plus de 30 min ni un run de plus de 12 h', () => {
  const root = tempDir(), home = join(root, 'home'), parent = join(root, 'dev'), dir = join(parent, '.cadence-run'), cwd = join(parent, 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const before = process.env.CADENCE_HOME;
  process.env.CADENCE_HOME = home;
  try {
    // vivant, en session : le verrou de ce processus, inscrit au registre des créneaux comme run.ts le fait
    const joue = etat(dir, 'joue', { lot: 'L687' });
    expect(prendreVerrou(joue.replace(/\.json$/, '.verrou'), 'session')).toBeNull();
    verrous.push(joue.replace(/\.json$/, '.verrou'));
    const retirer = inscrireCreneau({ id: 'joue', repo: join(parent, 'proj'), fichier: joue });
    // vivant, il attend le quota : état quota, verrou au rôle attente
    const attend = etat(dir, 'attend', { etat: 'quota', quota: { limite: 'hebdo', reprise: '2026-11-13T12:05:00.000Z', texte: 'limit' } });
    // un seul processus de test : le second verrou porte le même pid, ce qui suffit au collecteur (porteur vivant)
    writeFileSync(attend.replace(/\.json$/, '.verrou'), JSON.stringify({ pid: process.pid, role: 'session', depuis: new Date().toISOString() }));
    roleVerrou(attend.replace(/\.json$/, '.verrou'), 'attente');
    verrous.push(attend.replace(/\.json$/, '.verrou'));
    etat(dir, 'mort', {}); // en-cours sur disque, aucun porteur : interrompu
    etat(dir, 'integre-frais', { etat: 'integre' }, 10 * 60_000);
    etat(dir, 'integre-vieux', { etat: 'integre' }, 40 * 60_000);
    etat(dir, 'rouge', { etat: 'porte-rouge' }, 2 * 3600_000);
    etat(dir, 'oublie', { etat: 'echec' }, 13 * 3600_000);
    writeFileSync(join(dir, 'illisible.json'), '{');
    try {
      const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } });
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(run.stdout) as { runs: { id: string }[]; shownRuns: Shown[] };
      // le créneau (L710) ne compte que le run inscrit qui joue
      expect(out.runs.map(r => r.id)).toEqual(['joue']);
      const byId = Object.fromEntries(out.shownRuns.map(r => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual(['attend', 'integre-frais', 'joue', 'mort', 'rouge']);
      // les vivants d'abord
      expect(out.shownRuns.slice(0, 2).map(r => r.id).sort()).toEqual(['attend', 'joue']);
      expect(byId.joue).toMatchObject({ etat: 'en-cours', role: 'session', lot: 'L687', modele: 'opus', cout: 0.5, titre: 'L1 — run joue' });
      expect(byId.attend).toMatchObject({ etat: 'quota', role: 'attente', reprise: '2026-11-13T12:05:00.000Z' });
      expect(byId.mort).toMatchObject({ etat: 'interrompu', role: null });
      expect(byId.rouge).toMatchObject({ etat: 'porte-rouge', role: null });
    } finally {
      retirer();
    }
  } finally {
    process.env.CADENCE_HOME = before;
    if (before === undefined) delete process.env.CADENCE_HOME;
  }
});
