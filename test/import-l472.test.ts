import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { foreignEntries, nativeEntries, readingDiff, roundTripDiff } from '../src/plan-import.js';
import { gitRepo } from './helpers.js';

// L472 (M10) — raf import : un plan tenu dans un autre format (plan.fields) écrit en natif sans perte, et le chemin inverse.
const CONFIG = `plan:
  path: docs/plan/taches.yaml
  lots: taches
  fields:
    id: [ident]
    title: [titre]
    status: [etat]
    estimate: [effort]
    notes: [note]
    parent: [parent]
    last: [dernier]
  statuses:
    todo: [a_faire]
    doing: [code, teste]
    done: [termine]
    dropped: [abandonne]
  estimates: { S: 0.25, M: 0.5 }
`;
const SOURCE = `taches:
  - ident: AB-1
    titre: Premier lot
    etat: teste
    effort: M
    theme: infra
    prevu: { from: 2026-11-02, to: 2026-11-05 }
    sha_livre: abc1234
    note:
      - { date: 2026-11-01, text: première note }
      - { date: 2026-11-02, text: seconde note }
  - ident: AB-1/t1-fusion
    titre: Sous-lot
    parent: AB-1
    etat: termine
    effort: 0.75
    note: un seul texte
  - ident: AB-2
    titre: Autre
    etat: a_faire
    dernier: 2026-10-30T08:15:00
`;

function raf(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-04T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function project(source = SOURCE, config = CONFIG) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), config);
  mkdirSync(join(dir, 'docs/plan'), { recursive: true });
  writeFileSync(join(dir, 'docs/plan/taches.yaml'), source);
  return dir;
}
/** La bascule : cadence.yaml ne décrit plus le plan d'origine (le plan est le natif), la description reste dans un autre fichier que --config désigne pour le retour. */
function switched(dir: string, config = CONFIG) {
  writeFileSync(join(dir, 'cadence-origine.yaml'), config);
  writeFileSync(join(dir, 'cadence.yaml'), '');
  return ['--config', 'cadence-origine.yaml'];
}
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const nativeOf = (dir: string, file = 'tmp/natif.yaml') => parse(readFileSync(join(dir, file), 'utf8')) as { project: string; lots: Record<string, unknown>[] };

describe('L472 — raf import --from-config', () => {
  it('R1 — écrit chaque entrée en natif : champs mappés (états, effort en jours, notes datées), sous-lot à plat avec son parent, ordre gardé', () => {
    const dir = project();
    const r = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(0);
    const { lots } = nativeOf(dir);
    expect(lots.map((l) => l.id)).toEqual(['AB-1', 'AB-1/t1-fusion', 'AB-2']);
    expect(lots[0]).toMatchObject({ title: 'Premier lot', status: 'doing', state: 'teste', estimate: 0.5, estimate_label: 'M' });
    expect(lots[0]!.notes).toEqual([{ date: '2026-11-01', text: 'première note' }, { date: '2026-11-02', text: 'seconde note' }]);
    expect(lots[1]).toMatchObject({ parent: 'AB-1', status: 'done', state: 'termine', estimate: 0.75 });
    expect(lots[1]).not.toHaveProperty('tasks');
    expect(lots[2]).toMatchObject({ status: 'todo', state: 'a_faire', last: '2026-10-30' });
    expect(lots[2]).not.toHaveProperty('estimate');
  });
  it('R2 — les clés que le format ne mappe pas sont gardées telles quelles (thème, prévu, sha_livre), avec leur valeur', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    const first = nativeOf(dir).lots[0]!;
    expect(first.theme).toBe('infra');
    expect(first.prevu).toEqual({ from: '2026-11-02', to: '2026-11-05' });
    expect(first.sha_livre).toBe('abc1234');
  });
  it('R3 — le fichier d\'origine n\'est pas touché (même empreinte avant et après, --verify compris)', () => {
    const dir = project();
    const before = sha(join(dir, 'docs/plan/taches.yaml'));
    raf(dir, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml');
    expect(sha(join(dir, 'docs/plan/taches.yaml'))).toBe(before);
  });
  it('R4 — refuse d\'écraser un fichier existant sans --force, et de viser le fichier d\'origine même avec --force', () => {
    const dir = project();
    expect(raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml').code).toBe(0);
    const again = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/existe déjà/);
    expect(raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml', '--force').code).toBe(0);
    const same = raf(dir, 'import', '--from-config', '--out', 'docs/plan/taches.yaml', '--force');
    expect(same.code).toBe(2);
    expect(same.err).toMatch(/fichier d'origine/);
  });
  it('R5 — sans --out, le plan natif va à .cadence/raf.yaml', () => {
    const dir = project();
    expect(raf(dir, 'import', '--from-config').code).toBe(0);
    expect(existsSync(join(dir, '.cadence/raf.yaml'))).toBe(true);
  });
  it('R6 — une clé non mappée qui porte le nom d\'une clé du natif est refusée en la nommant ; --rename la garde sous un autre nom', () => {
    const source = SOURCE.replace('    theme: infra\n', '    theme: infra\n    spec: docs/x.md\n');
    const dir = project(source);
    const refused = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('AB-1');
    expect(refused.err).toContain('spec');
    expect(existsSync(join(dir, 'tmp/natif.yaml'))).toBe(false);
    const ok = raf(dir, 'import', '--from-config', '--rename', 'spec=fiche', '--out', 'tmp/natif.yaml');
    expect(ok.code).toBe(0);
    const first = nativeOf(dir).lots[0]!;
    expect(first.fiche).toBe('docs/x.md');
    expect(first).not.toHaveProperty('spec');
  });
  it('R7 — une lecture qui signale un problème (état sans correspondance) refuse l\'import, rien n\'est écrit', () => {
    const dir = project(SOURCE.replace('etat: a_faire', 'etat: inconnu'));
    const r = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/AB-2.*inconnu/);
    expect(existsSync(join(dir, 'tmp/natif.yaml'))).toBe(false);
  });
  it('R8 — une valeur que le natif ne peut pas tenir (estimation 0) est refusée : l\'import ne perd rien en silence', () => {
    const dir = project(SOURCE.replace('effort: 0.75', 'effort: 0'));
    const r = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/AB-1\/t1-fusion.*effort/);
  });
  it('R9 — deux entrées de même identifiant, ou un identifiant absent, sont refusées', () => {
    const dir = project(SOURCE.replace('ident: AB-2', 'ident: AB-1'));
    const r = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/AB-1.*deux fois|en double/);
  });
  it('R10 — --verify lit le fichier écrit, rejoue l\'écriture inverse et dit « sans perte » avec le nombre de lots', () => {
    const dir = project();
    const r = raf(dir, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/3 lots/);
    expect(r.out).toMatch(/sans perte/);
  });
  it('R11 — --dry-run vérifie sans rien écrire', () => {
    const dir = project();
    const r = raf(dir, 'import', '--from-config', '--dry-run', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/3 lots/);
    expect(existsSync(join(dir, 'tmp/natif.yaml'))).toBe(false);
  });
  it('R12 — un plan sans plan.fields / plan.lots (natif) n\'a rien à importer : refus qui le dit', () => {
    const dir = gitRepo();
    const r = raf(dir, 'import', '--from-config');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/plan\.(fields|lots|statuses|estimates)/);
  });
  it('R13 — il faut exactement un sens : ni --from-config ni --to-config, ou les deux, est un usage refusé', () => {
    const dir = project();
    expect(raf(dir, 'import').code).toBe(2);
    expect(raf(dir, 'import', '--from-config', '--to-config').code).toBe(2);
  });
  it('R14 — --verify ou --rename seuls ne valent pas un sens ; --verify va avec --from-config seulement', () => {
    const dir = project();
    expect(raf(dir, 'import', '--to-config', '--verify', '--out', 'tmp/retour.yaml').code).toBe(2);
  });
});

describe('L472 — raf import --to-config', () => {
  it('R15 — depuis le natif importé, réécrit le plan au format d\'origine : mêmes entrées, mêmes valeurs, alias et clés non mappées compris', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml');
    expect(r.code).toBe(0);
    const back = parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] };
    const origin = parse(SOURCE) as { taches: Record<string, unknown>[] };
    expect(back.taches).toHaveLength(3);
    expect(back.taches[0]).toEqual(origin.taches[0]);
    expect(back.taches[1]).toMatchObject({ ident: 'AB-1/t1-fusion', parent: 'AB-1', etat: 'termine', effort: 0.75 });
    // Le texte seul d'une note (daté du jour de l'import en natif) et l'horodatage complet reviennent tels qu'à l'origine.
    expect(back.taches[1]!.note).toEqual('un seul texte');
    expect(back.taches[2]).toMatchObject({ ident: 'AB-2', etat: 'a_faire', dernier: '2026-10-30T08:15:00' });
  });
  it('R16 — après des écritures dans le natif (raf done, raf note, raf add), le retour tient : états du format d\'origine, effort en libellé, lot ajouté', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir);
    expect(raf(dir, 'done', 'AB-2', '--force').code).toBe(0);
    expect(raf(dir, 'note', 'AB-2', 'fini côté natif').code).toBe(0);
    expect(raf(dir, 'add', 'Lot neuf', '--estimate', '0.25').code).toBe(0);
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin);
    expect(r.code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    const ab2 = back.find((t) => t.ident === 'AB-2')!;
    expect(ab2.etat).toBe('termine');
    expect(ab2.note).toEqual([{ date: '2026-11-04', text: 'fini côté natif' }]);
    const added = back.find((t) => t.titre === 'Lot neuf')!;
    expect(added).toMatchObject({ etat: 'a_faire', effort: 'S' });
  });
  it('R17 — refuse d\'écraser le fichier existant sans --force ; avec --force la clé des lots est remplacée et les autres clés racine restent', () => {
    const dir = project(`version: 3\n${SOURCE}`);
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const refused = raf(dir, 'import', '--to-config');
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/existe déjà/);
    expect(raf(dir, 'import', '--to-config', '--force').code).toBe(0);
    const back = parse(readFileSync(join(dir, 'docs/plan/taches.yaml'), 'utf8')) as Record<string, unknown>;
    expect(back.version).toBe(3);
    expect((back.taches as unknown[]).length).toBe(3);
  });
  it('R18 — un état natif qu\'aucun état du format ne porte est refusé en le nommant, rien n\'est écrit', () => {
    const cfg = CONFIG.replace('    dropped: [abandonne]\n', '');
    const dir = project(SOURCE, cfg);
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir, cfg);
    expect(raf(dir, 'add', 'À jeter').code).toBe(0);
    expect(raf(dir, 'drop', 'L1').code).toBe(0);
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/L1.*dropped/);
    expect(existsSync(join(dir, 'tmp/retour.yaml'))).toBe(false);
  });
  it('R37 — --to-config laisse journal.ndjson tel quel et le dit en une ligne (format déclaratif à venir, L582)', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml');
    expect(r.code).toBe(0);
    expect(r.out).toContain('journal.ndjson inchangé : format déclaratif à venir, L582');
    expect(raf(dir, 'import', '--to-config', '--dry-run', '--out', 'tmp/autre.yaml').out).toContain('journal.ndjson inchangé : format déclaratif à venir, L582');
  });
  it('R19 — sans plan natif à lire, --to-config le dit', () => {
    const dir = project();
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/pas de plan/);
  });
});

describe('L472 — bords de l\'import', () => {
  const lotsOf = (dir: string) => nativeOf(dir).lots;
  it('R20 — --rename aller et retour : la clé renommée en natif retrouve son nom d\'origine dans le fichier du retour', () => {
    const dir = project(SOURCE.replace('    theme: infra\n', '    theme: infra\n    spec: docs/x.md\n'));
    expect(raf(dir, 'import', '--from-config', '--rename', 'spec=fiche', '--out', '.cadence/raf.yaml', '--verify').code).toBe(0);
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--rename', 'spec=fiche', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    expect(back[0]!.spec).toBe('docs/x.md');
    expect(back[0]).not.toHaveProperty('fiche');
  });
  it('R21 — --rename mal formé, répété ou vers un nom déjà pris est refusé', () => {
    const dir = project();
    for (const bad of ['spec', 'spec=', '=x', 'a=a', 'a=b=c']) expect(raf(dir, 'import', '--from-config', '--rename', bad, '--dry-run').code).toBe(2);
    expect(raf(dir, 'import', '--from-config', '--rename', 'a=x', '--rename', 'a=y', '--dry-run').code).toBe(2);
    expect(raf(dir, 'import', '--from-config', '--rename', 'a=x', '--rename', 'b=x', '--dry-run').code).toBe(2);
    const taken = project(SOURCE.replace('    theme: infra\n', '    theme: infra\n    local: 1\n    place2: 2\n'));
    expect(raf(taken, 'import', '--from-config', '--rename', 'local=theme', '--dry-run').code).toBe(2);
  });
  it('R22 — un plan sans lot s\'importe (0 lot) et revient vide', () => {
    const dir = project('taches: []\n');
    expect(raf(dir, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml').out).toMatch(/0 lots/);
    expect(lotsOf(dir)).toEqual([]);
  });
  it('R23 — second alias d\'un champ : l\'entrée qui n\'écrit que lui revient sous ce même alias ; quand les deux sont écrits la clé non retenue est refusée (nom du natif), puis gardée avec --rename', () => {
    const config = CONFIG.replace('id: [ident]', 'id: [ident, id]');
    const dir = project(`taches:\n  - id: X1\n    titre: Seul le second alias\n  - ident: X2\n    id: autre\n    titre: Les deux\n`, config);
    const refused = raf(dir, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/X2 : la clé « id »/);
    expect(raf(dir, 'import', '--from-config', '--rename', 'id=autre_id', '--verify', '--out', 'tmp/natif.yaml').code).toBe(0);
    expect(lotsOf(dir)[1]).toMatchObject({ id: 'X2', autre_id: 'autre' });
    expect(raf(dir, 'import', '--from-config', '--rename', 'id=autre_id', '--force', '--out', '.cadence/raf.yaml').code).toBe(0);
    const origin = switched(dir, config);
    expect(raf(dir, 'import', '--to-config', '--rename', 'id=autre_id', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    expect(back[0]).toMatchObject({ id: 'X1' });
    expect(back[0]).not.toHaveProperty('ident');
    expect(back[1]).toMatchObject({ ident: 'X2', id: 'autre' });
  });
  it('R24 — une clé à valeur nulle, un identifiant numérique et un horodatage complet passent l\'aller-retour', () => {
    const dir = project(`taches:\n  - ident: 5\n    titre: Numéro\n    commentaire: ~\n    dernier: 2026-10-30T08:15:00+02:00\n`);
    const r = raf(dir, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(0);
    expect(lotsOf(dir)[0]).toMatchObject({ id: '5', commentaire: null, last: '2026-10-30' });
  });
  it('R25 — faux, liste vide et clés mappées à plusieurs alias ne comptent pas comme perte : spec: false, after: [], note: []', () => {
    const config = CONFIG.replace('    last: [dernier]\n', '    last: [dernier]\n    spec: [spec]\n    after: [apres]\n');
    const dir = project(`taches:\n  - ident: A\n    titre: T\n    spec: false\n    apres: []\n    note: []\n`, config);
    expect(raf(dir, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml').code).toBe(0);
  });
  it('R26 — sans plan.statuses, un état qui est un statut de raf passe tel quel et revient tel quel ; un autre est refusé', () => {
    const config = CONFIG.replace(/  statuses:[\s\S]*?\n  estimates/, '  estimates');
    const ok = project(`taches:\n  - ident: A\n    titre: T\n    etat: doing\n`, config);
    expect(raf(ok, 'import', '--from-config', '--verify', '--out', 'tmp/natif.yaml').code).toBe(0);
    expect(lotsOf(ok)[0]).toMatchObject({ status: 'doing' });
    expect(lotsOf(ok)[0]).not.toHaveProperty('state');
    const bad = project(`taches:\n  - ident: A\n    titre: T\n    etat: teste\n`, config);
    const r = raf(bad, 'import', '--from-config', '--out', 'tmp/natif.yaml');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/A : état « teste »/);
  });
  it('R27 — une entrée qui n\'est pas un objet, ou sans identifiant, est refusée en la situant', () => {
    expect(raf(project('taches:\n  - 3\n'), 'import', '--from-config', '--dry-run').err).toMatch(/entrée n° 1/);
    expect(raf(project('taches:\n  - titre: sans id\n'), 'import', '--from-config', '--dry-run').err).toMatch(/identifiant absent/);
  });
  it('R28 — la sortie est dans un dossier qui n\'existe pas : il est créé ; le plan natif écrit est lu par raf list', () => {
    const dir = project();
    expect(raf(dir, 'import', '--from-config', '--out', 'neuf/profond/natif.yaml').code).toBe(0);
    const list = raf(dir, 'list', '--file', 'neuf/profond/natif.yaml', '--config', join(dir, 'vide.yaml'));
    expect(list.out).toContain('AB-1/t1-fusion');
  });
  it('R29 — les lots archivés du plan natif ne sont pas réécrits en silence : --to-config refuse en le disant', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir);
    expect(raf(dir, 'done', 'AB-2', '--force').code).toBe(0);
    expect(raf(dir, 'archive').code).toBe(0);
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/archivés/);
  });
  it('R30 — le retour garde les clés propres au natif (planned, delivered) telles quelles : rien ne se perd après raf plan', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir);
    expect(raf(dir, 'plan', 'AB-2', '2026-11-05..2026-11-06').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    expect(back.find((t) => t.ident === 'AB-2')!.planned).toEqual({ from: '2026-11-05', to: '2026-11-06' });
  });
  it('R38 — une sous-tâche créée dans le natif (raf add --parent) revient en sous-lot à plat du format d\'origine, juste après son lot, et le lecteur en lecture seule la voit', () => {
    const dir = project();
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir);
    expect(raf(dir, 'add', 'Sous-tâche native', '--parent', 'AB-1').code).toBe(0);
    expect(nativeOf(dir, '.cadence/raf.yaml').lots[0]).toHaveProperty('tasks');
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    expect(back.map((t) => t.ident)).toEqual(['AB-1', 'AB-1/t1', 'AB-1/t1-fusion', 'AB-2']);
    expect(back[0]).not.toHaveProperty('tasks');
    expect(back[1]).toEqual({ ident: 'AB-1/t1', titre: 'Sous-tâche native', etat: 'a_faire', parent: 'AB-1' });
    const list = raf(dir, 'list', '--json', '--file', 'tmp/retour.yaml', ...origin);
    expect(list.code).toBe(0);
    const read = (JSON.parse(list.out) as { id: string; tasks: { id: string; title: string; status: string }[] }[]).find((l) => l.id === 'AB-1')!;
    // Le lecteur replie aussi le sous-lot à plat d'origine (AB-1/t1-fusion) : la sous-tâche native est à côté de lui.
    expect(read.tasks).toContainEqual({ id: 't1', title: 'Sous-tâche native', status: 'todo' });
  });
});
});

describe('L472 — la comparaison de --verify voit une perte', () => {
  const format = { lots: 'taches', fields: { id: ['ident'], title: ['titre'], status: ['etat'], estimate: ['effort'], notes: ['note'] }, statuses: { todo: 'todo', doing: 'doing', done: 'done' } as never, estimates: { M: 0.5 } };
  const statuses = { a_faire: 'todo', code: 'doing', termine: 'done' } as never;
  const fmt = { ...format, statuses };
  const raw = [{ ident: 'A', titre: 'T', etat: 'code', effort: 'M', note: [{ date: '2026-11-01', text: 'n' }], theme: 'ui' }];
  const native = () => nativeEntries(raw, fmt, {}, '2026-11-04');
  it('R31 — l\'aller-retour intact ne dit rien ; une clé non mappée perdue, une date de note changée ou un état changé sont nommés', () => {
    expect(roundTripDiff(raw, foreignEntries(native(), fmt, {}), fmt)).toEqual([]);
    const lostKey = native().map(({ theme: _, ...e }) => e);
    expect(roundTripDiff(raw, foreignEntries(lostKey, fmt, {}), fmt).join('\n')).toMatch(/A : la clé « theme »/);
    const otherDate = native().map((e) => ({ ...e, notes: [{ date: '2026-11-02', text: 'n' }] }));
    expect(roundTripDiff(raw, foreignEntries(otherDate, fmt, {}), fmt).join('\n')).toMatch(/A : notes/);
    const otherState = native().map((e) => ({ ...e, status: 'done', state: 'termine' }));
    expect(roundTripDiff(raw, foreignEntries(otherState, fmt, {}), fmt).join('\n')).toMatch(/A : status « "code" » devient « "termine" »/);
    expect(roundTripDiff(raw, [], fmt).join('\n')).toMatch(/1 entrées à l'origine, 0 au retour/);
  });
  it('R32 — la relecture du natif voit un sens changé (statut, effort, titre) et un problème de lecture du natif', () => {
    expect(readingDiff(raw, native(), fmt)).toEqual([]);
    const changed = native().map((e) => ({ ...e, status: 'done', estimate: 3, title: 'autre' }));
    const diffs = readingDiff(raw, changed, fmt).join('\n');
    expect(diffs).toMatch(/A : status se lit « "doing" » à l'origine et « "done" » en natif/);
    expect(diffs).toMatch(/A : estimate/);
    expect(diffs).toMatch(/A : title/);
    const broken = native().map((e) => ({ ...e, last: 'hier' }));
    expect(readingDiff(raw, broken, fmt).join('\n')).toMatch(/A : last « hier » n'est pas une date.*\(en natif\)/);
  });
});

describe('L472 — le retour rend la clé et la valeur du format d\'origine', () => {
  const config = CONFIG.replace('last: [dernier]', 'last: [dernier]\n    finished: [livre_le, ferme_le]\n    created: [cree_le]\n    after: [apres]');
  const source = `taches:
  - ident: 5
    titre: A
    etat: termine
    ferme_le: 2026-10-13
    cree_le: 2026-10-13T12:43:54+00:00
    note: un texte
    apres: 4
  - ident: 6
    titre: B
    etat: termine
    livre_le: 2026-10-14
    note: [{ date: 2026-10-01, text: liste }]
`;
  const backOf = (dir: string, extra: string[] = []) => {
    const origin = switched(dir, config);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...extra, ...origin).code).toBe(0);
    return (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
  };
  it('R33 — un lot qui n\'avait que le second alias le retrouve au retour, et un lot qui avait le premier aussi', () => {
    const dir = project(source, config);
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const back = backOf(dir);
    expect(back[0]).toHaveProperty('ferme_le');
    expect(back[0]).not.toHaveProperty('livre_le');
    expect(back[1]).toHaveProperty('livre_le');
    expect(back[1]).not.toHaveProperty('ferme_le');
  });
  it('R34 — horodatage complet, note en texte, identifiant et dépendance scalaires reviennent tels qu\'ils étaient', () => {
    const dir = project(source, config);
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const back = backOf(dir);
    expect(back[0]).toMatchObject({ ident: 5, apres: 4, note: 'un texte' });
    expect(String(back[0].cree_le)).toBe('2026-10-13T12:43:54+00:00');
    expect(back[1].note).toEqual([{ date: '2026-10-01', text: 'liste' }]);
  });
  it('R35 — une valeur changée dans le natif est rendue au format déclaré, pas l\'ancienne ; la clé d\'origine reste', () => {
    const dir = project(source, config);
    raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml');
    const origin = switched(dir, config);
    expect(raf(dir, 'note', '5', 'nouvelle').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, unknown>[] }).taches;
    expect(back[0].note).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'nouvelle' })]));
  });
  it('R36 — --verify ne dit pas « sans perte » quand la forme d\'une valeur change (la comparaison est stricte)', () => {
    const fmt = { lots: 'taches', fields: { id: ['ident'], finished: ['livre_le', 'ferme_le'], notes: ['note'] }, statuses: {}, estimates: {} } as never;
    const rawLots = [{ ident: 'A', ferme_le: '2026-10-13T12:00:00+00:00', note: 'x' }];
    const cut = [{ ident: 'A', livre_le: '2026-10-13', note: [{ date: '2026-11-04', text: 'x' }] }];
    const d = roundTripDiff(rawLots, cut, fmt).join('\n');
    expect(d).toMatch(/A : finished/);
    expect(d).toMatch(/A : notes/);
  });
});
