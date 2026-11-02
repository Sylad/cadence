// Installer et déplacer : init, skills, migrate (L488, sorti de cli.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gitRoot } from '../git.js';
import { installHook } from '../hook.js';
import { Plan, RafError } from '../plan.js';
import { AGENTS_DIR, installAgents, installSkills, SKILLS_DIR } from '../skills.js';
import { applyMigration, describeMigration, planMigration, unhandledError } from '../migrate.js';
import { type Ctx, type EarlyCtx } from './context.js';

/** Ajoute `line` au .gitignore de `root` s'il n'y est pas déjà (avec ou sans `/` initial ou final). Rend vrai si écrit. */
export function ensureGitignore(root: string, line: string): boolean {
  const file = join(root, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const norm = (l: string) => l.trim().replace(/^\//, '').replace(/\/$/, '');
  if (text.split('\n').some((l) => norm(l) === norm(line))) return false;
  writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
  return true;
}

/** raf init : crée le plan, le dossier des notes, le .gitignore et le hook. */
export function cmdInit(c: Ctx): number | Promise<number> {
  const { values, io, today, root, configPath, planConfig, planPath, chosen } = c;
  if (planConfig?.settings.format) throw new RafError(`plan en lecture seule : ${configPath} décrit un plan tenu par un autre outil`);
  const plan = Plan.create(planPath, values.project ?? basename(root), values.prefix ?? 'L', today);
  io.out(`plan créé : ${plan.path}`);
  if (chosen === undefined) {
    mkdirSync(join(root, '.cadence/notes'), { recursive: true });
    writeFileSync(join(root, '.cadence/notes/.gitkeep'), '');
  }
  if (ensureGitignore(root, '.playwright-mcp/')) io.out('.gitignore : .playwright-mcp/');
  if (!values['no-hook'] && gitRoot(io.cwd)) io.out(`hook : ${installHook(io.cwd).path}`);
  return 0;
}

/** cadence skills install : skills et agents dans le dossier .claude. */
export function cmdSkills(c: Ctx): number | Promise<number> {
  const { rest, values, io, root } = c;
  if (rest[0] !== 'install') throw new RafError('usage : cadence skills install [--dir .claude] [--force]');
  // --dir désigne le dossier .claude (défaut : celui du dépôt) : skills/ et agents/ dedans.
  const base = resolve(io.cwd, values.dir ?? join(root, '.claude'));
  const label = { installed: 'installé', updated: 'mis à jour', unchanged: 'inchangé' };
  const force = !!values.force;
  // Vérifier les deux avant d'écrire : un conflit d'agent ne doit pas laisser les skills à moitié installés.
  if (!force) {
    installSkills(SKILLS_DIR, join(base, 'skills'), false, true);
    installAgents(AGENTS_DIR, join(base, 'agents'), false, true);
  }
  for (const r of installSkills(SKILLS_DIR, join(base, 'skills'), force)) io.out(`${r.name} : ${label[r.status]}`);
  for (const r of installAgents(AGENTS_DIR, join(base, 'agents'), force)) io.out(`${r.name} (agent) : ${label[r.status]}`);
  io.out(base);
  return 0;
}

/** Déplacer le plan ne lit pas le plan : pas d'avertissement « ancien emplacement » (L284). */
export function cmdMigrate(c: EarlyCtx): number {
  const { rest, values, io, root } = c;
  if (rest.length > 0) throw new RafError('usage : raf migrate [--dry-run]');
  const migration = planMigration(root);
  // --dry-run décrit ce qui serait fait avant de refuser ; sans lui, un refus n'annonce rien de fait.
  if (values['dry-run'] || migration.unhandled.length === 0) for (const l of describeMigration(migration, !!values['dry-run'])) io.out(l);
  if (migration.unhandled.length > 0) throw unhandledError(migration);
  if (!values['dry-run']) applyMigration(root, migration);
  return 0;
}
