import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { Io } from '../cli.js';
import type { Executeur } from '../bench/bras.js';
import { MODELES, modeleRun } from './aiguillage.js';
import { etatVu, executerRun, occupantRun, repondreRun, type Etat } from './run.js';
import { heureLocale, type Quota } from './quota.js';
import { causeListe, identite, veiller } from '../trace.js';

/** D-15 : ce que --liste dit d'un run en quota ; D-18 : une reprise seule seulement si un processus vivant attend, sinon l'attente est arrêtée. */
const quotaListe = (e: Etat, q: Quota, l = `limite ${q.limite === 'hebdo' ? 'hebdo' : 'Opus'}`, p = q.reprise ? occupantRun(e.fichier) : null) => (!q.reprise ? `${l}, heure de reprise illisible : cadence run --reponse`
  : p ? `${l}, reprise seule après ${heureLocale(q.reprise)} (processus ${p.pid} en attente)` : `${l}, attente arrêtée (aucun processus n'attend ; reprise prévue ${heureLocale(q.reprise)}) : reprendre : cadence run --reponse ${e.id} "reprends"`);

export const AIDE_RUN = `  cadence run "<demande>" [--piece chemin]… [--lot L12] [--demande-humaine | --registre D-n] [--taille retouche|fonction] [--complet] [--modele ${MODELES.join('|')}] [--sans-porte] [--fond]   une demande, une session (mode complet si références), porte, intégration
  cadence run --reponse <id> "<texte>"   reprend un run en attente, en quota ou rendu, dans la même session
  cadence run --liste                    les runs du dépôt et leur état ; « interrompu » : en-cours, processus mort (L709) : --reponse reprend la même session
  cadence run --help | -h                cette aide, sans rien créer
  registre (L701) : sans --demande-humaine ni --registre D-n, la demande est une consigne du lead : rien n'est inscrit au registre (.cadence/demandes/)
           --demande-humaine l'inscrit (texte mot pour mot, D-<n> suivant) ; --registre D-n rattache le run à cette entrée existante
  --modele : le modèle de la session, opus par défaut ; sans l'option, la variable CADENCE_RUN_MODELE ; un run repris par --reponse garde le sien
  quota (D-15) : une session qui finit sur « You've hit your weekly limit · resets … » met le run en état quota ; il reprend seul la même session après l'heure dite ;
           tant que son processus attend, --reponse est refusé (kill <pid> d'abord) ; processus mort, --liste dit « attente arrêtée » : --reponse le reprend
           « You've hit your Opus limit » bascule sur fable dans la même session (jamais sur la limite hebdo, qui bloque tous les modèles)
  --fond : le run se détache (il survit à la session qui l'a lancé), son journal est dans ../.cadence-run/ ; L711 : pid, pgid, sid, ppid, cgroup du run et chaque signal reçu
  L709 : ses sessions claude ne gardent aucun lien avec la session Claude Code lanceuse (pid, socket, auth par l'hôte) ; l'id de session est dans l'état dès le lancement`;

/** `exec` : l'exécuteur de la session, pour les tests (claude par défaut). */
export async function cmdRun(a: string[], io: Io, exec?: Executeur): Promise<number> {
  const out = io.out;
  try {
    if (a.includes('--help') || a.includes('-h')) { out(`usage :\n${AIDE_RUN}`); return 0; } // issue #54 : « --help » lancé comme une demande, worktree et branche laissés
    if (a[0] === '--liste') {
      const racine = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' }).trim(), d = join(dirname(racine), '.cadence-run');
      const etats = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Etat).filter((e) => e.repo === racine) : [];
      for (const e of etats) out(`${e.id}  ${etatVu(e)}${etatVu(e) === 'interrompu' ? ` (reprendre : cadence run --reponse ${e.id} "reprends")` : ''}  ${e.demande.split('\n')[0].slice(0, 80)}${e.etat === 'quota' && e.quota ? `  · ${quotaListe(e, e.quota)}` : ''}${etatVu(e) === 'interrompu' ? causeListe(e.journal) : ''}`);
      if (!etats.length) out('aucun run'); return 0;
    }
    if (a[0] === '--veilleur') return veiller(['run', ...a.slice(1)], io.env, io.cwd, out); // L711 : le parent d'un run --fond, lancé par --fond seul
    if (a[0] === '--reponse') {
      if (!a[1] || !a[2]) { io.err('usage : cadence run --reponse <id> "<texte>"'); return 2; }
      return repondreRun(a[1], io.cwd, a.slice(2).join(' '), { out }).etat === 'integre' ? 0 : 1;
    }
    const pieces: string[] = [], mots: string[] = [], registres: string[] = []; let taille: string | undefined, lot: string | undefined, choix: string | undefined, sansPorte = false, complet = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--piece') pieces.push(a[++i]);
      else if (a[i] === '--taille') taille = a[++i];
      else if (a[i] === '--sans-porte') sansPorte = true;
      else if (a[i] === '--complet') complet = true;
      else if (a[i] === '--lot') lot = a[++i];
      else if (a[i] === '--demande-humaine') registres.push('humaine');
      else if (a[i] === '--registre') registres.push(/^D-\d+$/.test(a[++i] ?? '') ? a[i] : ''); // L701 : une seule des deux, et un id D-<n>
      else if (a[i] === '--modele') choix = a[++i] ?? '';
      else if (a[i] !== '--fond') mots.push(a[i]);
    }
    const inconnue = mots.find((m) => m.startsWith('-')); // une option mal tapée, ou une demande qui commence par « - », ne part pas en session
    if (inconnue) { io.err(`cadence run : option inconnue : ${inconnue}\nusage :\n${AIDE_RUN}`); return 2; }
    if (!mots.length || pieces.some((p) => !p) || (lot !== undefined && !lot) || registres.length > 1 || registres.includes('') || (taille && !['retouche', 'fonction'].includes(taille))) { io.err(`usage :\n${AIDE_RUN}`); return 2; }
    let modele: string; // L699 : l'option l'emporte sur la variable ; une valeur inconnue est refusée ici, avant le worktree et avant --fond
    try { modele = modeleRun(choix, io.env.CADENCE_RUN_MODELE); } catch (e) { io.err((e as Error).message); return 2; }
    if (a.includes('--fond')) { // relancé détaché, sans --fond : vécu au pro le 10-11, une session de lot morte avec celle qui l'avait lancée
      const racine = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' }).trim(), d = join(dirname(racine), '.cadence-run'); mkdirSync(d, { recursive: true });
      const journal = join(d, `fond-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.log`), fd = openSync(journal, 'a');
      spawn(process.execPath, [...process.execArgv, process.argv[1], 'run', '--veilleur', ...a.filter((x) => x !== '--fond')], { cwd: io.cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, CADENCE_RUN_JOURNAL: journal } }).unref(); // L711 : un veilleur lance le run
      out(`cadence run lancé en arrière-plan ; journal : ${journal} ; état : cadence run --liste`);
      return 0;
    }
    if (io.env.CADENCE_RUN_JOURNAL) out(identite()); // L711 : au lancement d'un run --fond, de quoi savoir au prochain arrêt inexpliqué où il vivait
    return executerRun({ repo: io.cwd, demande: mots.join(' '), pieces, taille, complet, lot, registre: registres[0], modele, exec, out, sansPorte, journal: io.env.CADENCE_RUN_JOURNAL || undefined }).etat === 'integre' ? 0 : 1;
  } catch (e) { io.err(String((e as Error).message ?? e)); return 1; }
}
