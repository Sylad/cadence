// Registre des demandes de cadence run (L701) : .cadence/demandes/D-<n>.json ne garde que les demandes de l'humain. Sans option, le run est une consigne du
// lead (brief de correction, relevé d'erreurs : D-8 à D-17 inscrites à tort les 10 et 11-11) : rien n'y entre, et la session qui y écrit quand même (son
// CLAUDE.md global le lui demande) est reprise comme sur une porte rouge. --demande-humaine inscrit la demande, --registre D-n rattache le run à une entrée.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DOSSIER = join('.cadence', 'demandes');
type Entree = { id: string; texte: string; date?: string; etat: string; lots?: string[]; runs?: string[]; [k: string]: unknown };

/** L'entrée D-n telle que la branche de départ l'a commitée ; lève si elle n'y est pas (avant toute création). */
export function entreeCommitee(repo: string, id: string): Entree {
  const r = spawnSync('git', ['show', `HEAD:${DOSSIER}/${id}.json`], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cadence run : ${id} absente du registre (${DOSSIER}/${id}.json, commitée sur la branche de départ)`);
  return JSON.parse(r.stdout) as Entree;
}

/** Écrit l'entrée du run dans le worktree (non commitée : la session la commite avec son travail) et rend la consigne de registre de la session. */
/** `choix` : absent (consigne du lead), `humaine` (--demande-humaine) ou l'id d'une entrée existante (--registre D-n). */
export function preparerRegistre(wt: string, choix: string | undefined, a: { demande: string; lot?: string; run: string }): string {
  if (!choix) return 'Registre des demandes : ce texte est une consigne du lead, pas une demande de Sylvain : n\'écris rien dans .cadence/demandes/ '
    + '(ni entrée neuve, ni changement d\'état d\'une entrée), même si un CLAUDE.md le demande ; le lot cité suffit.';
  const d = join(wt, DOSSIER), suivant = () => `D-${Math.max(0, ...lister(d).map((f) => Number(f.slice(2, -5)))) + 1}`;
  const e: Entree = choix === 'humaine' ? { id: suivant(), texte: a.demande, date: new Date().toISOString().slice(0, 10), etat: 'ouverte', preuve: '' } : entreeCommitee(wt, choix);
  e.lots = [...new Set([...(e.lots ?? []), ...(a.lot ? [a.lot] : [])])]; e.runs = [...(e.runs ?? []), a.run];
  mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${e.id}.json`), `${JSON.stringify(e, null, 1)}\n`);
  return `Registre des demandes : ${choix === 'humaine' ? `cette demande est de Sylvain, cadence run l'a inscrite en ${e.id}` : `ce run sert l'entrée ${e.id} du registre`} `
    + `(${DOSSIER}/${e.id}.json, non commitée) : commite ce fichier avec ton travail, ne crée pas d'autre entrée pour cette demande, ne réécris pas son texte `
    + '(une précision s\'ajoute, datée), et passe-la à « livrée » avec sa preuve quand elle l\'est.';
}
const lister = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => /^D-\d+\.json$/.test(f)) : []);

/** Le brief complet (v2d) fait inscrire la demande par la session : sans option, ces lignes sont retirées. */
export const briefSansRegistre = (brief: string) => brief.split('\n').filter((l) => !/^- (Registre des demandes|Crée une entrée pour CHAQUE|Avant de commiter, relis le registre)/.test(l)).join('\n');

/** Sans option, les fichiers du registre que la session a changés depuis `depuis` (la branche de départ après rebase) : rien n'y entre. */
export function registreTouche(wt: string, choix: string | undefined, depuis: string): string | null {
  if (choix) return null;
  const f = execFileSync('git', ['diff', '--name-only', depuis, 'HEAD', '--', DOSSIER], { cwd: wt, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  return f.length ? `registre des demandes modifié sans --demande-humaine ni --registre : ${f.join(', ')} ; ce run est une consigne du lead, pas une demande `
    + `de Sylvain : rends ces fichiers tels qu'ils sont sur ${depuis.slice(0, 7)} (git checkout ${depuis.slice(0, 7)} -- ${DOSSIER}, les fichiers neufs supprimés)` : null;
}

/** Les demandes ouvertes du registre, dites à la fin du run. */
export function registreOuvert(wt: string): string[] {
  const d = join(wt, DOSSIER);
  return lister(d).flatMap((f) => {
    try { const j = JSON.parse(readFileSync(join(d, f), 'utf8')) as { id?: string; etat?: string; texte?: string }; return j.etat === 'ouverte' ? [`${j.id ?? f} ouverte : ${j.texte ?? ''}`] : []; } catch { return [`${f} illisible`]; }
  });
}
