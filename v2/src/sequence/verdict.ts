import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BARRE_SPEC, ligneHistorique, parisJour, type Critere, type Verdict } from '../bench/verdict.js';
import type { MesureEtape, ResultatSequence } from './passage.js';

type Maint = NonNullable<MesureEtape['maintenabilite']>;
const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const signe = (x: number) => `${x >= 0 ? '+' : ''}${+x.toFixed(1)}`;
const pieces = (e: MesureEtape) => (e.lecture ? e.lecture.ouvertes.length + e.lecture.manquantes.length + e.lecture.apres_ecriture.length : 0);

/** Barre du banc séquence (spec §4), échec fermé : une donnée absente ne rend jamais un critère vert. Tous bloquants ; avec des sorties attendues, les tests cachés sont affichés (R35, R37). */
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
  // une pièce lue en partie (offset, limit, pages) ne compte pas : « vraiment lire » (R30)
  const lu = (b: string) => ({ entieres: somme(et(b).map((e) => (e.lecture ? e.lecture.ouvertes.length - e.lecture.partielles.length : 0))),
    partielles: somme(et(b).map((e) => e.lecture?.partielles.length ?? 0)), t: somme(et(b).map(pieces)), absents: et(b).filter((e) => !e.lecture).map((e) => e.k) });
  const lus = (l: ReturnType<typeof lu>) => `${l.entieres}/${l.t}${l.partielles ? ` (${l.partielles} partiel)` : ''}`;
  const SCORE: Record<string, number> = { oui: 2, 'en partie': 1, non: 0 };
  const attendu = (b: string) => (meca(b) ? SCORE[meca(b)!.attendu] : undefined);
  const inutiles = somme(et(cand).filter((e) => !e.reponses).map((e) => e.mesure.questions));
  const ks = (b: string) => et(b).map((e) => e.k).join(',');
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
  const rc = regs(cand), rr = regs(ref), hc = meca(cand)?.caches_passes, hr = meca(ref)?.caches_passes, ac = attendu(cand), ar = attendu(ref);
  const oui = (b: string) => meca(b)?.sorties?.filter((x) => x.verdict === 'oui').length, oc = oui(cand), or = oui(ref), ns = r.sorties_attendues ?? 0, sur = (x?: number) => (x === undefined ? '–' : `${x}/${ns}`);
  const incertains = pour((b) => (meca(b)?.sorties ?? []).filter((x) => x.verdict === 'incertain').map((x) => `${b} étape ${x.k} : ${x.sortie}`)); // B2 (R38)
  const derniere = et(cand).at(-1), reglages = [...new Set([...(r.reglages_utilisateur ?? []), ...bras.flatMap((b) => et(b).flatMap((e) => e.reglages_utilisateur ?? []))])];
  const criteres: Critere[] = [
    c('au moins une étape', `${ref} [${ks(ref)}] · ${cand} [${ks(cand)}]`, '≥ 1, les mêmes étapes pour les deux bras', et(cand).length >= 1 && ks(cand) === ks(ref)),
    c('toutes les étapes mesurées', nonMesurees.length ? nonMesurees.join(' ; ') : 'toutes', 'toutes', nonMesurees.length === 0),
    c('aucune fuite', fuites.length ? fuites.join(' ; ') : '0', '0', fuites.length === 0),
    c('réglages utilisateur inchangés pendant le passage', r.reglages_utilisateur ? reglages.join(', ') || 'inchangés' : 'non mesuré', 'inchangés', Boolean(r.reglages_utilisateur) && !reglages.length), // R36
    c('aucun bras en échec', echecs.length ? echecs.join(' ; ') : '0', '0', echecs.length === 0),
    c('juge final fait', r.jugement && meca(cand) && meca(ref) ? 'oui' : 'non', 'oui', Boolean(r.jugement && meca(cand) && meca(ref))),
    c('régressions', `${n(rc)} contre ${n(rr)}`, `≤ ${ref}`, rc !== null && rr !== null && rc <= rr),
    { ...c('tests cachés cumulés', `${hc ?? '–'} contre ${hr ?? '–'}`, `≥ ${ref}`, hc !== undefined && hr !== undefined && hc >= hr), bloquant: !ns }, // R35, R37 : couplés au code d'origine
    ...(ns ? [c('sorties attendues vérifiées', incertains.length ? `non mesuré : ${incertains.join(' ; ')}` : `${sur(oc)} contre ${sur(or)}`, `≥ ${ref}`, !incertains.length && oc !== undefined && or !== undefined && oc >= or)] : []),
    c('suite du candidat au juge final', meca(cand) ? (meca(cand)!.suite_ok ? 'ok' : 'ROUGE') : 'juge absent', 'ok', meca(cand)?.suite_ok === true),
    c('attendu au juge final', `${ac ?? '–'} contre ${ar ?? '–'} (oui 2, en partie 1, non 0)`, `≥ ${ref}`, ac !== undefined && ar !== undefined && ac >= ar),
    c('questions inutiles', `${inutiles}`, '0', inutiles === 0),
    c('pièces lues avant le code', `${lus(lc)}${lc.absents.length ? `, non mesurée aux étapes ${lc.absents.join(', ')}` : ''} (${ref} : ${lus(lr)})`, '100 % en entier',
      lc.absents.length === 0 && lc.entieres === lc.t),
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

export function rapportSequence(r: ResultatSequence, ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string; repetition?: number; repetitions?: number }): string {
  const ks = [...new Set([ref, cand].flatMap((b) => (r.etapes[b] ?? []).map((x) => x.k)))].sort((a, b) => a - b);
  const bc = (f: (b: string) => string) => `${f(ref)} · ${f(cand)}`;
  const zero = `| 0 | – · – | – · – | – · – | – · – | ${bc((b) => (r.base[b] ? (r.base[b].build_ok ? 'ok' : 'ko') : '–'))} | ${bc((b) => pct(r.base[b]?.maintenabilite))} | ${bc((b) => `${r.base[b]?.maintenabilite?.fichiers_400 ?? '–'}`)} | – · – |`;
  const lignes = ks.map((k) => {
    const x = (f: (e: MesureEtape) => string) => cellule(r, ref, cand, k, f);
    return `| ${k} | ${x((m) => (m.regressions ? `${m.regressions.rouges.length}/${m.regressions.disparus.length}` : 'ERREUR'))} | ${x(affaiblis)} | ${x((m) => `${m.nouveaux?.length ?? '–'}`)} | ${x((m) => (m.lecture ? `${m.lecture.ouvertes.length}/${pieces(m)}${m.lecture.partielles.length ? ' partiel' : ''}` : '–'))} | ${x((m) => (m.build_ok === undefined ? '–' : m.build_ok ? 'ok' : 'ko'))} | ${x((m) => pct(m.maintenabilite))} | ${x((m) => `${m.maintenabilite?.fichiers_400 ?? '–'}`)} | ${x((m) => `${m.mesure.duree_s} s`)} |`;
  });
  const parEtape = (f: (b: string, m: MesureEtape) => string[]) => [ref, cand].flatMap((b) => (r.etapes[b] ?? []).flatMap((m) => f(b, m).map((l) => `- ${b} étape ${m.k} : ${l}`)));
  const lectures = parEtape((_, m) => [...m.fuites_a_verifier, ...(m.lecture?.partielles ?? []).map((p) => `pièce lue en partie, ${p}`), ...(m.lecture?.pages_inconnues ?? []).map((p) => `nombre de pages inconnu, ${p}`)]);
  const questions = parEtape((_, m) => m.mesure.questions_texte.map((q) => q.trim().replace(/\s*\n\s*/g, ' ')));
  const affaiblisListe = parEtape((_, m) => {
    const a = m.tests_affaiblis; if (!a) return [];
    const l = [...a.fichiers_supprimes.map((f) => `fichier supprimé ${f}`), ...a.tests_retires.map((f) => `test retiré ${f}`), ...a.skip_only.map((f) => `.skip/.only ajouté ${f}`)];
    return l.length ? [l.join(' ; ')] : [];
  });
  const sorties = [ref, cand].flatMap((b) => (r.jugement?.meca[b]?.sorties ?? []).filter((x) => x.verdict !== 'oui').map((x) => `- ${b} étape ${x.k} : ${x.verdict} — ${x.sortie} (${x.preuve})`));
  const remplaces = !r.jugement ? ['- juge absent'] : (r.jugement.remplaces ?? []).length ? r.jugement.remplaces!.map((t) => `- ${t}`) : ['- aucun'];
  return [`# Séquence ${r.sequence} ${e.date} — ${cand} contre ${ref} — ${v.vert ? 'VERT' : 'ROUGE'}`, '', `Empreinte de v2 : ${e.empreinte}`, `Passage : ${r.run}`, `Répétition ${e.repetition ?? 1}/${e.repetitions ?? 1}`, '',
    `| Étape | Régressions ${ref} · ${cand} (rouges/disparus) | Affaiblis ${ref} · ${cand} | Nouveaux ${ref} · ${cand} | Lecture ${ref} · ${cand} | Build ${ref} · ${cand} | Duplication ${ref} · ${cand} | Fichiers > 400 ${ref} · ${cand} | Temps ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|---|', zero, ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((x) => `| ${x.nom} | ${x.valeur} | ${x.seuil} | ${x.ok ? 'ok' : x.bloquant ? '**ROUGE**' : 'en dessous (indicatif)'} |`), '',
    ...([['Lectures à vérifier', lectures], ['Questions posées', questions], ['Tests affaiblis', affaiblisListe], ['Sorties attendues non vérifiées (non, incertain)', sorties]] as const).flatMap(([titre, l]) => (l.length ? [`## ${titre}`, '', ...l, ''] : [])),
    `## Tests remplacés (R28), non comptés pour ${ref} ni pour ${cand}`, '', ...remplaces, ''].join('\n');
}

/** Ligne `historique.jsonl` d'une séquence : `bancs` = [id de la séquence], jamais hebdo ni frais. */
export const ligneSequence = (v: Verdict, e: { date: string; empreinte: string; candidat: string; reference: string; modele_candidat: string; sequence: string; run: string; repetition: number; repetitions: number }) =>
  ligneHistorique(v, { type: 'sequence', ...e, bancs: [e.sequence], hebdo: false, frais: 0 });

/** Verdict, rapport (md et json) dans `rapports/` et ligne d'historique d'une séquence passée. */
export function conclureSequence(racine: string, r: ResultatSequence, ref: string, cand: string, e: { maintenant: Date; empreinte: string; modele_candidat: string; repetition?: number; repetitions?: number }): Verdict {
  const v = verdictSequence(r, ref, cand), repetition = e.repetition ?? 1, repetitions = e.repetitions ?? 1;
  const base = join(racine, 'rapports', `${r.run}-${r.sequence}-r${repetition}`);
  mkdirSync(join(racine, 'rapports'), { recursive: true });
  writeFileSync(`${base}.md`, rapportSequence(r, ref, cand, v, { date: parisJour(e.maintenant).jour, empreinte: e.empreinte, repetition, repetitions }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultat: r }, null, 2));
  appendFileSync(join(racine, 'historique.jsonl'), `${ligneSequence(v, { date: e.maintenant.toISOString(), empreinte: e.empreinte, candidat: cand, reference: ref, modele_candidat: e.modele_candidat, sequence: r.sequence, run: r.run, repetition, repetitions })}\n`);
  return v;
}

/** Une répétition qui n'a pas pu se terminer : ligne rouge dans l'historique (un run sans ses N lignes n'autorise jamais la publication). */
export function echecRepetition(racine: string, e: { message: string; run: string; sequence: string; repetition: number; repetitions: number; maintenant: Date; empreinte: string; candidat: string; reference: string; modele_candidat: string }): Verdict {
  const v: Verdict = { vert: false, criteres: [{ nom: `répétition non terminée : ${e.message.split('\n')[0]}`, valeur: 'interrompue', seuil: 'terminée', ok: false, bloquant: true }] };
  appendFileSync(join(racine, 'historique.jsonl'), `${ligneSequence(v, { date: e.maintenant.toISOString(), empreinte: e.empreinte, candidat: e.candidat, reference: e.reference, modele_candidat: e.modele_candidat, sequence: e.sequence, run: e.run, repetition: e.repetition, repetitions: e.repetitions })}\n`);
  return v;
}
