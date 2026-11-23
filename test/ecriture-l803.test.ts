// L803 (D-31) : écriture courte contrôlée — principes de l'ASD-STE100 transposés au français. Le contrôle signale (jamais ne réécrit) une phrase
// de plus de 25 mots (20 pour une consigne), la voix passive et le point-virgule ; il donne la moyenne de mots par phrase (la mesure avant/après).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyser, bilan, blocs, DEFAUTS, estConsigne, lireEcriture, ligneBilan, main, mots, passif, phrasesDuBloc, signaux } from '../scripts/ecriture.mjs';
import { run } from '../src/cli.js';
import { validateConfig } from '../src/config-set.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

/** Une phrase de `n` mots (le premier en majuscule, un point final). */
const phrase = (n: number, debut = 'Le') => `${[debut, ...Array.from({ length: n - 1 }, () => 'mot')].join(' ')}.`;

async function ecriture(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function entree(dir: string, nom: string, date: string, corps: string) {
  mkdirSync(join(dir, 'docs/nouveautes'), { recursive: true });
  writeFileSync(join(dir, 'docs/nouveautes', nom), `---\ntitle: ${nom}\ndate: ${date}\nlots: [L1]\ncaptures: []\nnocapture: rien à voir\n---\n${corps}\n`);
}

describe('la clé ecriture: de cadence.yaml', () => {
  it('sans clé, les seuils du lot : 25 mots, 20 pour une consigne, passif et point-virgule signalés', () => {
    expect(lireEcriture(undefined, 'cadence.yaml')).toEqual({ phrase: 25, consigne: 20, passif: true, pointVirgule: true });
    expect(lireEcriture(null, 'cadence.yaml')).toEqual(DEFAUTS);
  });

  it('chaque réglage se change par projet ; une date YAML devient AAAA-MM-JJ', () => {
    expect(lireEcriture({ phrase: 30, consigne: 15, passif: false, pointVirgule: false, depuis: '2026-11-23' }, 'f'))
      .toEqual({ phrase: 30, consigne: 15, passif: false, pointVirgule: false, depuis: '2026-11-23' });
    expect(lireEcriture({ depuis: new Date('2026-11-23T00:00:00Z') }, 'f').depuis).toBe('2026-11-23');
  });

  it('une forme mal formée est refusée en nommant la clé', () => {
    expect(() => lireEcriture([], 'cadence.yaml')).toThrow('cadence.yaml : ecriture : objet');
    expect(() => lireEcriture({ seuil: 3 }, 'cadence.yaml')).toThrow('ecriture.seuil inconnu');
    expect(() => lireEcriture({ phrase: 0 }, 'f')).toThrow('ecriture.phrase : nombre de mots entier positif');
    expect(() => lireEcriture({ consigne: 2.5 }, 'f')).toThrow('ecriture.consigne');
    expect(() => lireEcriture({ passif: 'oui' }, 'f')).toThrow('ecriture.passif : true ou false');
    expect(() => lireEcriture({ depuis: 'lundi' }, 'f')).toThrow('ecriture.depuis : date AAAA-MM-JJ');
  });

  it('la validation de cadence.yaml (cadence config set) lit la clé par ce même code', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'ecriture: { phrase: dix }\n');
    expect(() => validateConfig(join(dir, 'cadence.yaml'), dir)).toThrow('ecriture.phrase');
    writeFileSync(join(dir, 'cadence.yaml'), 'ecriture: { phrase: 30, depuis: 2026-11-23 }\n');
    expect(() => validateConfig(join(dir, 'cadence.yaml'), dir)).not.toThrow();
  });
});

describe('du markdown aux phrases', () => {
  it('front matter, titres, code en bloc, séparateurs de tableau et commentaires ne sont pas des phrases', () => {
    const t = '---\ntitle: Un titre de plus de vingt-cinq mots ne compte pas\n---\n# Titre\n\nUn paragraphe\nsur deux lignes. Puis une autre.\n\n'
      + '- une puce\n1. un numéro\n\n```\ncode. Ignoré.\n```\n<!-- note -->\n| a b | c d |\n|---|---|\n| e | f |\n';
    expect(blocs(t)).toEqual([
      { ligne: 6, texte: 'Un paragraphe sur deux lignes. Puis une autre.' },
      { ligne: 9, texte: 'une puce' },
      { ligne: 10, texte: 'un numéro' },
      { ligne: 16, texte: 'a b' }, { ligne: 16, texte: 'c d' }, { ligne: 18, texte: 'e' }, { ligne: 18, texte: 'f' },
    ]);
  });

  it('coupe après . ! ? … suivis d’une majuscule, d’un chiffre ou d’un guillemet ; « p. ex. la » et « etc. et » ne coupent pas', () => {
    expect(phrasesDuBloc('Voir p. ex. la page `a b c`. Ensuite, etc. et puis. 2 lots sont faits ! Fin… « Oui » dit-il.'))
      .toEqual(['Voir p. ex. la page `a b c`.', 'Ensuite, etc. et puis.', '2 lots sont faits !', 'Fin…', '« Oui » dit-il.']);
  });

  it('un mot porte une lettre ou un chiffre : « l’appel », « mini-blue » comptent pour un, un tiret ou une flèche pour zéro', () => {
    expect(mots("l'appel de mini-blue — 18 h 30 → fini")).toEqual(["l'appel", 'de', 'mini-blue', '18', 'h', '30', 'fini']);
  });

  it('un code en ligne compte pour un mot et reste lisible dans l’extrait ; un lien compte pour son texte, une URL pour un mot', () => {
    const [p] = analyser('Lance `npx vitest run --minWorkers=1 test/a.test.ts` puis lis [la page des docs](docs/x.md) sur https://exemple.org/a/b.').phrases;
    expect(p!.mots).toBe(10); // Lance, le code, puis, lis, la, page, des, docs, sur, l'URL
    expect(p!.texte).toContain('`npx vitest run --minWorkers=1 test/a.test.ts`');
  });
});

describe('les signaux', () => {
  it('une phrase de 25 mots passe, 26 est signalée avec son nombre et le seuil', () => {
    expect(signaux(phrase(25))).toEqual([]);
    expect(signaux(phrase(26))).toEqual([{ type: 'longue', mots: 26, seuil: 25 }]);
  });

  it('une consigne a son propre seuil : 20 passe, 21 est signalée', () => {
    expect(signaux(phrase(20, 'Vérifiez'))).toEqual([]);
    expect(signaux(phrase(21, 'Vérifiez'))).toEqual([{ type: 'consigne-longue', mots: 21, seuil: 20 }]);
  });

  it('reconnaît une consigne : impératif en -ez, infinitif suivi d’un complément, « Ne pas », « il faut »', () => {
    for (const p of ['Vérifiez le fichier.', 'Lancer la commande avant le commit.', 'Ajouter un test.', 'Ne pas lancer de run après 18 h 30.',
      "N'utilise ni raf ni cadence.", 'Avant la livraison, il faut relire le diff.']) expect([p, estConsigne(p)]).toEqual([p, true]);
    const [code] = analyser('Lancer `npm test` avant de commiter.').phrases;
    expect(code!.consigne).toBe(true);
  });

  it('une phrase qui décrit n’est pas une consigne, même quand son premier mot finit en -er ou -ier', () => {
    for (const p of ['Hier la vague a tourné.', 'Le panneau montre les lots.', 'Fichier de la vague perdu.', 'Premier lot livré.', 'Docker est lent.',
      'Chez nous, rien ne bouge.']) expect([p, estConsigne(p)]).toEqual([p, false]);
  });

  it('voix passive : être (ou avoir été) suivi d’un participe, adverbe permis entre les deux', () => {
    expect(passif('Le fichier est écrit par la porte.')).toBe('est écrit');
    expect(passif('La revue a été lancée hier.')).toBe('été lancée');
    expect(passif('Les captures ne sont pas relues.')).toBe('sont pas relues');
    expect(passif('Les lots seront livrés demain.')).toBe('seront livrés');
  });

  it('pas de voix passive pour un verbe de mouvement au passé composé, un adjectif ou un adverbe', () => {
    for (const p of ['Le lot est arrivé hier.', 'Elle est partie tôt.', 'Il est ici.', 'Le résultat est vrai.', 'Le run est conforme.', 'La page est petite.',
      'La porte lance les tests.']) expect([p, passif(p)]).toEqual([p, null]);
  });

  it('un point-virgule lie deux idées : signalé ; chaque signal se coupe par projet', () => {
    const p = 'Le lot passe ; la revue suit.';
    expect(signaux(p)).toEqual([{ type: 'point-virgule' }]);
    expect(signaux(p, { ...DEFAUTS, pointVirgule: false })).toEqual([]);
    expect(signaux('Le fichier est écrit.', { ...DEFAUTS, passif: false })).toEqual([]);
    expect(signaux(phrase(26), { ...DEFAUTS, phrase: 30 })).toEqual([]);
  });

  it('le bilan compte phrases, mots et moyenne au dixième, et la part au-delà du seuil', () => {
    const b = bilan(analyser(`${phrase(10)} ${phrase(30)} Le fichier est écrit.`).phrases);
    expect(b).toEqual({ phrases: 3, mots: 44, moyenne: 14.7, longues: 1, consignesLongues: 0, passives: 1, pointsVirgules: 0 });
    expect(ligneBilan('Nouveautés', 1, b)).toBe('Nouveautés : 1 fichier, 3 phrases, 44 mots, moyenne 14,7 mots par phrase, 1 au-delà du seuil (33,3 %), 1 passive, 0 point-virgule');
  });
});

describe('cadence ecriture', () => {
  it('sans chemin : les entrées Nouveautés, chaque signal à sa ligne avec un extrait, puis la ligne de bilan ; rien n’est réécrit', async () => {
    const dir = tempDir();
    entree(dir, '2026-11-20-a.md', '2026-11-20', `${phrase(30)}\n\nCourte phrase.`);
    const avant = readFileSync(join(dir, 'docs/nouveautes/2026-11-20-a.md'), 'utf8');
    const r = await ecriture(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('docs/nouveautes/2026-11-20-a.md:8  30 mots (seuil 25) : « Le mot mot');
    expect(r.out).toContain('Nouveautés : 1 fichier, 2 phrases, 32 mots, moyenne 16 mots par phrase, 1 au-delà du seuil (50 %)');
    expect(readFileSync(join(dir, 'docs/nouveautes/2026-11-20-a.md'), 'utf8')).toBe(avant);
  });

  it('--jour et --depuis gardent les entrées de ce jour (ou après) ; --resume n’écrit que le bilan', async () => {
    const dir = tempDir();
    entree(dir, '2026-11-20-a.md', '2026-11-20', phrase(30));
    entree(dir, '2026-11-22-b.md', '2026-11-22', phrase(10));
    expect((await ecriture(dir, '--jour', '2026-11-22', '--resume')).out).toBe(
      'Nouveautés : 1 fichier, 1 phrases, 10 mots, moyenne 10 mots par phrase, 0 au-delà du seuil (0 %), 0 passive, 0 point-virgule');
    expect((await ecriture(dir, '--depuis', '2026-11-21', '--resume')).out).toContain('1 fichier, 1 phrases');
    expect((await ecriture(dir, '--depuis', '2026-11-20', '--resume')).out).toContain('2 fichiers, 2 phrases');
    expect((await ecriture(dir, '--jour', '2026-11-25')).out).toBe('ecriture : aucun fichier à lire');
  });

  it('un dossier de rapports de revue (.md, .txt, .json) : chaque groupe a son bilan, puis le total ; un JSON se repère par son chemin', async () => {
    const dir = tempDir();
    entree(dir, '2026-11-22-b.md', '2026-11-22', phrase(10));
    mkdirSync(join(dir, 'revues/sous'), { recursive: true });
    writeFileSync(join(dir, 'revues/code-reviewer.md'), `## Findings\n\n- ${phrase(27)}\n`);
    writeFileSync(join(dir, 'revues/sous/qa.json'), JSON.stringify({ verdict: 'conforme', constats: [{ texte: 'La page est servie vide.' }] }));
    writeFileSync(join(dir, 'revues/capture.png'), 'x');
    const r = await ecriture(dir, '--nouveautes', 'revues');
    expect(r.out).toContain('revues/code-reviewer.md:3  27 mots (seuil 25)');
    expect(r.out).toContain('revues/sous/qa.json#constats[0].texte  voix passive ? (« est servie »)');
    expect(r.out).toContain('Nouveautés : 1 fichier, 1 phrases');
    expect(r.out).toContain('Autres fichiers : 2 fichiers, 2 phrases, 32 mots, moyenne 16 mots par phrase');
    expect(r.out).toContain('Total : 3 fichiers, 3 phrases, 42 mots, moyenne 14 mots par phrase');
    // sans --nouveautes, un chemin donné ne lit que lui
    expect((await ecriture(dir, 'revues', '--resume')).out).not.toContain('Nouveautés');
  });

  it('--json donne la moyenne et chaque signalement, pour un script (le bilan du jour du dossier parent)', async () => {
    const dir = tempDir();
    entree(dir, '2026-11-22-b.md', '2026-11-22', `${phrase(26)} Le lot passe ; la revue suit.`);
    const j = JSON.parse((await ecriture(dir, '--json')).out);
    expect(j.total).toEqual({ fichiers: 1, phrases: 2, mots: 32, moyenne: 16, longues: 1, consignesLongues: 0, passives: 0, pointsVirgules: 1 });
    expect(j.groupes.nouveautes.moyenne).toBe(16);
    expect(j.fichiers).toEqual([expect.objectContaining({ fichier: 'docs/nouveautes/2026-11-22-b.md', groupe: 'nouveautes', phrases: 2 })]);
    expect(j.signalements.map((s: { type: string }) => s.type)).toEqual(['longue', 'point-virgule']);
    expect(j.reglages).toEqual(DEFAUTS);
  });

  it('les seuils viennent de cadence.yaml, puis de --seuil et --seuil-consigne ; --strict sort en 1 s’il reste un signal', async () => {
    const dir = tempDir();
    entree(dir, '2026-11-22-b.md', '2026-11-22', `${phrase(28)} ${phrase(22, 'Vérifiez')}`);
    expect((await ecriture(dir, '--strict')).code).toBe(1);
    writeFileSync(join(dir, 'cadence.yaml'), 'ecriture: { phrase: 30, consigne: 25 }\n');
    expect((await ecriture(dir, '--strict')).code).toBe(0);
    const r = await ecriture(dir, '--strict', '--seuil', '27', '--seuil-consigne', '21');
    expect(r.code).toBe(1);
    expect(r.out).toContain('28 mots (seuil 27)');
    expect(r.out).toContain('consigne de 22 mots (seuil 21)');
  });

  it('code 2 pour une option, un réglage ou un fichier illisible, avec la cause', async () => {
    const dir = tempDir();
    expect(await ecriture(dir, '--jour', '23-11')).toMatchObject({ code: 2, err: 'ecriture : --jour : date AAAA-MM-JJ attendue' });
    expect((await ecriture(dir, '--seuil', '0')).code).toBe(2);
    expect((await ecriture(dir, '--json', '--resume')).code).toBe(2);
    expect((await ecriture(dir, 'absent.md')).err).toBe('ecriture : absent.md : introuvable');
    writeFileSync(join(dir, 'r.json'), '{');
    expect((await ecriture(dir, 'r.json')).err).toContain('r.json : JSON illisible');
    writeFileSync(join(dir, 'cadence.yaml'), 'ecriture: { inconnu: 1 }\n');
    expect((await ecriture(dir)).err).toContain('cadence.yaml : ecriture.inconnu inconnu');
  });

  it('--help donne l’usage', async () => {
    expect((await ecriture(tempDir(), '--help')).out).toContain('cadence ecriture [chemin…]');
  });
});

describe('raf news check (L803)', () => {
  function cli(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-23' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-11-23T10:00:00') });
    return { code, out: out.join('\n') };
  }

  it('sans clé ecriture:, rien de neuf ; avec la clé, les signaux des entrées datées de « depuis » ou après, en avertissement qui ne bloque pas', () => {
    const dir = gitRepo();
    cli(dir, 'init', '--no-hook');
    cli(dir, 'add', 'Un lot');
    entree(dir, '2026-11-20-vieille.md', '2026-11-20', phrase(40));
    entree(dir, '2026-11-23-neuve.md', '2026-11-23', `${phrase(30)} Le fichier est écrit.`);
    const sans = cli(dir, 'news', 'check');
    expect(sans.out).not.toContain('écriture');
    const yaml = join(dir, 'cadence.yaml');
    (existsSync(yaml) ? appendFileSync : writeFileSync)(yaml, '\necriture: { depuis: 2026-11-21 }\n');
    const avec = cli(dir, 'news', 'check');
    expect(avec.code).toBe(sans.code);
    expect(avec.out).toContain('⚠ écriture : 2026-11-23-neuve.md:8  30 mots (seuil 25)');
    expect(avec.out).toContain('⚠ écriture : 2026-11-23-neuve.md:8  voix passive ? (« est écrit »)');
    expect(avec.out).not.toContain('écriture : 2026-11-20-vieille');
  });
});

describe('les agents de revue écrivent court (L803)', () => {
  it.each(['code-reviewer', 'ux-reviewer', 'qa-reviewer'])('agents/%s.md lance cadence ecriture sur son rapport, sans changer constat ni verdict', (nom) => {
    const agent = readFileSync(join(import.meta.dirname, '..', 'agents', `${nom}.md`), 'utf8');
    expect(agent).toContain('run `cadence ecriture <the path>`');
    expect(agent).toMatch(/25 words at most, 20 for an\s+instruction/);
    expect(agent).toContain('without changing a finding, a measure or the verdict');
  });

  it('le cadence.yaml du dépôt adopte la clé et elle se lit', async () => {
    const { parse } = await import('yaml');
    const racine = join(import.meta.dirname, '..');
    expect(lireEcriture(parse(readFileSync(join(racine, 'cadence.yaml'), 'utf8')).ecriture, 'cadence.yaml')).toEqual({ ...DEFAUTS, depuis: '2026-11-23' });
  });
});
