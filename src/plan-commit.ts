import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { tryGit } from './git.js';

/** Gabarit par défaut du message d'un commit de plan écrit dans une vague (L343 : inchangé depuis toujours). */
export const PLAN_COMMIT_WAVE = 'plan: {lot} {action} (orchestrate {vague})';
/** Gabarit par défaut hors vague (`spec reseal`) : pas de vague à citer. */
export const PLAN_COMMIT_PLAIN = 'plan: {lot} {action}';
/** Gabarit par défaut du commit de la fiche sourcée par la réponse du lead : type `docs`, déjà conventionnel (L343). */
export const LEAD_ANSWER_COMMIT = 'docs({lot}): {action} (orchestrate {vague})';

/** Les mots que le gabarit `plan.commit` de cadence.yaml peut employer. */
export const PLAN_COMMIT_FIELDS = ['lot', 'action', 'vague'] as const;

/** Ce que cadence écrit dans un commit de plan, par action : une seule source pour la vague et pour le dry-run. */
export const PLAN_ACTIONS = {
  started: 'démarré',
  hypotheses: (sujet: string) => `hypothèses de la fiche ${sujet} notées`,
  minors: (label: string) => `mineurs de la revue de ${label} notés`,
  reviewRecorded: 'revue de code enregistrée',
  reviewNoted: 'revue de code notée',
  /** `spec green` (L366) : jamais la liste des tests rescellés, elle va dans le corps du commit (header-max-length de commitlint). */
  specGreen: 'acceptation verte, vert: true posé par cadence spec green',
  resealed: (norm: string) => `test d'acceptation rescellé (${norm})`,
  /** En minuscule : `subject-case` de config-conventional refuse une majuscule initiale (L343). */
  leadAnswer: (ids: string[]) => `${ids.length > 1 ? 'règles' : 'règle'} ${ids.join(', ')} ${ids.length > 1 ? 'sourcées' : 'sourcée'} par la réponse du lead`,
};

/** Le message du commit de la fiche sourcée par la réponse du lead : le gabarit `plan.commit` du projet comme tout commit écrit par cadence, à défaut `docs(<lot>): …` (L343). */
export function leadAnswerMessage(template: string | undefined, lot: string, ids: string[], wave: string): string {
  return planCommitMessage(template ?? LEAD_ANSWER_COMMIT, { lot, action: PLAN_ACTIONS.leadAnswer(ids), wave });
}

/** Valide le gabarit `plan.commit` ; rend la raison du refus, null s'il est bon. */
export function planCommitProblem(template: string): string | null {
  if (template.trim() === '') return 'est vide';
  if (/[\r\n]/.test(template)) return 'doit tenir sur une ligne';
  if (!template.includes('{lot}')) return 'doit contenir {lot} (le commit doit citer son lot)';
  for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
    if (!(PLAN_COMMIT_FIELDS as readonly string[]).includes(m[1])) return `{${m[1]}} inconnu (attendu : ${PLAN_COMMIT_FIELDS.map((f) => `{${f}}`).join(', ')})`;
  }
  return null;
}

/**
 * Le message d'un commit de plan : le gabarit du projet (`plan.commit`), à défaut celui d'avant L343.
 * Hors vague, un groupe entre parenthèses qui porte `{vague}` disparaît avec elle, au lieu de laisser « (orchestrate ) ».
 */
export function planCommitMessage(template: string | undefined, v: { lot: string; action: string; wave?: string }): string {
  let t = template ?? (v.wave === undefined ? PLAN_COMMIT_PLAIN : PLAN_COMMIT_WAVE);
  if (v.wave === undefined) t = t.replace(/\s*\([^()]*\{vague\}[^()]*\)/g, '').replaceAll('{vague}', '');
  return t.replaceAll('{lot}', () => v.lot).replaceAll('{vague}', () => v.wave ?? '').replaceAll('{action}', () => v.action);
}

/** Le hook commit-msg que git lancerait dans `root` (core.hooksPath compris, husky aussi) ; null s'il n'y en a pas d'exécutable. */
export function commitMsgHook(root: string): string | null {
  const rel = tryGit(root, ['rev-parse', '--git-path', 'hooks/commit-msg'])?.trim();
  if (!rel) return null;
  const path = isAbsolute(rel) ? rel : resolve(root, rel);
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

/** Passe `message` au hook commit-msg réel de `root`. Null : accepté, ou aucun hook ; sinon ce que le hook a dit en refusant. */
export function commitMsgRefusal(root: string, message: string): string | null {
  const hook = commitMsgHook(root);
  if (!hook) return null;
  const dir = mkdtempSync(join(tmpdir(), 'cadence-commitmsg-'));
  try {
    const file = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, `${message}\n`);
    const r = spawnSync(hook, [file], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (r.status === 0 && !r.error) return null;
    const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
    const said = lines.filter((l) => l.includes('✖'));
    return (said.length ? said.slice(0, 3) : lines.slice(-2)).join(' | ') || (r.error ? r.error.message : `code ${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
