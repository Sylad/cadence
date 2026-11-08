import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BARRE_SPEC, ligneHistorique, parisJour, type Critere, type Verdict } from '../bench/verdict.js';
import type { MesureEtape, ResultatSequence } from './passage.js';

type Maint = NonNullable<MesureEtape['maintenabilite']>;
const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const signe = (x: number) => `${x >= 0 ? '+' : ''}${+x.toFixed(1)}`;
const pieces = (e: MesureEtape) => (e.lecture ? e.lecture.ouvertes.length + e.lecture.manquantes.length + e.lecture.apres_ecriture.length : 0);

/** Barre du banc séquence (spec §4), échec fermé : une donnée absente ne rend jamais un critère vert. Tous les critères sont bloquants. */
export function verdictSequence(r: ResultatSequence, ref: string, cand: string): Verdict {
  const bras = [ref, cand];
  const et = (b: string) => r.etapes[b] ?? [];
  const pour = (f: (b: string) => string[]) => bras.flatMap(f);
  const nonMesurees = pour((b) => et(b).filter((e) => e.mesure_en_erreur || !e.regressions || !e.lecture || e.build_ok === undefined || !e.maintenabilite)
    .map((e) => `${b} étape ${e.k} : ${e.mesure_en_erreur ?? e.suite_en_erreur ?? 'mesure absente'}`));
  const fuites = pour((b) => et(b).flatMap((e) => e.fuites.map((p) => `${b} étape ${e.k} : ${p}`)));
  const echecs = pour((b) => et(b).flatMap((e) => (e.mesure.echec ? [`${b} étape ${e.k} : ${e.mesure.echec}`] : [])));
  // une étape sans `regressions` (suite ou mesure en erreur) rend le compte du bras inconnu, dernière étape comprise
  const regs = (b: string) => (et(b).length && et(b).every((e) => e.regressions) ? somme(et(b).map((e) => e.regressions!.rouges.length + e.regressions!.disparus.length)) : null);
  const meca = (b: string) => r.jugement?.meca[b];
  const remplaces = (b: string) => [...(meca(b)?.remplaces ?? [])].sort().join('\n');
  const lu = (b: string) => ({ o: somme(et(b).map((e) => e.lecture?.ouvertes.length ?? 0)), t: somme(et(b).map(pieces)), absents: et(b).filter((e) => !e.lecture).map((e) => e.k) });
  const lc = lu(cand), lr = lu(ref);
  const pente = (b: string, f: (m: Maint) => number | null) => {
    const a = r.base[b]?.maintenabilite, z = et(b).at(-1)?.maintenabilite;
    const x = a && f(a), y = z && f(z);
    return typeof x === 'number' && typeof y === 'number' ? y - x : null;
  };
  const penteCritere = (nom: string, f: (m: Maint) => number | null, unite: string): Critere => {
    const pc = pente(cand, f), pr = pente(ref, f);
    return pc === null || pr === null ? c(nom, 'non mesuré', `≤ ${ref}`, false) : c(nom, `${signe(pc)}${unite} contre ${signe(pr)}${unite}`, `≤ ${ref}`, pc <= pr);
  };
  const t = (b: string) => somme(et(b).map((e) => e.mesure.duree_s));
  const n = (x: number | null) => (x === null ? 'non mesuré' : `${x}`);
  const c = (nom: string, valeur: string, seuil: string, ok: boolean): Critere => ({ nom, valeur, seuil, ok, bloquant: true });
  const rc = regs(cand), rr = regs(ref), hc = meca(cand)?.caches_passes, hr = meca(ref)?.caches_passes;
  const derniere = et(cand).at(-1);
  const criteres: Critere[] = [
    c('au moins une étape', `${ref} ${et(ref).length} · ${cand} ${et(cand).length}`, '≥ 1, autant pour les deux bras', et(cand).length >= 1 && et(cand).length === et(ref).length),
    c('toutes les étapes mesurées', nonMesurees.length ? nonMesurees.join(' ; ') : 'toutes', 'toutes', nonMesurees.length === 0),
    c('aucune fuite', fuites.length ? fuites.join(' ; ') : '0', '0', fuites.length === 0),
    c('aucun bras en échec', echecs.length ? echecs.join(' ; ') : '0', '0', echecs.length === 0),
    c('juge final fait', r.jugement && meca(cand) && meca(ref) ? 'oui' : 'non', 'oui', Boolean(r.jugement && meca(cand) && meca(ref))),
    c('régressions', `${n(rc)} contre ${n(rr)}`, `≤ ${ref}`, rc !== null && rr !== null && rc <= rr),
    c('tests cachés cumulés', `${hc ?? '–'} contre ${hr ?? '–'}`, `≥ ${ref}`, hc !== undefined && hr !== undefined && hc >= hr),
    c('tests remplacés symétriques', r.jugement ? `${meca(cand)?.remplaces.length ?? '–'} contre ${meca(ref)?.remplaces.length ?? '–'}` : 'juge absent', 'mêmes tests',
      Boolean(meca(cand) && meca(ref)) && remplaces(cand) === remplaces(ref)),
    c('pièces lues avant le code', `${lc.o}/${lc.t}${lc.absents.length ? `, non mesurée aux étapes ${lc.absents.join(', ')}` : ''} (${ref} : ${lr.o}/${lr.t})`, '100 %',
      lc.absents.length === 0 && lc.o === lc.t),
    penteCritere('pente de duplication', (m) => m.duplication_pct, ' point'),
    penteCritere('pente des fichiers > 400 lignes', (m) => m.fichiers_400, ''),
    c('temps total', `${t(cand)} s contre ${t(ref)} s`, `≤ ${BARRE_SPEC.temps_max} × ${ref}`, t(cand) <= BARRE_SPEC.temps_max * t(ref)),
    c('build à la dernière étape', `${et(ref).at(-1)?.build_ok ? 'ok' : 'ko'} · ${derniere?.build_ok ? 'ok' : 'ko'}`, 'ok', derniere?.build_ok === true),
  ];
  return { vert: criteres.every((x) => x.ok || !x.bloquant), criteres };
}

/** Une cellule « ref · cand » d'une étape (étape absente : –). */
function cellule(r: ResultatSequence, ref: string, cand: string, k: number, f: (e: MesureEtape) => string): string {
  return [ref, cand].map((b) => { const e = (r.etapes[b] ?? []).find((x) => x.k === k); return e ? f(e) : '–'; }).join(' · ');
}
const pct = (m?: Maint) => (m ? (m.duplication_pct === null ? 'n.m.' : `${+m.duplication_pct.toFixed(1)} %`) : '–');
const affaiblis = (e: MesureEtape) => (e.tests_affaiblis ? `${somme(Object.values(e.tests_affaiblis).map((l) => l.length))}` : '–');

export function rapportSequence(r: ResultatSequence, ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string }): string {
  const ks = [...new Set([ref, cand].flatMap((b) => (r.etapes[b] ?? []).map((x) => x.k)))].sort((a, b) => a - b);
  const bc = (f: (b: string) => string) => `${f(ref)} · ${f(cand)}`;
  const zero = `| 0 | – · – | – · – | – · – | – · – | ${bc((b) => (r.base[b] ? (r.base[b].build_ok ? 'ok' : 'ko') : '–'))} | ${bc((b) => pct(r.base[b]?.maintenabilite))} | ${bc((b) => `${r.base[b]?.maintenabilite?.fichiers_400 ?? '–'}`)} | – · – |`;
  const lignes = ks.map((k) => {
    const x = (f: (e: MesureEtape) => string) => cellule(r, ref, cand, k, f);
    return `| ${k} | ${x((m) => (m.regressions ? `${m.regressions.rouges.length}/${m.regressions.disparus.length}` : 'ERREUR'))} | ${x(affaiblis)} | ${x((m) => `${m.nouveaux?.length ?? '–'}`)} | ${x((m) => (m.lecture ? `${m.lecture.ouvertes.length}/${pieces(m)}${m.lecture.partielles.length ? ' partiel' : ''}` : '–'))} | ${x((m) => (m.build_ok === undefined ? '–' : m.build_ok ? 'ok' : 'ko'))} | ${x((m) => pct(m.maintenabilite))} | ${x((m) => `${m.maintenabilite?.fichiers_400 ?? '–'}`)} | ${x((m) => `${m.mesure.duree_s} s`)} |`;
  });
  const parEtape = (f: (b: string, m: MesureEtape) => string[]) => [ref, cand].flatMap((b) => (r.etapes[b] ?? []).flatMap((m) => f(b, m).map((l) => `- ${b} étape ${m.k} : ${l}`)));
  const lectures = parEtape((_, m) => [...m.fuites_a_verifier, ...(m.lecture?.partielles ?? []).map((p) => `pièce lue en partie, ${p}`)]);
  const questions = parEtape((_, m) => m.mesure.questions_texte.map((q) => q.trim().replace(/\s*\n\s*/g, ' ')));
  const affaiblisListe = parEtape((_, m) => {
    const a = m.tests_affaiblis; if (!a) return [];
    const l = [...a.fichiers_supprimes.map((f) => `fichier supprimé ${f}`), ...a.tests_retires.map((f) => `test retiré ${f}`), ...a.skip_only.map((f) => `.skip/.only ajouté ${f}`)];
    return l.length ? [l.join(' ; ')] : [];
  });
  const remplaces = [ref, cand].map((b) => { const m = r.jugement?.meca[b]; return `- ${b} : ${!m ? 'juge absent' : m.remplaces.length ? m.remplaces.join(' ; ') : 'aucun'}`; });
  return [`# Séquence ${r.sequence} ${e.date} — ${cand} contre ${ref} — ${v.vert ? 'VERT' : 'ROUGE'}`, '', `Empreinte de v2 : ${e.empreinte}`, `Passage : ${r.run}`, '',
    `| Étape | Régressions ${ref} · ${cand} (rouges/disparus) | Affaiblis ${ref} · ${cand} | Nouveaux ${ref} · ${cand} | Lecture ${ref} · ${cand} | Build ${ref} · ${cand} | Duplication ${ref} · ${cand} | Fichiers > 400 ${ref} · ${cand} | Temps ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|---|', zero, ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((x) => `| ${x.nom} | ${x.valeur} | ${x.seuil} | ${x.ok ? 'ok' : '**ROUGE**'} |`), '',
    ...([['Lectures à vérifier', lectures], ['Questions posées', questions], ['Tests affaiblis', affaiblisListe]] as const).flatMap(([titre, l]) => (l.length ? [`## ${titre}`, '', ...l, ''] : [])),
    '## Tests remplacés (R28)', '', ...remplaces, ''].join('\n');
}

/** Ligne `historique.jsonl` d'une séquence : `bancs` = [id de la séquence], jamais hebdo ni frais. */
export const ligneSequence = (v: Verdict, e: { date: string; empreinte: string; candidat: string; reference: string; modele_candidat: string; sequence: string }) => {
  const { sequence, ...reste } = e;
  return ligneHistorique(v, { type: 'sequence', ...reste, bancs: [sequence], hebdo: false, frais: 0 });
};

/** Verdict, rapport (md et json) dans `rapports/` et ligne d'historique d'une séquence passée. */
export function conclureSequence(racine: string, r: ResultatSequence, ref: string, cand: string, e: { maintenant: Date; empreinte: string; modele_candidat: string }): Verdict {
  const v = verdictSequence(r, ref, cand);
  const base = join(racine, 'rapports', `${r.run}-${r.sequence}`);
  mkdirSync(join(racine, 'rapports'), { recursive: true });
  writeFileSync(`${base}.md`, rapportSequence(r, ref, cand, v, { date: parisJour(e.maintenant).jour, empreinte: e.empreinte }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultat: r }, null, 2));
  appendFileSync(join(racine, 'historique.jsonl'), `${ligneSequence(v, { date: e.maintenant.toISOString(), empreinte: e.empreinte, candidat: cand, reference: ref, modele_candidat: e.modele_candidat, sequence: r.sequence })}\n`);
  return v;
}
