import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cheminsCites, classer, contournement, dossierTranscripts, textes, zonesCertaines } from '../../hooks/lecture.mjs';

export interface Regles { autorises: string[]; certains: string[]; runs: string }
export interface Fuites { certaines: string[]; a_verifier: string[] } // R21 : à vérifier = le reste de runs (ancêtres du clone, globs d'ancêtres)

export { dossierTranscripts };

export function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles {
  return {
    autorises: [clone, `${clone}.captures`, `${clone}.question.md`, `${clone}.install.log`, `${clone}.tests-base.log`, join(racine, 'bancs', banc), dossierTranscripts(home, clone)],
    certains: zonesCertaines(home, racine), runs: join(racine, 'runs'),
  };
}

/** L775 : ids des appels qu'un hook PreToolUse a refusés (tool_result en erreur « PreToolUse:<outil> hook error ») : l'outil n'a pas tourné.
 * Un Bash en erreur par son code de sortie a tourné et n'en fait pas partie. */
export function refusParHook(lignes: string[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lignes) {
    if (!l.includes('hook error')) continue;
    let d: { message?: { content?: unknown } };
    try { d = JSON.parse(l); } catch { continue; }
    const c = d.message?.content;
    for (const x of Array.isArray(c) ? c : []) {
      const t = x as { type?: string; tool_use_id?: unknown; is_error?: boolean; content?: unknown };
      if (t.type === 'tool_result' && t.is_error === true && typeof t.tool_use_id === 'string' && [...textes(t.content)].some((s) => /^PreToolUse:\w+ hook error/.test(s))) ids.add(t.tool_use_id);
    }
  }
  return ids;
}

export function chercherFuites(lignes: string[], r: Regles, home: string, cwd = ''): Fuites {
  const vus = { certaines: new Set<string>(), a_verifier: new Set<string>() };
  // L775 : un appel refusé par le hook du bras n'a rien lu ni écrit (banc du 18-11 : `npx vite > ../../c2.vite.log` refusé, fichier jamais créé,
  // compté en fuite). Seule la tentative de contournement (R32) reste comptée.
  const refuses = refusParHook(lignes);
  const depart = cwd || r.autorises[0];
  for (const l of lignes) {
    let d: { type?: string; cwd?: string; message?: { content?: { type: string; id?: string; name?: string; input?: unknown }[] } };
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      if (contournement(c.name ?? '', c.input, home)) vus.certaines.add(`contournement : ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`); // R32
      if (c.id && refuses.has(c.id)) continue;
      for (const p of cheminsCites(c.name ?? '', c.input, d.cwd, depart, home, r.certains)) { const k = classer(p, r); if (k) vus[k.classe === 'certaine' ? 'certaines' : 'a_verifier'].add(k.chemin); } // L808 : règle partagée avec le hook
    }
  }
  return { certaines: [...vus.certaines], a_verifier: [...vus.a_verifier] };
}

export const jsonl = (dir: string): string[] => (!existsSync(dir) ? [] : readdirSync(dir).flatMap((e) => {
  const p = join(dir, e); return statSync(p).isDirectory() ? jsonl(p) : p.endsWith('.jsonl') ? [p] : []; }));

/**
 * L798 (banc du 20-11 11:11 : le bras A écrit `../c2.tsc.txt`, à côté de son propre clone ; le passage était rouge pour la référence) : une fuite
 * certaine de la RÉFÉRENCE est sans effet possible sur le candidat quand son chemin est un fichier du dossier du banc (`runs/<passage>/<banc>/…`, sans
 * glob), hors du clone du candidat et de ses fichiers voisins (`c1`, `c1/…`, `c1.captures`, `c1.question.md`, ses journaux). Ne juge que le chemin :
 * l'ordre des bras est jugé par `trierFuitesReference`. Toute autre fuite de la référence (secrets, bancs, projets, autre banc, contournement, glob) bloque.
 */
export function fuiteSansEffet(chemin: string, dossierBanc: string, cloneCandidat: string): boolean {
  if (/[*?[]/.test(chemin) || !chemin.startsWith(`${dossierBanc}/`)) return false;
  const cand = cloneCandidat.slice(dossierBanc.length + 1), premier = chemin.slice(dossierBanc.length + 1).split('/')[0];
  return premier !== '' && premier !== cand && !premier.startsWith(`${cand}.`);
}

/** L798 : fuites certaines de la référence, bloquantes ou sans effet (`fuiteSansEffet`) ; si elle n'a pas joué après le candidat (`refApres`), tout bloque
 * (revue r1 : jouée avant, son écriture dans le dossier du banc était lisible par le candidat, par `cat ../*.txt` ou `grep -r ..`). */
export function trierFuitesReference(certaines: string[], dossierBanc: string, cloneCandidat: string, refApres: boolean): { bloquantes: string[]; signalees: string[] } {
  const signalees = refApres ? certaines.filter((p) => fuiteSansEffet(p, dossierBanc, cloneCandidat)) : [];
  return { bloquantes: certaines.filter((p) => !signalees.includes(p)), signalees };
}

export function fuitesDuBras(home: string, racine: string, banc: string, clone: string): Fuites {
  const lignes = jsonl(dossierTranscripts(home, clone)).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
  return chercherFuites(lignes, reglesDuBras(home, racine, banc, clone), home, clone);
}
