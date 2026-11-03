import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { tryGit } from './git.js';

/** Gabarit par défaut du message d'un commit de plan écrit dans une vague (L343 : inchangé depuis toujours). */
const PLAN_COMMIT_WAVE = 'plan: {lot} {action} (orchestrate {vague})';
/** Gabarit par défaut hors vague (`spec reseal`) : pas de vague à citer. */
const PLAN_COMMIT_PLAIN = 'plan: {lot} {action}';
/** Gabarit par défaut du commit de la fiche sourcée par la réponse du lead : type `docs`, déjà conventionnel (L343). */
const LEAD_ANSWER_COMMIT = 'docs({lot}): {action} (orchestrate {vague})';

/** Les mots que le gabarit `plan.commit` de cadence.yaml peut employer. */
const PLAN_COMMIT_FIELDS = ['lot', 'action', 'vague'] as const;

/** Ce que cadence écrit dans un commit de plan, par action : une seule source pour la vague et pour le dry-run. */
export const PLAN_ACTIONS = {
  started: 'démarré',
  hypotheses: (sujet: string) => `hypothèses de la fiche ${sujet} notées`,
  minors: (label: string) => `mineurs de la revue de ${label} notés`,
  /** `raf done` ne commite pas : l'action de la commande de commit qu'il propose (L371). */
  done: 'terminé',
  /** `raf archive` (L396) : le nombre de lots déplacés dans l'archive. */
  archived: (n: number) => `${n} lot(s) archivé(s)`,
  /** `raf plan --propose --apply` (L466) : le nombre de fenêtres posées. */
  planned: (n: number) => `${n} fenêtre(s) prévue(s) posée(s)`,
  reviewRecorded: 'revue de code enregistrée',
  /** `raf ux <lot>` ne commite pas : l'action de la commande de commit qu'il propose (L509). */
  uxRecorded: 'verdict UX enregistré',
  reviewNoted: 'revue de code notée',
  /** `cadence deliver` pendant une vague (L388) : le lot de l'article ouvert, ou ses titres ajoutés en note. */
  articleOpened: 'article à rafraîchir ouvert',
  articleNoted: 'article à rafraîchir : titres livrés notés',
  /** `spec green` (L366) : jamais la liste des tests rescellés, elle va dans le corps du commit (header-max-length de commitlint). */
  specGreen: 'acceptation verte, vert: true posé par cadence spec green',
  /** `cadence spec green` sur un lot déjà `vert: true` mais sans empreintes (L526). */
  specGreenScelle: 'empreintes de l\'acceptation posées par cadence spec green',
  /** `spec reseal` (L546) : jamais les chemins des tests, ils sont dans le commit du rescellé et en note du lot (header-max-length de commitlint). */
  resealed: 'test d\'acceptation rescellé',
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
 * Hors vague, un groupe entre parenthèses ou crochets qui porte `{vague}` disparaît avec elle, au lieu de laisser « (orchestrate ) » ou « [] ».
 */
export function planCommitMessage(template: string | undefined, v: { lot: string; action: string; wave?: string }): string {
  let t = template ?? (v.wave === undefined ? PLAN_COMMIT_PLAIN : PLAN_COMMIT_WAVE);
  if (v.wave === undefined) t = t.replace(/\s*(?:\([^()]*\{vague\}[^()]*\)|\[[^\[\]]*\{vague\}[^\[\]]*\])/g, '').replaceAll('{vague}', '');
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

/** Un mot en morceaux de `width` colonnes au plus ; une URL reste entière (commitlint l'exempte). */
const morceaux = (mot: string, width: number): string[] => (/^https?:\/\//.test(mot) ? [mot] : mot.match(new RegExp(`.{1,${width}}`, 'gu')) ?? []);

/** Un texte coupé aux espaces à `width` colonnes (le corps d'un commit : `body-max-line-length` de commitlint). */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const mot of text.split(/\s+/).filter(Boolean)) {
    for (const word of morceaux(mot, width)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
  }
  return line ? [...lines, line] : lines;
}

/**
 * Le message du commit de `spec reseal` (L546) : le sujet est court et fixe (comme `spec green`), les chemins, la raison (coupée à 90 colonnes) et la fiche amendée,
 * sans borne, vont dans le corps ; un sujet qui les portait dépassait `header-max-length` de commitlint. `livre` : l'id du lot livré rescellé par le lot `cite`.
 */
export function resealCommitMessage(o: { cite: string; livre?: string; tests: string[]; reason: string; ficheAmendee?: string }): [subject: string, body: string] {
  const subject = `test(${o.cite}): acceptation rescellée${o.livre ? ` du lot livré ${o.livre}` : ''}`;
  const body = [...o.tests.map((t) => `- ${t}`), '', ...wrap(`raison : ${o.reason.trim()}`, 90), ...(o.ficheAmendee ? ['', `fiche amendée en ${o.ficheAmendee}`] : [])].join('\n');
  return [subject, body];
}

/** Ce que dit un hook qui refuse un commit : les règles de commitlint qui refusent (`… [header-max-length]`) d'abord, la fin de la sortie sinon (« found 1 problems » seul ne dit pas laquelle). */
export function commitRefusal(e: unknown): string {
  const out = (typeof e === 'object' && e !== null ? e : { message: String(e) }) as { stderr?: string; stdout?: string; message?: string };
  const sortie = [out.stderr, out.stdout].map((t) => (t ?? '').trim()).filter(Boolean);
  // `message` (Node) répète la ligne « Command failed: git commit … -m <corps> » et le stderr : il ne sert que sans sortie du hook.
  const lines = (sortie.length ? sortie : [(out.message ?? '').trim()]).join('\n').split('\n');
  const rules = lines.filter((l) => /\[[a-z][a-z0-9-]*\]\s*$/.test(l)).map((l) => l.replace(/^[✖✗⚠\s]+/, '').trim());
  return (rules.length ? rules : lines.slice(-5)).join(' | ').trim() || 'le hook de commit a refusé, sans rien dire';
}
