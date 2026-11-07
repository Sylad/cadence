# Cadence 2 — plan n°1 : squelette v2 et banc de mesure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire le squelette de cadence 2 et le banc `cadence2 bench`, qui rejoue de vraies demandes « Claude seul » contre un bras candidat, mesure, juge à l'aveugle et bloque la publication si la barre n'est pas tenue. On termine par un contre-essai « équipe légère » sur les bancs 1, 3 et 6.

**Architecture:** Paquet isolé `cadence/v2/`, avec ses propres `package.json`, `tsconfig` et `vitest`. Sa suite ne rejoue jamais les 583 fichiers de test de v1 (cause C3). Le banc est découpé en modules purs et testables :
- définitions (`banc`) ;
- clone assaini (`preparer`) ;
- bras lancés par `claude -p`, avec un exécuteur injectable (`bras`) ;
- contrôle des fuites (`fuites`) ;
- juges à l'aveugle (`juges`) ;
- verdict et rapport purs (`verdict`) ;
- orchestration (`cli`).

Les données du banc vivent hors des dépôts, dans `~/bench-cadence/` (clones de 9 Go).

**Tech Stack:** TypeScript 5.5 (NodeNext, strict), Node 22, vitest 2, yaml 2, `claude` CLI 2.1 (`-p --output-format json`), systemd (WSL, `systemd=true`).

**Spec:** `docs/v2/2026-11-07-cadence-2-design.md` (§0, §1, §4, §5, §6). Ce plan couvre uniquement `bench` et le squelette. `plan`, `accueil`, `run`, `porte` et `deliver` feront l'objet de plans suivants, une fois le banc en service, comme le prévoit le §6.2 (« en commençant par `bench` »).

## Global Constraints

- Tout le code v2 vit sous `cadence/v2/`. **Aucun fichier de `cadence/src/` n'est modifié**, sauf `src/release.ts` (Task 10) et `hooks/hooks.json` (Task 10).
- Budget de lignes de `v2/src/` : 3 000 lignes au total, et un budget par module, contrôlés par un test (cause C4). Le module `bench` a 750 lignes (voir Écarts ci-dessous).
- Un module, une option ou un agent neuf n'entre qu'avec un rapport de banc où il gagne (spec §5).
- Barre (spec §1) : relecture aveugle au moins égale sur la majorité des bancs ; tests cachés et mutations au moins égaux à la référence ; défauts bloquants et majeurs au plus égaux à la référence ; UI au moins égale ; temps au plus 1,5 × la référence (1,2 × sur les retouches) ; aucune question à Sylvain sur un banc sans vraie décision.
- Les bras ne doivent jamais toucher la prod :
  - `KUBECONFIG=/nonexistent`, `GH_TOKEN` et `GITHUB_TOKEN` vides, `AETHERWX_URL=http://127.0.0.1:9` ;
  - outils interdits : `kubectl`, `helm`, `gh`, `ssh`, `scp`, `git push`, `npm publish`.
- Un seul bras à la fois, jamais deux en parallèle (incident du 07-11 : navigateur et ports partagés).
- Fichiers temporaires : dans `~/bench-cadence/runs/`, jamais dans un dépôt.
- Commits : chemins explicites, jamais `git add -A` ni `git commit -a`. Chaque message finit par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Langue : messages, docs et identifiants métier en français, comme dans v1.

### Écarts au texte de la spec (signalés à Sylvain)

1. **v2 est un paquet séparé `cadence/v2/`**, et non `src/v2/` dans le paquet v1. Sinon chaque changement de v2 paierait la suite v1 (cause C3). À la bascule (§6.4), `v2/` devient la racine.
2. **La barre est relative à la référence A du même passage.** Les chiffres absolus du 07-11 (304 tests cachés, 79 % de mutations) sont affichés, mais ne bloquent pas : l'adaptation des tests cachés varie d'un passage à l'autre, et un seuil absolu bloquerait sur du bruit.
3. **Budgets** : `bench` passe à 750 lignes, `run` à 750, `porte` à 250 et `deliver` à 550. Le total reste 3 000.
4. **Bancs frais (Q1)** : `bench ajouter` construit un banc à partir d'un lot livré. Il n'y a pas de tirage automatique tant que les lots n'ont pas de champ `demande:` (v2). `bench statut` signale une semaine sans banc frais.

## Review Focus

1. **Un bras qui lance `kubectl` ou `git push`** : le refus doit venir de `--disallowedTools` et de l'environnement neutralisé. Le test vérifie les arguments et l'environnement passés à `claude` (Task 4), puis une sonde réelle vérifie le refus (Task 12).
2. **Un bras qui lit la solution** (`secrets/`, vrais dépôts, transcripts) : le bras est exclu du banc et le verdict le dit. Couvert par les tests de la Task 5.
3. **Un juge qui rend un JSON invalide ou incomplet** : une seule relance avec la liste des erreurs, puis le banc est marqué « non jugé » et le verdict devient rouge, jamais vert par défaut (Task 6).
4. **Le banc du weekend n'a pas tourné** (WSL fermé tout le weekend) : `bench statut` sort en code 1 et l'affiche à chaque session, et la publication 2.x est refusée (Tasks 8 et 10).
5. **Une base de banc qui laisse fuir le futur** (tag ou branche postérieure à la base) : `preparer` refuse si `git rev-list --all --not HEAD` n'est pas vide (Task 3).

---

## Arborescence

```
cadence/v2/
  package.json  tsconfig.json  vitest.config.ts  budget.json
  bin/cadence2.js
  briefs/bras-A.md  briefs/bras-equipe-legere.md  briefs/juge-mecanique.md  briefs/juge-aveugle.md
  systeme/cadence-banc.service  systeme/cadence-banc.timer  systeme/installer.sh
  scripts/migrer-bancs-essai.sh
  src/cli.ts                    dispatch racine (cadence2 bench …)
  src/bench/banc.ts             définitions de bancs (banc.yaml)
  src/bench/preparer.ts         clone assaini à la base
  src/bench/bras.ts             lancement d'un bras par claude -p, mesures, questions
  src/bench/fuites.ts           lectures interdites dans les transcripts
  src/bench/juges.ts            anonymisation X/Y, juges mécanique et aveugle, validation JSON
  src/bench/verdict.ts          barre, verdict, rapport, historique, statut
  src/bench/cli.ts              sous-commandes de bench
  src/bench/ajouter.ts          banc frais à partir d'un lot livré
  test/*.test.ts
~/bench-cadence/                (hors dépôt, BENCH_ROOT)
  bras.yaml  barre.yaml  projets.yaml
  bancs/<n>-<nom>/{banc.yaml,demande.md,pieces/,reponses.md?}     visible des bras
  secrets/<n>-<nom>/{mesure.md,attendu.md,tests-origine/}           interdit aux bras
  runs/<date>-<empreinte>/<banc>/{<bras>/,eval/,mesures.json,...}
  rapports/<date>-<empreinte>.{md,json}   historique.jsonl
```

---

### Task 1 : Squelette du paquet v2 et budget de lignes

**Files:**
- Create: `v2/package.json`, `v2/tsconfig.json`, `v2/vitest.config.ts`, `v2/budget.json`, `v2/bin/cadence2.js`, `v2/src/cli.ts`
- Test: `v2/test/budget.test.ts`, `v2/test/cli.test.ts`

**Interfaces:**
- Produces : `run(args: string[], io: Io): Promise<number>` dans `v2/src/cli.ts` ; `type Io = { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void; now: () => Date }`. Les sous-commandes s'enregistrent dans `COMMANDES: Record<string, (args: string[], io: Io) => Promise<number>>`.

- [ ] **Step 1 : Créer le paquet**

`v2/package.json` :
```json
{
  "name": "@sylad/cadence-v2",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "cadence2": "bin/cadence2.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "yaml": "^2.5.0" },
  "devDependencies": { "@types/node": "^22.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

`v2/tsconfig.json` :
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "rootDir": "src", "outDir": "dist", "skipLibCheck": true
  },
  "include": ["src"]
}
```

`v2/vitest.config.ts` :
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { tsconfigRaw: '{}' },
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
```

`v2/budget.json` :
```json
{ "total": 3000, "modules": { "bench": 750, "plan": 500, "accueil": 200, "run": 750, "porte": 250, "deliver": 550 } }
```

`v2/bin/cadence2.js` :
```js
#!/usr/bin/env node
import { run } from '../dist/cli.js';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(), env: process.env, now: () => new Date(),
  out: (l) => console.log(l), err: (l) => console.error(l),
});
```

- [ ] **Step 2 : Écrire les tests qui échouent**

`v2/test/budget.test.ts` :
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const racine = join(import.meta.dirname, '..');
const budget = JSON.parse(readFileSync(join(racine, 'budget.json'), 'utf8')) as { total: number; modules: Record<string, number> };

function lignes(chemin: string): number {
  if (statSync(chemin).isDirectory()) return readdirSync(chemin).reduce((n, e) => n + lignes(join(chemin, e)), 0);
  return chemin.endsWith('.ts') ? readFileSync(chemin, 'utf8').split('\n').length : 0;
}

describe('budget de lignes de v2/src (cause C4 de l\'échec du 07-11)', () => {
  const src = join(racine, 'src');
  it(`le total tient dans ${budget.total} lignes`, () => expect(lignes(src)).toBeLessThanOrEqual(budget.total));
  for (const e of readdirSync(src).filter((e) => statSync(join(src, e)).isDirectory())) {
    it(`le module ${e} a un budget et le tient`, () => {
      expect(budget.modules[e], `module ${e} sans budget : un module neuf demande un rapport de banc où il gagne`).toBeDefined();
      expect(lignes(join(src, e))).toBeLessThanOrEqual(budget.modules[e]);
    });
  }
  it('la somme des budgets ne dépasse pas le total', () =>
    expect(Object.values(budget.modules).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget.total));
});
```

`v2/test/cli.test.ts` :
```ts
import { describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';

export function ioTest(env: NodeJS.ProcessEnv = {}): Io & { sortie: string[]; erreurs: string[] } {
  const sortie: string[] = []; const erreurs: string[] = [];
  return { cwd: '/', env, now: () => new Date('2026-11-09T10:00:00Z'), out: (l) => sortie.push(l), err: (l) => erreurs.push(l), sortie, erreurs };
}

describe('cadence2', () => {
  it('sans argument, affiche l\'aide et sort en 0', async () => {
    const io = ioTest();
    expect(await run([], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(/cadence2 bench/);
  });
  it('commande inconnue : code 2', async () => {
    const io = ioTest();
    expect(await run(['zorglub'], io)).toBe(2);
    expect(io.erreurs[0]).toMatch(/inconnue/);
  });
});
```

- [ ] **Step 3 : Lancer, vérifier l'échec**

Run: `cd v2 && npm install && npx vitest run`
Expected: FAIL, « Cannot find module '../src/cli.js' ».

- [ ] **Step 4 : Écrire `v2/src/cli.ts`**

```ts
export type Io = { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void; now: () => Date };
type Commande = (args: string[], io: Io) => Promise<number>;

export const COMMANDES: Record<string, Commande> = {};

const AIDE = `cadence2 — noyau de cadence 2 (en construction)
  cadence2 bench court|hebdo|lancer|statut|verifier-publication|ajouter   banc de mesure (docs/v2/)`;

export async function run(args: string[], io: Io): Promise<number> {
  const [nom, ...reste] = args;
  if (!nom || nom === 'help' || nom === '--help') { io.out(AIDE); return 0; }
  const c = COMMANDES[nom];
  if (!c) { io.err(`cadence2 : commande inconnue : ${nom}`); return 2; }
  return c(reste, io);
}
```

- [ ] **Step 5 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (budget : aucun module encore, total ≈ 15 lignes).

- [ ] **Step 6 : Ajouter `v2/node_modules` et `v2/dist` au `.gitignore` racine, puis commiter**

```bash
printf 'v2/node_modules/\nv2/dist/\n' >> .gitignore
git add .gitignore v2/package.json v2/package-lock.json v2/tsconfig.json v2/vitest.config.ts v2/budget.json v2/bin/cadence2.js v2/src/cli.ts v2/test/budget.test.ts v2/test/cli.test.ts
git commit -m "v2: squelette du paquet cadence 2 et budget de lignes contrôlé par test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2 : Définitions de bancs et migration des 8 bancs de l'essai

**Files:**
- Create: `v2/src/bench/banc.ts`, `v2/scripts/migrer-bancs-essai.sh`
- Test: `v2/test/banc.test.ts`

**Interfaces:**
- Produces :
  ```ts
  type Taille = 'retouche' | 'fonction' | 'grosse';
  interface Banc { id: string; dir: string; secrets: string; projet: string; source: string; base: string;
    install: string; tests: string; visible: boolean; taille: Taille; frais: boolean; reponses: boolean }
  function racineBanc(env: NodeJS.ProcessEnv): string            // BENCH_ROOT ou ~/bench-cadence
  function chargerBanc(racine: string, id: string): Banc
  function listerBancs(racine: string, numeros?: string[]): Banc[]  // triés par numéro
  function lireDemande(b: Banc): string
  class BancInvalide extends Error
  ```

- [ ] **Step 1 : Test qui échoue**

`v2/test/banc.test.ts` :
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BancInvalide, chargerBanc, listerBancs, lireDemande, racineBanc } from '../src/bench/banc.js';

function racineAvec(bancs: Record<string, string>): string {
  const r = mkdtempSync(join(tmpdir(), 'banc-'));
  for (const [id, yaml] of Object.entries(bancs)) {
    mkdirSync(join(r, 'bancs', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), yaml);
    writeFileSync(join(r, 'bancs', id, 'demande.md'), `demande de ${id}\n`);
  }
  return r;
}
const YAML = `projet: ol-companion\nsource: /src/ol\nbase: e91b65c\ninstall: npm ci\ntests: npm test\nvisible: true\ntaille: retouche\n`;

describe('bancs', () => {
  it('charge un banc complet, avec les valeurs par défaut', () => {
    const r = racineAvec({ '1-ol-L239': YAML });
    const b = chargerBanc(r, '1-ol-L239');
    expect(b).toMatchObject({ id: '1-ol-L239', projet: 'ol-companion', base: 'e91b65c', visible: true, taille: 'retouche', frais: false, reponses: false });
    expect(b.secrets).toBe(join(r, 'secrets', '1-ol-L239'));
    expect(lireDemande(b)).toBe('demande de 1-ol-L239');
  });
  it('refuse un banc sans base, en nommant le champ', () => {
    const r = racineAvec({ '2-x': YAML.replace('base: e91b65c\n', '') });
    expect(() => chargerBanc(r, '2-x')).toThrow(BancInvalide);
    expect(() => chargerBanc(r, '2-x')).toThrow(/base/);
  });
  it('refuse une taille inconnue', () => {
    const r = racineAvec({ '3-x': YAML.replace('retouche', 'énorme') });
    expect(() => chargerBanc(r, '3-x')).toThrow(/taille/);
  });
  it('liste par numéro et filtre', () => {
    const r = racineAvec({ '10-a': YAML, '2-b': YAML, '1-c': YAML });
    expect(listerBancs(r).map((b) => b.id)).toEqual(['1-c', '2-b', '10-a']);
    expect(listerBancs(r, ['1', '10']).map((b) => b.id)).toEqual(['1-c', '10-a']);
  });
  it('racine : BENCH_ROOT, sinon ~/bench-cadence', () => {
    expect(racineBanc({ BENCH_ROOT: '/x' })).toBe('/x');
    expect(racineBanc({ HOME: '/h' })).toBe('/h/bench-cadence');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/banc.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/banc.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type Taille = 'retouche' | 'fonction' | 'grosse';
export interface Banc { id: string; dir: string; secrets: string; projet: string; source: string; base: string;
  install: string; tests: string; visible: boolean; taille: Taille; frais: boolean; reponses: boolean }
export class BancInvalide extends Error {}

const TAILLES: Taille[] = ['retouche', 'fonction', 'grosse'];
const REQUIS = ['projet', 'source', 'base', 'install', 'tests'] as const;

export const racineBanc = (env: NodeJS.ProcessEnv) => env.BENCH_ROOT ?? join(env.HOME ?? '', 'bench-cadence');

export function chargerBanc(racine: string, id: string): Banc {
  const dir = join(racine, 'bancs', id);
  const y = (parse(readFileSync(join(dir, 'banc.yaml'), 'utf8')) ?? {}) as Record<string, unknown>;
  for (const k of REQUIS) if (typeof y[k] !== 'string' || !y[k]) throw new BancInvalide(`banc ${id} : champ « ${k} » manquant`);
  if (!TAILLES.includes(y.taille as Taille)) throw new BancInvalide(`banc ${id} : taille « ${String(y.taille)} » inconnue (${TAILLES.join(', ')})`);
  return {
    id, dir, secrets: join(racine, 'secrets', id),
    projet: y.projet as string, source: y.source as string, base: y.base as string,
    install: y.install as string, tests: y.tests as string,
    visible: y.visible === true, taille: y.taille as Taille, frais: y.frais === true,
    reponses: existsSync(join(dir, 'reponses.md')),
  };
}

const numero = (id: string) => Number(id.split('-')[0]);

export function listerBancs(racine: string, numeros?: string[]): Banc[] {
  const dir = join(racine, 'bancs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => !numeros || numeros.includes(id.split('-')[0]))
    .sort((a, b) => numero(a) - numero(b))
    .map((id) => chargerBanc(racine, id));
}

export const lireDemande = (b: Banc) => readFileSync(join(b.dir, 'demande.md'), 'utf8').trim();
```

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/banc.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5 : Écrire le script de migration des 8 bancs de l'essai**

`v2/scripts/migrer-bancs-essai.sh`. Il copie depuis `tmp/essai/` et `~/.essai-cache-0711/`, sans rien y modifier :
```bash
#!/usr/bin/env bash
# Migre les 8 bancs de l'essai du 07-11 vers ~/bench-cadence (BENCH_ROOT). Idempotent ; ne touche pas aux sources.
set -euo pipefail
E=$HOME/projects/developpeur/tmp/essai; C=$HOME/.essai-cache-0711; P=$HOME/projects/developpeur
R=${BENCH_ROOT:-$HOME/bench-cadence}
OLI='(cd backend && npm ci --no-audit --no-fund) && (cd frontend && npm ci --no-audit --no-fund)'
OLT='(cd backend && npm test) && (cd frontend && npm test)'
FII='npm ci --no-audit --no-fund && (cd backend && npm ci --no-audit --no-fund) && (cd frontend && npm ci --no-audit --no-fund)'
FIT='(cd backend && npm test) && (cd frontend && npx vitest run)'
MAI='cd frontend && npm ci --no-audit --no-fund'
MAT='cd frontend && npx vitest run'
#        id                     projet           base      install tests visible taille
ligne() { local id=$1 projet=$2 base=$3 inst=$4 tst=$5 vis=$6 taille=$7
  local b=$R/bancs/$id s=$R/secrets/$id
  mkdir -p "$b" "$s"
  # texte brut de Sylvain : la partie au-dessus de « --- », sans le titre ni les citations « > »
  python3 -I -c 'import sys,re;t=open(sys.argv[1]).read().split("\n---\n")[0];t=re.sub(r"^# Demande\s*\n","",t).strip();t=re.sub(r"^> ?","",t,flags=re.M);print(re.sub(r"\n{3,}","\n\n",t).strip())' "$E/$id/demande.md" > "$b/demande.md"
  [ -d "$E/$id/pieces" ] && rm -rf "$b/pieces" && cp -a "$E/$id/pieces" "$b/pieces"
  sed -i "s#$E/$id/pieces#$b/pieces#g" "$b/demande.md"
  [ -f "$C/$id/reponses-de-sylvain.md" ] && cp "$C/$id/reponses-de-sylvain.md" "$b/reponses.md"
  for f in mesure.md attendu.md; do
    sed -e "s#$C/$id/#$s/#g" -e "s#$E/$id/<A|B>#<clone X ou Y>#g" -e "s#<A|B>#<X|Y>#g" "$C/$id/$f" > "$s/$f"
  done
  rm -rf "$s/tests-origine" && cp -a "$C/$id/tests-origine" "$s/tests-origine"
  cat > "$b/banc.yaml" <<EOF
projet: $projet
source: $P/$projet
base: $base
install: '$inst'
tests: '$tst'
visible: $vis
taille: $taille
EOF
}
ligne 1-ol-companion-L239     ol-companion   e91b65c  "$OLI" "$OLT" true  retouche
ligne 2-ol-companion-L248     ol-companion   e902609  "$OLI" "$OLT" true  retouche
ligne 3-ol-companion-L241     ol-companion   94bc157  "$OLI" "$OLT" false fonction
ligne 4-finance-tracker-L73   finance-tracker 7ec567b "$FII" "$FIT" true  fonction
ligne 5-ol-companion-L242     ol-companion   29abec4  "$OLI" "$OLT" false fonction
ligne 6-ol-companion-L167     ol-companion   dc133f6  "$OLI" "$OLT" true  grosse
ligne 7-ol-companion-L160     ol-companion   f8e6b82  "$OLI" "$OLT" true  grosse
ligne 8-maritime-atlas-B68    maritime-atlas ba9e6743 "$MAI" "$MAT" true  fonction
chmod 700 "$R/secrets"
echo "8 bancs migrés dans $R"
```
Le banc 4 a besoin d'un correctif de lock (`_outils/finance-fix.sh`), et les bancs 6, 7 et 8 d'un lock postérieur à la base (MANIFESTE, point 9). Ajouter à la main dans `banc.yaml` de ces bancs une ligne `install:` qui reprend la commande effectivement jouée à l'essai. Elle se lit dans `~/.essai-cache-0711/<banc>/_install-A.log` et `_journal-A.log`, et dans `tmp/essai/_outils/finance-fix.sh` et `fix-678.sh`. Contrôle : Task 3, Step 6.

- [ ] **Step 6 : Lancer la migration et vérifier**

Run: `bash v2/scripts/migrer-bancs-essai.sh && ls ~/bench-cadence/bancs ~/bench-cadence/secrets && head -3 ~/bench-cadence/bancs/1-ol-companion-L239/demande.md`
Expected : 8 dossiers dans chaque répertoire ; la demande du banc 1 commence par le texte de Sylvain sur le séparateur.

- [ ] **Step 7 : Commit**

```bash
git add v2/src/bench/banc.ts v2/test/banc.test.ts v2/scripts/migrer-bancs-essai.sh
git commit -m "v2(bench): définitions de bancs et migration des 8 bancs de l'essai du 07-11

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3 : Préparer un clone assaini à la base

**Files:**
- Create: `v2/src/bench/preparer.ts`
- Test: `v2/test/preparer.test.ts`

**Interfaces:**
- Consumes : `Banc` (Task 2).
- Produces : `function preparer(b: Banc, cible: string): { testsBase: number }`. Elle lève `FuturVisible` si un commit postérieur à la base reste joignable. Elle écrit `<cible>.install.log` et `<cible>.tests-base.log`.

- [ ] **Step 1 : Test qui échoue**

`v2/test/preparer.test.ts` :
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { preparer } from '../src/bench/preparer.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function depot(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), '1'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', 'v-avant');
  writeFileSync(join(dir, 'a.txt'), '2'); git(dir, 'commit', '-qam', 'solution du futur');
  git(dir, 'tag', 'v-futur'); git(dir, 'branch', 'autre');
  return { dir, base };
}
const banc = (source: string, base: string, tests = 'true'): Banc => ({
  id: '1-t', dir: '/nulle-part', secrets: '/nulle-part', projet: 't', source, base,
  install: 'true', tests, visible: false, taille: 'retouche', frais: false, reponses: false });

describe('preparer', () => {
  it('clone à la base, sans remote, sans tag ni branche du futur', () => {
    const { dir, base } = depot();
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    const r = preparer(banc(dir, base), cible);
    expect(git(cible, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(cible, 'remote')).toBe('');
    expect(git(cible, 'tag')).toBe('v-avant');
    expect(git(cible, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(cible, 'rev-list', '--all', '--not', 'HEAD')).toBe('');
    expect(r.testsBase).toBe(0);
    expect(existsSync(`${cible}.tests-base.log`)).toBe(true);
  });
  it('rapporte le code de la suite à la base', () => {
    const { dir, base } = depot();
    const cible = join(mkdtempSync(join(tmpdir(), 'run-')), 'A');
    expect(preparer(banc(dir, base, 'exit 3'), cible).testsBase).toBe(3);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/preparer.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/preparer.ts`**

```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Banc } from './banc.js';

export class FuturVisible extends Error {}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function shell(cmd: string, cwd: string, log: string): number {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  writeFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.status ?? 1;
}

/** Clone de travail d'un bras : à la base, sans remote, sans rien de postérieur (tags, branches, reflog). */
export function preparer(b: Banc, cible: string): { testsBase: number } {
  rmSync(cible, { recursive: true, force: true });
  mkdirSync(dirname(cible), { recursive: true });
  execFileSync('git', ['clone', '-q', '--no-hardlinks', b.source, cible]);
  git(cible, 'checkout', '-q', '-B', 'main', b.base);
  git(cible, 'remote', 'remove', 'origin');
  for (const br of git(cible, 'branch', '--format=%(refname:short)').split('\n')) if (br && br !== 'main') git(cible, 'branch', '-D', '-q', br);
  for (const t of git(cible, 'tag').split('\n').filter(Boolean)) {
    if (spawnSync('git', ['merge-base', '--is-ancestor', t, 'HEAD'], { cwd: cible }).status !== 0) git(cible, 'tag', '-d', t);
  }
  git(cible, 'reflog', 'expire', '--expire=now', '--all');
  git(cible, 'gc', '-q', '--prune=now');
  const futur = git(cible, 'rev-list', '--all', '--not', 'HEAD');
  if (futur) throw new FuturVisible(`banc ${b.id} : ${futur.split('\n').length} commit(s) postérieur(s) à la base restent joignables`);
  shell(b.install, cible, `${cible}.install.log`);
  return { testsBase: shell(b.tests, cible, `${cible}.tests-base.log`) };
}
```

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/preparer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5 : Commit**

```bash
git add v2/src/bench/preparer.ts v2/test/preparer.test.ts
git commit -m "v2(bench): clone assaini à la base (aucun commit futur joignable)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 : Contrôle réel sur les 8 bancs migrés**

Run (un banc à la fois, environ 3 min chacun) :
```bash
cd v2 && npm run build && for n in 1 2 3 4 5 6 7 8; do node -e "
import('./dist/bench/banc.js').then(async ({listerBancs})=>{const {preparer}=await import('./dist/bench/preparer.js');
const [b]=listerBancs(process.env.HOME+'/bench-cadence',['$n']);const r=preparer(b,process.env.HOME+'/bench-cadence/runs/controle/'+b.id+'/A');
console.log(b.id,'tests à la base rc=',r.testsBase)})"; done
```
Expected : `rc=0` sur les 8 bancs, comme à l'essai (MANIFESTE, colonne « Suite à la base »). Si un banc sort en rc≠0, corriger son `install:` dans `banc.yaml` (Task 2, Step 5) et rejouer ce banc. Supprimer ensuite `~/bench-cadence/runs/controle`.

---

### Task 4 : Lancer un bras par `claude -p`, avec les mesures et les questions

**Files:**
- Create: `v2/src/bench/bras.ts`, `v2/briefs/bras-A.md`, `v2/briefs/bras-equipe-legere.md`
- Test: `v2/test/bras.test.ts`

**Interfaces:**
- Consumes : `Banc`, `lireDemande` (Task 2).
- Produces :
  ```ts
  interface DefBras { nom: string; modele: string; brief: string }        // brief : chemin du gabarit
  interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number;
    tokens: number; cout_usd: number; questions: number; sessions: string[] }
  type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number };
  const OUTILS_INTERDITS: string[];
  function chargerBras(racine: string): Record<string, DefBras>        // <racine>/bras.yaml
  function environnementNeutre(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  function lancerBras(b: Banc, d: DefBras, clone: string, exec: Executeur, horloge?: () => Date): Mesure
  const executeurClaude: Executeur
  ```
  Le fichier de question d'un bras est `<clone>.question.md`, hors du dépôt.

- [ ] **Step 1 : Écrire les briefs**

`v2/briefs/bras-A.md` (repris de `tmp/essai/_outils/brief-A.md`, avec le fichier de question en plus) :
```markdown
{{DEMANDE}}

---

Tu travailles dans le dépôt {{CLONE}}, et seulement là.

- Pour lire, reste dans ce dossier. Seule exception : les pièces jointes citées plus haut. Ne lis rien d'autre sur la machine.
- N'utilise ni `raf` ni `cadence`. Ignore les parties du CLAUDE.md qui en parlent (plan, lots, vagues, Nouveautés imposées par l'outil). Pour le reste, suis les conventions du dépôt.
- Travaille comme une session Claude Code normale : lis le code, fais le changement, écris ou ajuste les tests, lance-les. Si le changement se voit à l'écran, lance l'app en local et regarde-la. Les captures vont dans {{CLONE}}.captures/, jamais dans le dépôt.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Tu reprendras avec sa réponse. Sinon, décide.
- Termine par un commit dans ce dépôt, sans `--no-verify`. Aucun push.
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
```

`v2/briefs/bras-equipe-legere.md` (le prototype du flux v2, spec §2.2 à §2.4) :
```markdown
{{DEMANDE}}

---

Tu es le responsable de cette demande, de bout en bout, dans le dépôt {{CLONE}}, et seulement là.

- Pour lire, reste dans ce dossier, sauf pour les pièces jointes citées plus haut. N'utilise ni `raf` ni `cadence`, et ignore les parties du CLAUDE.md qui en parlent.
- Fais le changement avec ses tests : écris d'abord le test qui échoue quand le comportement est testable. Lance la suite des fichiers touchés. Si le changement se voit à l'écran, lance l'app et regarde-la. Les captures vont dans {{CLONE}}.captures/.
- Si un point bloque vraiment et que la réponse est à Sylvain, écris ta question dans {{QUESTION}} et arrête-toi. Sinon, décide et note ton hypothèse dans le message de commit.
- Commite (sans `--no-verify`, aucun push).
- Relecture : lance UN sous-agent (outil Agent, subagent_type general-purpose, model opus). Donne-lui seulement le texte de la demande ci-dessus et la sortie de `git -C {{CLONE}} diff {{BASE}}..HEAD`. Consigne : « Ce diff fait-il ce qui est demandé, sans défaut ? Liste les défauts réels, classés bloquant / majeur / mineur, chacun avec fichier:ligne et un scénario d'échec concret. Aucun goût personnel. »
- Corrige les défauts bloquants et majeurs, relance les tests, commite. Deux tours de relecture au plus.
- Dis ensuite « fini », avec ce que tu as vérifié et ce que tu n'as pas vérifié.
```

- [ ] **Step 2 : Test qui échoue**

`v2/test/bras.test.ts` :
```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import { environnementNeutre, lancerBras, OUTILS_INTERDITS, type Executeur } from '../src/bench/bras.js';

function bancTest(reponses?: string): { b: Banc; clone: string } {
  const r = mkdtempSync(join(tmpdir(), 'bras-'));
  const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'demande.md'), 'Ajoute un séparateur.');
  if (reponses) writeFileSync(join(dir, 'reponses.md'), reponses);
  const clone = join(r, 'runs', 'x', '1-t', 'A'); mkdirSync(clone, { recursive: true });
  const b: Banc = { id: '1-t', dir, secrets: join(r, 'secrets', '1-t'), projet: 't', source: '/s', base: 'abc1234',
    install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: !!reponses };
  return { b, clone };
}
const json = (session: string, tokens: number, cout: number) => JSON.stringify({ session_id: session, total_cost_usd: cout,
  modelUsage: { 'claude-opus-5-5': { inputTokens: tokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });

describe('lancerBras', () => {
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');

  it('une session sans question : mesures, brief rempli, garde-fous passés à claude', () => {
    const { b, clone } = bancTest();
    const appels: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: Executeur = (args, o) => { appels.push({ args, env: o.env }); return { stdout: json('s1', 1000, 0.5), code: 0 }; };
    let t = 0; const horloge = () => new Date(Date.UTC(2026, 10, 8, 10, 0, t++ * 90));
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec, horloge);
    expect(m).toMatchObject({ bras: 'A', banc: '1-t', duree_s: 90, tokens: 1000, cout_usd: 0.5, questions: 0, sessions: ['s1'] });
    const a = appels[0].args;
    expect(a[a.indexOf('-p') + 1]).toContain('Ajoute un séparateur.');
    expect(a[a.indexOf('-p') + 1]).toContain(clone);
    expect(a[a.indexOf('-p') + 1]).not.toContain('{{');
    expect(a).toContain('--disallowedTools');
    expect(a[a.indexOf('--disallowedTools') + 1].split(',')).toEqual(OUTILS_INTERDITS);
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    expect(appels[0].env.KUBECONFIG).toBe('/nonexistent');
    expect(appels[0].env.GH_TOKEN).toBe('');
  });

  it('une question : réponse du banc, reprise de la même session, question comptée', () => {
    const { b, clone } = bancTest('Rotation seule.');
    const appels: string[][] = [];
    const exec: Executeur = (args) => {
      appels.push(args);
      if (appels.length === 1) writeFileSync(`${clone}.question.md`, 'Faut-il réorganiser ?');
      return { stdout: json('s1', 500, 0.1), code: 0 };
    };
    const m = lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec);
    expect(m.questions).toBe(1);
    expect(m.tokens).toBe(1000);
    expect(appels[1]).toEqual(expect.arrayContaining(['--resume', 's1']));
    expect(appels[1][appels[1].indexOf('-p') + 1]).toContain('Rotation seule.');
    expect(existsSync(`${clone}.question.md`)).toBe(false);
  });

  it('au-delà de 3 questions, on arrête', () => {
    const { b, clone } = bancTest();
    const exec: Executeur = () => { writeFileSync(`${clone}.question.md`, '?'); return { stdout: json('s', 1, 0), code: 0 }; };
    expect(lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, exec).questions).toBe(3);
  });

  it('sortie illisible : erreur avec la fin de la sortie', () => {
    const { b, clone } = bancTest();
    expect(() => lancerBras(b, { nom: 'A', modele: 'opus', brief }, clone, () => ({ stdout: 'boum', code: 1 }))).toThrow(/boum/);
  });

  it('environnement neutre : pas de kube, pas de jeton, pas de prod maritime', () => {
    const e = environnementNeutre({ HOME: '/h', KUBECONFIG: '/h/.kube/config', GH_TOKEN: 'x', GITHUB_TOKEN: 'y' });
    expect(e).toMatchObject({ HOME: '/h', KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', AETHERWX_URL: 'http://127.0.0.1:9' });
  });
});
```

- [ ] **Step 3 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/bras.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 4 : Écrire `v2/src/bench/bras.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lireDemande, type Banc } from './banc.js';

export interface DefBras { nom: string; modele: string; brief: string }
export interface Mesure { bras: string; banc: string; debut: string; fin: string; duree_s: number;
  tokens: number; cout_usd: number; questions: number; sessions: string[] }
export type Executeur = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { stdout: string; code: number };

export const OUTILS_INTERDITS = ['Bash(kubectl:*)', 'Bash(helm:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(git push:*)', 'Bash(npm publish:*)', 'Bash(raf:*)', 'Bash(cadence:*)'];
const QUESTIONS_MAX = 3;
const SANS_REPONSE = 'Pas de réponse de Sylvain : décide toi-même, note ton hypothèse dans le message de commit, et termine.';

export function chargerBras(racine: string): Record<string, DefBras> {
  const y = parse(readFileSync(join(racine, 'bras.yaml'), 'utf8')) as Record<string, { modele: string; brief: string }>;
  return Object.fromEntries(Object.entries(y).map(([nom, d]) => [nom, { nom, modele: d.modele, brief: d.brief }]));
}

export const environnementNeutre = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  ({ ...env, KUBECONFIG: '/nonexistent', GH_TOKEN: '', GITHUB_TOKEN: '', AETHERWX_URL: 'http://127.0.0.1:9' });

export const executeurClaude: Executeur = (args, o) => {
  const r = spawnSync('claude', args, { cwd: o.cwd, env: o.env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 4 * 3600_000 });
  return { stdout: r.stdout ?? '', code: r.status ?? 1 };
};

function lire(stdout: string): { session: string; tokens: number; cout: number } {
  try {
    const j = JSON.parse(stdout) as { session_id: string; total_cost_usd: number; modelUsage: Record<string, Record<string, number>> };
    const tokens = Object.values(j.modelUsage ?? {}).reduce((n, u) =>
      n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
    return { session: j.session_id, tokens, cout: j.total_cost_usd ?? 0 };
  } catch {
    throw new Error(`sortie de claude illisible : ${stdout.slice(-400)}`);
  }
}

export function lancerBras(b: Banc, d: DefBras, clone: string, exec: Executeur, horloge = () => new Date()): Mesure {
  const question = `${clone}.question.md`;
  const brief = readFileSync(d.brief, 'utf8').replaceAll('{{DEMANDE}}', lireDemande(b)).replaceAll('{{CLONE}}', clone)
    .replaceAll('{{QUESTION}}', question).replaceAll('{{BASE}}', b.base);
  const commun = ['--output-format', 'json', '--model', d.modele, '--permission-mode', 'bypassPermissions',
    '--disallowedTools', OUTILS_INTERDITS.join(',')];
  const o = { cwd: clone, env: environnementNeutre(process.env) };
  const reponse = b.reponses ? readFileSync(join(b.dir, 'reponses.md'), 'utf8') : SANS_REPONSE;
  const debut = horloge();
  let r = lire(exec(['-p', brief, ...commun], o).stdout);
  const m = { tokens: r.tokens, cout: r.cout, questions: 0, sessions: [r.session] };
  while (existsSync(question) && m.questions < QUESTIONS_MAX) {
    rmSync(question); m.questions++;
    r = lire(exec(['-p', `Réponse de Sylvain : ${reponse}`, '--resume', r.session, ...commun], o).stdout);
    m.tokens += r.tokens; m.cout += r.cout;
    if (!m.sessions.includes(r.session)) m.sessions.push(r.session);
  }
  const fin = horloge();
  return { bras: d.nom, banc: b.id, debut: debut.toISOString(), fin: fin.toISOString(),
    duree_s: Math.round((fin.getTime() - debut.getTime()) / 1000), tokens: m.tokens, cout_usd: m.cout, questions: m.questions, sessions: m.sessions };
}
```

- [ ] **Step 5 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/bras.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6 : Écrire `~/bench-cadence/bras.yaml`** (hors dépôt)

```yaml
A:
  modele: opus
  brief: /home/sylvain_ladoire/projects/developpeur/cadence/v2/briefs/bras-A.md
equipe-legere:
  modele: opus
  brief: /home/sylvain_ladoire/projects/developpeur/cadence/v2/briefs/bras-equipe-legere.md
```

- [ ] **Step 7 : Commit**

```bash
git add v2/src/bench/bras.ts v2/test/bras.test.ts v2/briefs/bras-A.md v2/briefs/bras-equipe-legere.md
git commit -m "v2(bench): lancement d'un bras par claude -p, mesures, questions, garde-fous prod

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5 : Contrôle des fuites

**Files:**
- Create: `v2/src/bench/fuites.ts`
- Test: `v2/test/fuites.test.ts`

**Interfaces:**
- Produces :
  ```ts
  interface Regles { autorises: string[]; interdits: string[] }   // préfixes absolus
  function dossierTranscripts(home: string, cwd: string): string    // ~/.claude/projects/<cwd, non-alphanumériques → '-'>
  function chercherFuites(lignes: string[], r: Regles, home: string): string[]   // chemins interdits lus, dédoublonnés
  function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles
  function fuitesDuBras(home: string, racine: string, banc: string, clone: string): string[]   // lit les .jsonl, sous-agents compris
  ```

- [ ] **Step 1 : Test qui échoue**

`v2/test/fuites.test.ts` :
```ts
import { describe, expect, it } from 'vitest';
import { chercherFuites, dossierTranscripts, reglesDuBras } from '../src/bench/fuites.js';

const H = '/home/u';
const appel = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
const r = reglesDuBras(H, `${H}/bench-cadence`, '1-t', `${H}/bench-cadence/runs/r1/1-t/A`);

describe('fuites', () => {
  it('lire son clone, les pièces du banc et ses propres sorties : permis', () => {
    const l = [appel({ command: `cat ${H}/bench-cadence/runs/r1/1-t/A/src/x.ts` }),
      appel({ file_path: `${H}/bench-cadence/bancs/1-t/pieces/maquette.png` }),
      appel({ file_path: `${dossierTranscripts(H, `${H}/bench-cadence/runs/r1/1-t/A`)}/s/tool-results/a.txt` })];
    expect(chercherFuites(l, r, H)).toEqual([]);
  });
  it('les secrets du banc, les vrais dépôts, les transcripts et les autres bras : interdits', () => {
    const l = [appel({ command: `cat ~/bench-cadence/secrets/1-t/attendu.md` }),
      appel({ file_path: `${H}/projects/developpeur/ol-companion/src/a.ts` }),
      appel({ command: `grep L239 ${H}/.claude/projects/-x/y.jsonl` }),
      appel({ command: `ls ${H}/bench-cadence/runs/r1/1-t/equipe-legere` })];
    expect(chercherFuites(l, r, H)).toEqual([
      `${H}/bench-cadence/secrets/1-t/attendu.md`, `${H}/projects/developpeur/ol-companion/src/a.ts`,
      `${H}/.claude/projects/-x/y.jsonl`, `${H}/bench-cadence/runs/r1/1-t/equipe-legere`]);
  });
  it('lignes illisibles ou sans outil : ignorées', () => {
    expect(chercherFuites(['pas du json', JSON.stringify({ type: 'user' })], r, H)).toEqual([]);
  });
  it('nom du dossier de transcripts de Claude Code', () => {
    expect(dossierTranscripts('/h', '/h/bench-cadence/runs/r_1/A')).toBe('/h/.claude/projects/-h-bench-cadence-runs-r-1-A');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/fuites.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/fuites.ts`**

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Regles { autorises: string[]; interdits: string[] }

export const dossierTranscripts = (home: string, cwd: string) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

export function reglesDuBras(home: string, racine: string, banc: string, clone: string): Regles {
  return {
    autorises: [clone, `${clone}.captures`, `${clone}.question.md`, join(racine, 'bancs', banc), dossierTranscripts(home, clone)],
    interdits: [join(racine, 'secrets'), join(racine, 'runs'), join(racine, 'bancs'), join(home, 'projects'), join(home, '.claude', 'projects')],
  };
}

function* textes(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* textes(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* textes(x);
}

const CHEMIN = /(?:~|\$HOME|\/home\/[^/\s'"`]+)(\/[^\s'"`;|&<>(){}]*)/g;
const sous = (p: string, prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

export function chercherFuites(lignes: string[], r: Regles, home: string): string[] {
  const vus = new Set<string>();
  for (const l of lignes) {
    let d: { type?: string; message?: { content?: { type: string; input?: unknown }[] } };
    try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      if (c.type !== 'tool_use') continue;
      for (const t of textes(c.input)) for (const m of t.matchAll(CHEMIN)) {
        const p = (m[0].startsWith('/home/') ? m[0] : home + m[1]).replace(/[.,:]+$/, '');
        if (sous(p, r.interdits) && !sous(p, r.autorises)) vus.add(p);
      }
    }
  }
  return [...vus];
}

function jsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? jsonl(p) : p.endsWith('.jsonl') ? [p] : [];
  });
}

export function fuitesDuBras(home: string, racine: string, banc: string, clone: string): string[] {
  const lignes = jsonl(dossierTranscripts(home, clone)).flatMap((f) => readFileSync(f, 'utf8').split('\n'));
  return chercherFuites(lignes, reglesDuBras(home, racine, banc, clone), home);
}
```

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/fuites.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5 : Commit**

```bash
git add v2/src/bench/fuites.ts v2/test/fuites.test.ts
git commit -m "v2(bench): contrôle des lectures interdites dans les transcripts d'un bras

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6 : Juges à l'aveugle (mécanique et relecture)

**Files:**
- Create: `v2/src/bench/juges.ts`, `v2/briefs/juge-mecanique.md`, `v2/briefs/juge-aveugle.md`
- Test: `v2/test/juges.test.ts`

**Interfaces:**
- Consumes : `Banc`, `lireDemande` (Task 2) ; `Executeur`, `environnementNeutre` (Task 4).
- Produces :
  ```ts
  interface Meca { suite_ok: boolean; caches_passes: number; caches_total: number; mutations_tuees: number; mutations_total: number;
    attendu: 'oui' | 'en partie' | 'non'; mutations: { ou: string; quoi: string; tuee: boolean }[] }
  interface Defauts { bloquants: number; majeurs: number; mineurs: number }
  interface Jugement { meca: Record<string, Meca>; defauts: Record<string, Defauts>; prefere: string; ui: string; raisons: string } // clés = noms de bras ; prefere/ui : nom de bras | 'egal' | 'na'
  function anonymiser(bras: [string, string], tirage: () => number): Record<'X' | 'Y', string>
  function validerMeca(o: unknown): string[]       // erreurs, [] si valide
  function validerAveugle(o: unknown): string[]
  function juger(b: Banc, clones: Record<string, string>, dirEval: string, modele: string, exec: Executeur, tirage?: () => number): Jugement | null  // null = non jugé
  ```

- [ ] **Step 1 : Écrire les briefs des juges**

`v2/briefs/juge-mecanique.md` :
```markdown
Tu évalues deux réalisations anonymes, X et Y, de la même demande. Tu ne sais pas qui les a faites et tu ne dois pas chercher à le savoir.

Demande : voir {{EVAL}}/demande.md. Critères et tests cachés : {{MESURE}} et {{SECRETS}}/tests-origine/. Copies jetables : {{EVAL}}/X et {{EVAL}}/Y (tu peux les modifier) ; diffs : {{EVAL}}/X.patch et {{EVAL}}/Y.patch.

Pour CHAQUE copie, avec exactement la même méthode pour les deux :
1. Suite du projet : `{{TESTS}}` ; suite_ok = code 0 (un test instable rejoué seul une fois, noté).
2. Tests cachés : copie les tests d'origine à côté des tests du bras, sous un autre nom (sans écraser). N'adapte que les sélecteurs ou les imports renommés, de la même façon pour X et Y, jamais une attente. Compte uniquement les cas que le lot d'origine a ajoutés ou modifiés.
3. Mutations : 8 à 15 mutations du code CHANGÉ par la copie (inverser une condition, changer une constante, supprimer un appel, décaler un indice). Joue les tests du bras pour chacune ; tuée = au moins un test rouge. Restaure après chaque mutation. Une à la fois, jamais en parallèle.
4. Attendu : oui / en partie / non, au sens de {{MESURE}}.

Écris UNIQUEMENT ce JSON dans {{SORTIE}}, rien d'autre :
{"X":{"suite_ok":true,"caches_passes":0,"caches_total":0,"mutations_tuees":0,"mutations_total":0,"attendu":"oui","mutations":[{"ou":"fichier:ligne","quoi":"avant → après","tuee":true}]},"Y":{…même forme…}}
```

`v2/briefs/juge-aveugle.md` :
```markdown
Tu relis deux réalisations anonymes, X et Y, de la même demande. Tu ne sais pas qui les a faites.

Demande : {{EVAL}}/demande.md. Attendu : {{SECRETS}}/attendu.md. Diffs : {{EVAL}}/X.patch et {{EVAL}}/Y.patch. Copies : {{EVAL}}/X et {{EVAL}}/Y.

Pour chacune : répond-elle à la demande ? Défauts réels uniquement, classés bloquant / majeur / mineur, chacun avec fichier:ligne et un scénario d'échec concret ; aucun goût personnel. Les tests protègent-ils le changement ? La maintenabilité est-elle bonne (doublons, code mort, conventions du dépôt) ?

{{ECRAN}}

Écris UNIQUEMENT ce JSON dans {{SORTIE}} :
{"X":{"bloquants":0,"majeurs":0,"mineurs":0},"Y":{"bloquants":0,"majeurs":0,"mineurs":0},"prefere":"X|Y|egal","ui":"X|Y|egal|na","raisons":"trois phrases au plus"}
```
Le juge reçoit `{{ECRAN}}` rempli ainsi pour un banc `visible` : « Lance l'app de chaque copie, l'une après l'autre, comme le dit {{MESURE}} (section Écran). Fais des captures à 1440 et à 390 px dans {{EVAL}}/captures-X et captures-Y, et regarde-les. ui = la copie dont l'écran est le plus cohérent avec le reste de l'application. » Pour un banc non visible : « Pas d'écran : ui = "na". »

- [ ] **Step 2 : Test qui échoue**

`v2/test/juges.test.ts` :
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Banc } from '../src/bench/banc.js';
import type { Executeur } from '../src/bench/bras.js';
import { anonymiser, juger, validerAveugle, validerMeca } from '../src/bench/juges.js';

const meca = { suite_ok: true, caches_passes: 2, caches_total: 2, mutations_tuees: 5, mutations_total: 6, attendu: 'oui', mutations: [] };
const aveugle = { X: { bloquants: 0, majeurs: 1, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 2 }, prefere: 'Y', ui: 'na', raisons: 'r' };

function decor(): { b: Banc; clones: Record<string, string>; dirEval: string } {
  const r = mkdtempSync(join(tmpdir(), 'juges-'));
  const dir = join(r, 'bancs', '1-t'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'demande.md'), 'd');
  const secrets = join(r, 'secrets', '1-t'); mkdirSync(secrets, { recursive: true }); writeFileSync(join(secrets, 'mesure.md'), 'm');
  const clones: Record<string, string> = {};
  for (const nom of ['A', 'cand']) {
    const c = join(r, 'runs', nom); mkdirSync(c, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: c });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: c });
    clones[nom] = c;
  }
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clones.A, encoding: 'utf8' }).trim();
  return { b: { id: '1-t', dir, secrets, projet: 't', source: '/s', base, install: 'true', tests: 'true', visible: false, taille: 'retouche', frais: false, reponses: false },
    clones, dirEval: join(r, 'runs', 'eval') };
}
/** Faux claude : écrit dans le fichier SORTIE du brief les JSON donnés, un par appel. */
function fauxJuge(sorties: object[]): Executeur {
  let i = 0;
  return (args) => {
    const p = args[args.indexOf('-p') + 1];
    const m = /dans (\S+\.json)/.exec(p);
    writeFileSync(m![1], JSON.stringify(sorties[i++] ?? {}));
    return { stdout: JSON.stringify({ session_id: `j${i}`, total_cost_usd: 0, modelUsage: {} }), code: 0 };
  };
}

describe('juges', () => {
  it('anonymise selon le tirage', () => {
    expect(anonymiser(['A', 'cand'], () => 0.2)).toEqual({ X: 'A', Y: 'cand' });
    expect(anonymiser(['A', 'cand'], () => 0.8)).toEqual({ X: 'cand', Y: 'A' });
  });
  it('valide les JSON des juges', () => {
    expect(validerMeca({ X: meca, Y: meca })).toEqual([]);
    expect(validerMeca({ X: meca })).toEqual(['Y manquant']);
    expect(validerMeca({ X: { ...meca, caches_passes: 3 }, Y: meca })).toEqual(['X.caches_passes > caches_total']);
    expect(validerAveugle(aveugle)).toEqual([]);
    expect(validerAveugle({ ...aveugle, prefere: 'Z' })).toEqual(['prefere doit valoir X, Y ou egal']);
  });
  it('désanonymise le jugement (X = A, Y = cand)', () => {
    const { b, clones, dirEval } = decor();
    const j = juger(b, clones, dirEval, 'opus', fauxJuge([{ X: meca, Y: { ...meca, caches_passes: 1 } }, aveugle]), () => 0.2);
    expect(j!.meca.cand.caches_passes).toBe(1);
    expect(j!.defauts.A.majeurs).toBe(1);
    expect(j!.prefere).toBe('cand');
    expect(readFileSync(join(dirEval, 'demande.md'), 'utf8')).toBe('d');
  });
  it('JSON invalide deux fois : banc non jugé (null), jamais un vert par défaut', () => {
    const { b, clones, dirEval } = decor();
    expect(juger(b, clones, dirEval, 'opus', fauxJuge([{}, {}]), () => 0.2)).toBeNull();
  });
});
```

Le faux juge repère le fichier de sortie grâce à la consigne finale du brief (« … dans <chemin>.json »), où `{{SORTIE}}` est remplacé par le chemin.

- [ ] **Step 3 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/juges.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 4 : Écrire `v2/src/bench/juges.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lireDemande, type Banc } from './banc.js';
import { environnementNeutre, type Executeur } from './bras.js';

export interface Meca { suite_ok: boolean; caches_passes: number; caches_total: number; mutations_tuees: number; mutations_total: number;
  attendu: 'oui' | 'en partie' | 'non'; mutations: { ou: string; quoi: string; tuee: boolean }[] }
export interface Defauts { bloquants: number; majeurs: number; mineurs: number }
export interface Jugement { meca: Record<string, Meca>; defauts: Record<string, Defauts>; prefere: string; ui: string; raisons: string }

const BRIEFS = join(import.meta.dirname, '..', '..', 'briefs');
const HORS_DIFF = [':(exclude).cadence', ':(exclude)docs/plan', ':(exclude)cadence.yaml'];

export const anonymiser = (bras: [string, string], tirage: () => number): Record<'X' | 'Y', string> =>
  tirage() < 0.5 ? { X: bras[0], Y: bras[1] } : { X: bras[1], Y: bras[0] };

const entier = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

export function validerMeca(o: unknown): string[] {
  const e: string[] = [];
  for (const k of ['X', 'Y'] as const) {
    const m = (o as Record<string, Meca> | null)?.[k];
    if (!m) { e.push(`${k} manquant`); continue; }
    for (const f of ['caches_passes', 'caches_total', 'mutations_tuees', 'mutations_total'] as const) if (!entier(m[f])) e.push(`${k}.${f} n'est pas un entier ≥ 0`);
    if (m.caches_passes > m.caches_total) e.push(`${k}.caches_passes > caches_total`);
    if (m.mutations_tuees > m.mutations_total) e.push(`${k}.mutations_tuees > mutations_total`);
    if (typeof m.suite_ok !== 'boolean') e.push(`${k}.suite_ok n'est pas un booléen`);
    if (!['oui', 'en partie', 'non'].includes(m.attendu)) e.push(`${k}.attendu doit valoir oui, en partie ou non`);
  }
  return e;
}

export function validerAveugle(o: unknown): string[] {
  const a = o as Record<string, unknown> | null; const e: string[] = [];
  for (const k of ['X', 'Y']) {
    const d = a?.[k] as Defauts | undefined;
    if (!d || !entier(d.bloquants) || !entier(d.majeurs) || !entier(d.mineurs)) e.push(`${k} : bloquants, majeurs, mineurs entiers attendus`);
  }
  if (!['X', 'Y', 'egal'].includes(a?.prefere as string)) e.push('prefere doit valoir X, Y ou egal');
  if (!['X', 'Y', 'egal', 'na'].includes(a?.ui as string)) e.push('ui doit valoir X, Y, egal ou na');
  return e;
}

function remplir(gabarit: string, v: Record<string, string>): string {
  return Object.entries(v).reduce((t, [k, x]) => t.replaceAll(`{{${k}}}`, x), readFileSync(join(BRIEFS, gabarit), 'utf8'));
}

/** Un juge : une session, une relance avec les erreurs si le JSON est invalide, puis null. */
function demander(brief: string, sortie: string, valider: (o: unknown) => string[], cwd: string, modele: string, exec: Executeur): unknown {
  const commun = ['--output-format', 'json', '--model', modele, '--permission-mode', 'bypassPermissions'];
  const o = { cwd, env: environnementNeutre(process.env) };
  let session = (JSON.parse(exec(['-p', brief, ...commun], o).stdout) as { session_id: string }).session_id;
  for (let essai = 0; essai < 2; essai++) {
    let res: unknown = null;
    try { res = JSON.parse(readFileSync(sortie, 'utf8')); } catch { /* absent ou illisible */ }
    const erreurs = res === null ? ['fichier absent ou JSON illisible'] : valider(res);
    if (erreurs.length === 0) return res;
    if (essai === 1) return null;
    session = (JSON.parse(exec(['-p', `Ton JSON dans ${sortie} est invalide : ${erreurs.join(' ; ')}. Réécris-le, rien d'autre.`, '--resume', session, ...commun], o).stdout) as { session_id: string }).session_id;
  }
  return null;
}

export function juger(b: Banc, clones: Record<string, string>, dirEval: string, modele: string, exec: Executeur, tirage = Math.random): Jugement | null {
  const noms = Object.keys(clones) as [string, string];
  const anon = anonymiser(noms, tirage);
  rmSync(dirEval, { recursive: true, force: true }); mkdirSync(dirEval, { recursive: true });
  writeFileSync(join(dirEval, 'demande.md'), lireDemande(b));
  for (const k of ['X', 'Y'] as const) {
    cpSync(clones[anon[k]], join(dirEval, k), { recursive: true });
    writeFileSync(join(dirEval, `${k}.patch`), execFileSync('git', ['diff', `${b.base}..HEAD`, '--', '.', ...HORS_DIFF], { cwd: clones[anon[k]], encoding: 'utf8', maxBuffer: 256 << 20 }));
  }
  const v = { EVAL: dirEval, SECRETS: b.secrets, MESURE: join(b.secrets, 'mesure.md'), TESTS: b.tests };
  const sMeca = join(dirEval, 'meca.json');
  const meca = demander(remplir('juge-mecanique.md', { ...v, SORTIE: sMeca }), sMeca, validerMeca, dirEval, modele, exec) as Record<'X' | 'Y', Meca> | null;
  const ecran = b.visible
    ? `Lance l'app de chaque copie, l'une après l'autre, comme le dit ${v.MESURE} (section Écran). Fais des captures à 1440 et à 390 px dans ${dirEval}/captures-X et captures-Y, et regarde-les. ui = la copie dont l'écran est le plus cohérent avec le reste de l'application.`
    : 'Pas d\'écran : ui = "na".';
  const sAv = join(dirEval, 'aveugle.json');
  const av = demander(remplir('juge-aveugle.md', { ...v, ECRAN: ecran, SORTIE: sAv }), sAv, validerAveugle, dirEval, modele, exec) as
    { X: Defauts; Y: Defauts; prefere: string; ui: string; raisons: string } | null;
  if (!meca || !av) return null;
  const nom = (x: string) => (x === 'X' || x === 'Y' ? anon[x] : x);
  for (const k of ['X', 'Y'] as const) if (existsSync(join(dirEval, k))) rmSync(join(dirEval, k), { recursive: true, force: true });
  return {
    meca: { [anon.X]: meca.X, [anon.Y]: meca.Y }, defauts: { [anon.X]: av.X, [anon.Y]: av.Y },
    prefere: nom(av.prefere), ui: nom(av.ui), raisons: av.raisons,
  };
}
```

Les deux briefs (Step 1) finissent par « Écris UNIQUEMENT ce JSON dans {{SORTIE}} … » : c'est la forme que lit le faux juge du test.

- [ ] **Step 5 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/juges.test.ts`
Expected: PASS (4 tests). Si le faux juge ne trouve pas le chemin, ajuster sa regex au texte réel du brief, pas le brief au test.

- [ ] **Step 6 : Commit**

```bash
git add v2/src/bench/juges.ts v2/test/juges.test.ts v2/briefs/juge-mecanique.md v2/briefs/juge-aveugle.md
git commit -m "v2(bench): juges mécanique et aveugle, anonymisation X/Y, JSON validé ou banc non jugé

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7 : Barre, verdict, rapport et historique (fonctions pures)

**Files:**
- Create: `v2/src/bench/verdict.ts`
- Test: `v2/test/verdict.test.ts`

**Interfaces:**
- Consumes : `Mesure` (Task 4), `Jugement` (Task 6), `Taille` (Task 2).
- Produces :
  ```ts
  interface ResultatBanc { banc: string; taille: Taille; visible: boolean; reponses: boolean; frais: boolean;
    mesures: Record<string, Mesure>; jugement: Jugement | null; fuites: Record<string, string[]> }
  interface Barre { temps_max: number; temps_max_retouche: number; reference_absolue: { caches: number; mutations: number } }
  interface Critere { nom: string; valeur: string; seuil: string; ok: boolean; bloquant: boolean }
  interface Verdict { vert: boolean; criteres: Critere[] }
  const BARRE_SPEC: Barre    // { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 304, mutations: 0.79 } }
  function verdict(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict
  function rapport(res: ResultatBanc[], ref: string, cand: string, v: Verdict, entete: { date: string; empreinte: string }): string  // markdown
  function ligneHistorique(v: Verdict, e: { date: string; empreinte: string; candidat: string; bancs: string[]; hebdo: boolean; frais: number }): string // JSON une ligne
  function statut(historique: string[], maintenant: Date, empreinte: string): { dernier?: string; banc_du_weekend: boolean; publication_ok: boolean; frais_semaine: number }
  ```

- [ ] **Step 1 : Test qui échoue**

`v2/test/verdict.test.ts` :
```ts
import { describe, expect, it } from 'vitest';
import type { Mesure } from '../src/bench/bras.js';
import type { Jugement, Meca } from '../src/bench/juges.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc } from '../src/bench/verdict.js';

const mes = (bras: string, duree_s: number, questions = 0): Mesure =>
  ({ bras, banc: 'b', debut: '', fin: '', duree_s, tokens: 1000, cout_usd: 1, questions, sessions: [] });
const meca = (p: number, t: number): Meca => ({ suite_ok: true, caches_passes: p, caches_total: 10, mutations_tuees: t, mutations_total: 10, attendu: 'oui', mutations: [] });
function banc(o: Partial<{ dA: number; dC: number; cA: number; cC: number; mA: number; mC: number; majA: number; majC: number; pref: string; ui: string;
  taille: 'retouche' | 'fonction'; qC: number; reponses: boolean; fuiteC: string[]; nonJuge: boolean }> = {}): ResultatBanc {
  const j: Jugement = { meca: { A: meca(o.cA ?? 8, o.mA ?? 8), C: meca(o.cC ?? 8, o.mC ?? 8) },
    defauts: { A: { bloquants: 0, majeurs: o.majA ?? 0, mineurs: 0 }, C: { bloquants: 0, majeurs: o.majC ?? 0, mineurs: 0 } },
    prefere: o.pref ?? 'egal', ui: o.ui ?? 'na', raisons: '' };
  return { banc: 'b', taille: o.taille ?? 'fonction', visible: false, reponses: o.reponses ?? false, frais: false,
    mesures: { A: mes('A', o.dA ?? 100), C: mes('C', o.dC ?? 100, o.qC ?? 0) },
    jugement: o.nonJuge ? null : j, fuites: { A: [], C: o.fuiteC ?? [] } };
}
const rouges = (r: ResultatBanc[]) => verdict(r, 'A', 'C', BARRE_SPEC).criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom);

describe('verdict', () => {
  it('égalité partout : vert', () => expect(verdict([banc(), banc()], 'A', 'C', BARRE_SPEC).vert).toBe(true));
  it('temps 1,6 × A : rouge sur le temps', () => expect(rouges([banc({ dC: 160 })])).toEqual(['temps total']));
  it('retouche à 1,3 × A : rouge sur les retouches', () => expect(rouges([banc({ taille: 'retouche', dC: 130 }), banc({ dA: 1000, dC: 900 })])).toEqual(['temps des retouches']));
  it('A préféré sur la majorité : rouge', () => expect(rouges([banc({ pref: 'A' }), banc({ pref: 'A' }), banc({ pref: 'C' })])).toEqual(['relecture aveugle']));
  it('moins de tests cachés ou de mutations tuées : rouge', () => {
    expect(rouges([banc({ cC: 7 })])).toEqual(['tests cachés']);
    expect(rouges([banc({ mC: 7 })])).toEqual(['mutations tuées']);
  });
  it('plus de défauts bloquants + majeurs : rouge', () => expect(rouges([banc({ majC: 1 })])).toEqual(['défauts bloquants et majeurs']));
  it('UI : A plus souvent préféré que le candidat : rouge', () => expect(rouges([banc({ ui: 'A' })])).toEqual(['cohérence UI']));
  it('question sur un banc sans vraie décision : rouge ; avec réponses.md : permis', () => {
    expect(rouges([banc({ qC: 1 })])).toEqual(['questions inutiles']);
    expect(rouges([banc({ qC: 1, reponses: true })])).toEqual([]);
  });
  it('fuite du candidat : rouge', () => expect(rouges([banc({ fuiteC: ['/h/projects/x'] })])).toEqual(['aucune fuite']));
  it('banc non jugé : rouge, jamais vert par défaut', () => expect(rouges([banc({ nonJuge: true })])).toEqual(['tous les bancs jugés']));
  it('les chiffres absolus du 07-11 sont affichés sans bloquer', () => {
    const v = verdict([banc()], 'A', 'C', BARRE_SPEC);
    expect(v.criteres.find((c) => c.nom === 'tests cachés (07-11 : 304)')).toMatchObject({ ok: false, bloquant: false });
    expect(v.vert).toBe(true);
  });
});

describe('rapport, historique, statut', () => {
  it('le rapport dit le verdict et nomme les critères rouges', () => {
    const r = [banc({ dC: 160 })];
    const md = rapport(r, 'A', 'C', verdict(r, 'A', 'C', BARRE_SPEC), { date: '2026-11-08', empreinte: 'abc' });
    expect(md).toMatch(/ROUGE/);
    expect(md).toMatch(/temps total/);
  });
  const h = (date: string, vert: boolean, empreinte = 'e1', hebdo = true) =>
    ligneHistorique({ vert, criteres: [] }, { date, empreinte, candidat: 'C', bancs: ['1'], hebdo, frais: 0 });
  it('lundi sans passage depuis samedi : banc du weekend manquant', () => {
    const s = statut([h('2026-11-06T10:00:00Z', true)], new Date('2026-11-09T08:00:00Z'), 'e1');
    expect(s.banc_du_weekend).toBe(false);
  });
  it('passage samedi : banc du weekend fait ; publication seulement si vert sur la même empreinte', () => {
    const s = statut([h('2026-11-07T10:00:00Z', true, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e1');
    expect(s).toMatchObject({ banc_du_weekend: true, publication_ok: true });
    expect(statut([h('2026-11-07T10:00:00Z', true, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e2').publication_ok).toBe(false);
    expect(statut([h('2026-11-07T10:00:00Z', false, 'e1')], new Date('2026-11-09T08:00:00Z'), 'e1').publication_ok).toBe(false);
  });
  it('un banc court le samedi ne compte pas comme banc du weekend', () => {
    expect(statut([h('2026-11-07T10:00:00Z', true, 'e1', false)], new Date('2026-11-09T08:00:00Z'), 'e1').banc_du_weekend).toBe(false);
  });
  it('en plein weekend, avant le passage : pas encore manquant', () => {
    expect(statut([], new Date('2026-11-08T08:00:00Z'), 'e1').banc_du_weekend).toBe(true);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/verdict.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/verdict.ts`**

```ts
import type { Taille } from './banc.js';
import type { Mesure } from './bras.js';
import type { Jugement } from './juges.js';

export interface ResultatBanc { banc: string; taille: Taille; visible: boolean; reponses: boolean; frais: boolean;
  mesures: Record<string, Mesure>; jugement: Jugement | null; fuites: Record<string, string[]> }
export interface Barre { temps_max: number; temps_max_retouche: number; reference_absolue: { caches: number; mutations: number } }
export interface Critere { nom: string; valeur: string; seuil: string; ok: boolean; bloquant: boolean }
export interface Verdict { vert: boolean; criteres: Critere[] }

export const BARRE_SPEC: Barre = { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 304, mutations: 0.79 } };

const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${Math.round(x * 100)} %`;

export function verdict(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict {
  const jug = res.filter((r) => r.jugement).map((r) => r.jugement!);
  const t = (rs: ResultatBanc[], b: string) => somme(rs.map((r) => r.mesures[b]?.duree_s ?? 0));
  const ret = res.filter((r) => r.taille === 'retouche');
  const caches = (b: string) => somme(jug.map((j) => j.meca[b].caches_passes));
  const mut = (b: string) => somme(jug.map((j) => j.meca[b].mutations_tuees)) / Math.max(1, somme(jug.map((j) => j.meca[b].mutations_total)));
  const def = (b: string) => somme(jug.map((j) => j.defauts[b].bloquants + j.defauts[b].majeurs));
  const prefCand = jug.filter((j) => j.prefere !== ref).length;
  const ui = (b: string) => jug.filter((j) => j.ui === b).length;
  const inutiles = somme(res.filter((r) => !r.reponses).map((r) => r.mesures[cand]?.questions ?? 0));
  const fuites = res.flatMap((r) => r.fuites[cand] ?? []);
  const c = (nom: string, valeur: string, seuil: string, ok: boolean, bloquant = true): Critere => ({ nom, valeur, seuil, ok, bloquant });
  const criteres: Critere[] = [
    c('tous les bancs jugés', `${jug.length}/${res.length}`, 'tous', jug.length === res.length),
    c('aucune fuite', `${fuites.length}`, '0', fuites.length === 0),
    c('relecture aveugle', `${prefCand}/${jug.length} sans préférence pour ${ref}`, '> la moitié', prefCand * 2 > jug.length),
    c('tests cachés', `${caches(cand)} contre ${caches(ref)}`, `≥ ${ref}`, caches(cand) >= caches(ref)),
    c('mutations tuées', `${pct(mut(cand))} contre ${pct(mut(ref))}`, `≥ ${ref}`, mut(cand) >= mut(ref)),
    c('défauts bloquants et majeurs', `${def(cand)} contre ${def(ref)}`, `≤ ${ref}`, def(cand) <= def(ref)),
    c('cohérence UI', `${ui(cand)} contre ${ui(ref)}`, `≥ ${ref}`, ui(cand) >= ui(ref)),
    c('temps total', `${t(res, cand)} s contre ${t(res, ref)} s`, `≤ ${barre.temps_max} × ${ref}`, t(res, cand) <= barre.temps_max * t(res, ref)),
    c('temps des retouches', `${t(ret, cand)} s contre ${t(ret, ref)} s`, `≤ ${barre.temps_max_retouche} × ${ref}`, t(ret, cand) <= barre.temps_max_retouche * t(ret, ref)),
    c('questions inutiles', `${inutiles}`, '0', inutiles === 0),
    c(`tests cachés (07-11 : ${barre.reference_absolue.caches})`, `${caches(cand)}`, `≥ ${barre.reference_absolue.caches}`, caches(cand) >= barre.reference_absolue.caches, false),
    c(`mutations (07-11 : ${pct(barre.reference_absolue.mutations)})`, pct(mut(cand)), `≥ ${pct(barre.reference_absolue.mutations)}`, mut(cand) >= barre.reference_absolue.mutations, false),
  ];
  return { vert: criteres.every((x) => x.ok || !x.bloquant), criteres };
}

export function rapport(res: ResultatBanc[], ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string }): string {
  const lignes = res.map((r) => {
    const j = r.jugement; const m = (b: string) => r.mesures[b];
    return `| ${r.banc} | ${m(ref)?.duree_s ?? '–'} s | ${m(cand)?.duree_s ?? '–'} s | ${m(ref)?.tokens ?? '–'} | ${m(cand)?.tokens ?? '–'} | ${j?.prefere ?? 'non jugé'} | ${j ? `${j.meca[ref].caches_passes} · ${j.meca[cand].caches_passes}` : '–'} | ${j ? `${j.meca[ref].mutations_tuees}/${j.meca[ref].mutations_total} · ${j.meca[cand].mutations_tuees}/${j.meca[cand].mutations_total}` : '–'} |`;
  });
  return [`# Banc ${e.date} — ${cand} contre ${ref} — ${v.vert ? 'VERT' : 'ROUGE'}`, '', `Empreinte de v2 : ${e.empreinte}`, '',
    `| Banc | Temps ${ref} | Temps ${cand} | Tokens ${ref} | Tokens ${cand} | Préféré | Cachés ${ref} · ${cand} | Mutations ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|', ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((c) => `| ${c.nom} | ${c.valeur} | ${c.seuil} | ${c.ok ? 'ok' : c.bloquant ? '**ROUGE**' : 'en dessous (indicatif)'} |`), ''].join('\n');
}

export const ligneHistorique = (v: Verdict, e: { date: string; empreinte: string; candidat: string; bancs: string[]; hebdo: boolean; frais: number }) =>
  JSON.stringify({ ...e, vert: v.vert, rouges: v.criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom) });

/** Samedi 00:00 UTC de la semaine du banc : le samedi passé, ou aujourd'hui si on est samedi. */
function samediCourant(d: Date): Date {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  s.setUTCDate(s.getUTCDate() - ((s.getUTCDay() + 1) % 7));
  return s;
}

export function statut(historique: string[], maintenant: Date, empreinte: string) {
  const h = historique.filter(Boolean).map((l) => JSON.parse(l) as { date: string; empreinte: string; vert: boolean; hebdo: boolean; frais: number });
  const sam = samediCourant(maintenant);
  const enWeekend = [6, 0].includes(maintenant.getUTCDay());
  const depuisSamedi = h.filter((x) => new Date(x.date) >= sam);
  const dernier = h.at(-1);
  return {
    dernier: dernier ? `${dernier.date} ${dernier.vert ? 'vert' : 'rouge'} (${dernier.empreinte})` : undefined,
    banc_du_weekend: enWeekend || depuisSamedi.some((x) => x.hebdo),
    publication_ok: h.some((x) => x.vert && x.empreinte === empreinte),
    frais_semaine: somme(depuisSamedi.map((x) => x.frais ?? 0)),
  };
}
```

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run test/verdict.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5 : Commit**

```bash
git add v2/src/bench/verdict.ts v2/test/verdict.test.ts
git commit -m "v2(bench): barre de la spec, verdict, rapport, historique et statut du weekend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8 : Orchestration `cadence2 bench`

**Files:**
- Create: `v2/src/bench/cli.ts`
- Modify: `v2/src/cli.ts` (enregistrer `bench`)
- Test: `v2/test/bench-cli.test.ts`

**Interfaces:**
- Consumes : toutes les fonctions des Tasks 2 à 7.
- Produces :
  ```ts
  function empreinte(repo: string): string            // sha1 des arbres git HEAD:v2/src, HEAD:v2/briefs, sur 12 caractères
  function passage(o: { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string;
    exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void }): Verdict
  async function bench(args: string[], io: Io): Promise<number>
  ```
  Sous-commandes :
  - `court [--candidat c]` : bancs 1, 3 et 6 ;
  - `hebdo [--candidat c]` : tous les bancs ;
  - `lancer --bancs 1,3 [--candidat c] [--reference r]` ;
  - `statut` (code 1 si le banc du weekend manque) ;
  - `verifier-publication` (code 0 seulement s'il existe un passage vert sur l'empreinte courante).

  Le candidat par défaut est `equipe-legere`, la référence `A`, le juge `opus`.

- [ ] **Step 1 : Test qui échoue**

`v2/test/bench-cli.test.ts` :
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executeur } from '../src/bench/bras.js';
import { passage } from '../src/bench/cli.js';

const meca = { suite_ok: true, caches_passes: 1, caches_total: 1, mutations_tuees: 1, mutations_total: 1, attendu: 'oui', mutations: [] };
function racine(): string {
  const r = mkdtempSync(join(tmpdir(), 'bench-'));
  for (const id of ['1-a', '2-b']) {
    mkdirSync(join(r, 'bancs', id), { recursive: true }); mkdirSync(join(r, 'secrets', id), { recursive: true });
    writeFileSync(join(r, 'bancs', id, 'banc.yaml'), 'projet: p\nsource: /s\nbase: HEAD\ninstall: "true"\ntests: "true"\ntaille: fonction\n');
    writeFileSync(join(r, 'bancs', id, 'demande.md'), 'd'); writeFileSync(join(r, 'secrets', id, 'mesure.md'), 'm');
  }
  const brief = join(import.meta.dirname, '..', 'briefs', 'bras-A.md');
  writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: ${brief}\nC:\n  modele: opus\n  brief: ${brief}\n`);
  return r;
}
/** Faux claude : un bras répond tout de suite ; un juge écrit un JSON valide dans le fichier demandé. */
const exec: Executeur = (args) => {
  const p = args[args.indexOf('-p') + 1];
  const m = /dans (\S+\.json)/.exec(p);
  if (m) writeFileSync(m[1], JSON.stringify(m[1].endsWith('meca.json') ? { X: meca, Y: meca }
    : { X: { bloquants: 0, majeurs: 0, mineurs: 0 }, Y: { bloquants: 0, majeurs: 0, mineurs: 0 }, prefere: 'egal', ui: 'na', raisons: '' }));
  return { stdout: JSON.stringify({ session_id: 's', total_cost_usd: 0, modelUsage: {} }), code: 0 };
};
const prep = (_b: unknown, cible: string) => {
  mkdirSync(cible, { recursive: true });
  execFileSync('bash', ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base'], { cwd: cible });
  return { testsBase: 0 };
};

describe('passage du banc', () => {
  it('joue les bras un banc après l\'autre, ordre alterné, et écrit rapport et historique', () => {
    const r = racine(); const ordre: string[] = [];
    const exec2: Executeur = (args, o) => { if (!args.includes('--resume') && !/dans \S+\.json/.test(args[args.indexOf('-p') + 1])) ordre.push(o.cwd.split('/').slice(-2).join('/')); return exec(args, o); };
    const v = passage({ racine: r, ref: 'A', cand: 'C', hebdo: false, juge: 'opus', exec: exec2, prep: prep as never,
      maintenant: new Date('2026-11-08T10:00:00Z'), empreinte: 'e1', home: r, out: () => {} });
    expect(v.vert).toBe(true);
    expect(ordre).toEqual(['1-a/A', '1-a/C', '2-b/C', '2-b/A']);
    expect(readdirSync(join(r, 'rapports')).sort()).toEqual(['2026-11-08-e1.json', '2026-11-08-e1.md']);
    expect(JSON.parse(readFileSync(join(r, 'historique.jsonl'), 'utf8').trim())).toMatchObject({ empreinte: 'e1', vert: true, hebdo: false });
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/bench-cli.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/cli.ts`**

```ts
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../cli.js';
import { listerBancs, racineBanc } from './banc.js';
import { chargerBras, executeurClaude, lancerBras, type Executeur, type Mesure } from './bras.js';
import { fuitesDuBras } from './fuites.js';
import { juger } from './juges.js';
import { preparer } from './preparer.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc, type Verdict } from './verdict.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COURT = ['1', '3', '6'];

export function empreinte(repo: string): string {
  const arbres = ['v2/src', 'v2/briefs'].map((p) => execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: repo, encoding: 'utf8' }).trim());
  return createHash('sha1').update(arbres.join('\n')).digest('hex').slice(0, 12);
}

export function passage(o: { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void }): Verdict {
  const date = o.maintenant.toISOString().slice(0, 10);
  const dirRun = join(o.racine, 'runs', `${date}-${o.empreinte}`);
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const res: ResultatBanc[] = listerBancs(o.racine, o.numeros).map((b, i) => {
    const ordre = i % 2 === 0 ? [o.ref, o.cand] : [o.cand, o.ref];
    const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {};
    for (const n of ordre) {
      clones[n] = join(dirRun, b.id, n);
      o.prep(b, clones[n]);
      o.out(`${b.id} : bras ${n}…`);
      mesures[n] = lancerBras(b, bras[n], clones[n], o.exec);
      fuites[n] = fuitesDuBras(o.home, o.racine, b.id, clones[n]);
    }
    o.out(`${b.id} : juges…`);
    const jugement = juger(b, clones, join(dirRun, b.id, 'eval'), o.juge, o.exec);
    const r: ResultatBanc = { banc: b.id, taille: b.taille, visible: b.visible, reponses: b.reponses, frais: b.frais, mesures, jugement, fuites };
    writeFileSync(join(dirRun, b.id, 'resultat.json'), JSON.stringify(r, null, 2));
    return r;
  });
  const v = verdict(res, o.ref, o.cand, BARRE_SPEC);
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', `${date}-${o.empreinte}`);
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultats: res }, null, 2));
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: res.filter((r) => r.frais).length })}\n`);
  o.out(`${v.vert ? 'VERT' : 'ROUGE'} — rapport : ${base}.md`);
  return v;
}

function option(args: string[], nom: string): string | undefined {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function bench(args: string[], io: Io): Promise<number> {
  const [sous, ...reste] = args;
  const racine = racineBanc(io.env);
  const emp = empreinte(REPO);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
  if (sous === 'statut') {
    const s = statut(hist, io.now(), emp);
    io.out(`banc : dernier passage ${s.dernier ?? 'aucun'} ; publication ${s.publication_ok ? 'permise' : 'refusée'} sur l'empreinte ${emp}`);
    if (!s.banc_du_weekend) io.out('⚠ BANC DU WEEKEND MANQUANT : lancer « cadence2 bench hebdo » avant toute publication');
    if (s.frais_semaine === 0) io.out('⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »');
    return s.banc_du_weekend ? 0 : 1;
  }
  if (sous === 'verifier-publication') {
    const ok = statut(hist, io.now(), emp).publication_ok;
    io.out(ok ? `banc vert sur l'empreinte ${emp}` : `aucun banc vert sur l'empreinte ${emp} : lancer « cadence2 bench court »`);
    return ok ? 0 : 1;
  }
  const numeros = sous === 'court' ? COURT : sous === 'hebdo' ? undefined : sous === 'lancer' ? option(reste, 'bancs')?.split(',') : null;
  if (numeros === null) { io.err('usage : cadence2 bench court|hebdo|lancer --bancs 1,3|statut|verifier-publication|ajouter [--candidat c] [--reference r]'); return 2; }
  const v = passage({ racine, numeros, ref: option(reste, 'reference') ?? 'A', cand: option(reste, 'candidat') ?? 'equipe-legere',
    hebdo: sous === 'hebdo', juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out });
  return v.vert ? 0 : 1;
}
```

Ajouter dans `v2/src/cli.ts`, sous la déclaration de `COMMANDES` :
```ts
import { bench } from './bench/cli.js';
COMMANDES.bench = bench;
```
L'`import` va en tête de fichier.

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected : PASS sur toute la suite v2. Le test de budget doit afficher `bench` ≤ 750. S'il dépasse, réduire le code ; ne jamais relever le budget dans cette tâche.

- [ ] **Step 5 : Installer la commande et la sonder**

Run: `cd v2 && npm run build && npm link && cadence2 bench statut; echo rc=$?`
Expected : « dernier passage aucun ; publication refusée », puis l'avertissement du banc manquant, et `rc=1`. Le samedi et le dimanche, la sortie est `rc=0`.

- [ ] **Step 6 : Commit**

```bash
git add v2/src/bench/cli.ts v2/src/cli.ts v2/test/bench-cli.test.ts
git commit -m "v2(bench): cadence2 bench court|hebdo|lancer|statut|verifier-publication

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9 : Bancs frais à partir d'un lot livré

**Files:**
- Create: `v2/src/bench/ajouter.ts`
- Modify: `v2/src/bench/cli.ts` (sous-commande `ajouter`)
- Test: `v2/test/ajouter.test.ts`

**Interfaces:**
- Consumes : `racineBanc` (Task 2).
- Produces : `function ajouterBanc(o: { racine: string; projetDir: string; lot: string; demande: string; install: string; tests: string; taille: Taille; visible: boolean }): string`. Elle renvoie l'id du banc, au format `<n+1>-<projet>-<lot>`. Elle écrit `banc.yaml` avec `frais: true`, `demande.md`, et dans les secrets `tests-origine/`, `diff-origine.patch` et `mesure.md`. Elle lève une erreur si aucun commit ne cite le lot.

- [ ] **Step 1 : Test qui échoue**

`v2/test/ajouter.test.ts` :
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ajouterBanc } from '../src/bench/ajouter.js';
import { chargerBanc } from '../src/bench/banc.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

describe('ajouterBanc', () => {
  it('base = parent du premier commit du lot ; tests du lot mis au secret', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'proj-')), 'ol'); mkdirSync(join(p, 'src'), { recursive: true });
    git(mkdtempSync(join(tmpdir(), 'x-')), 'init', '-q', '-b', 'main', p);
    writeFileSync(join(p, 'src', 'a.ts'), '1'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'départ');
    const base = git(p, 'rev-parse', 'HEAD');
    writeFileSync(join(p, 'src', 'a.ts'), '2'); writeFileSync(join(p, 'src', 'a.test.ts'), 'test'); git(p, 'add', '.'); git(p, 'commit', '-qm', 'feat(L900): séparateur');
    writeFileSync(join(p, 'src', 'a.ts'), '3'); git(p, 'commit', '-qam', 'fix(L900): marge');
    const r = mkdtempSync(join(tmpdir(), 'bench-')); mkdirSync(join(r, 'bancs', '8-x'), { recursive: true });
    const id = ajouterBanc({ racine: r, projetDir: p, lot: 'L900', demande: 'mets un trait', install: 'true', tests: 'true', taille: 'retouche', visible: true });
    expect(id).toBe('9-ol-L900');
    const b = chargerBanc(r, id);
    expect(b).toMatchObject({ base, frais: true, taille: 'retouche', source: p });
    expect(readFileSync(join(b.secrets, 'tests-origine', 'src', 'a.test.ts'), 'utf8')).toBe('test');
    expect(readFileSync(join(b.secrets, 'diff-origine.patch'), 'utf8')).toMatch(/marge/);
    expect(existsSync(join(b.secrets, 'mesure.md'))).toBe(true);
  });
  it('lot sans commit : erreur', () => {
    const p = mkdtempSync(join(tmpdir(), 'proj-')); git(p, 'init', '-q', '-b', 'main'); git(p, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(() => ajouterBanc({ racine: mkdtempSync(join(tmpdir(), 'b-')), projetDir: p, lot: 'L1', demande: 'd', install: 'true', tests: 'true', taille: 'fonction', visible: false }))
      .toThrow(/aucun commit/);
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `cd v2 && npx vitest run test/ajouter.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3 : Écrire `v2/src/bench/ajouter.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { Taille } from './banc.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }).trim();

export function ajouterBanc(o: { racine: string; projetDir: string; lot: string; demande: string; install: string; tests: string; taille: Taille; visible: boolean }): string {
  const commits = git(o.projetDir, 'log', '--reverse', '--format=%H', '-E', `--grep=\\b${o.lot}\\b`).split('\n').filter(Boolean);
  if (commits.length === 0) throw new Error(`lot ${o.lot} : aucun commit ne le cite dans ${o.projetDir}`);
  const base = git(o.projetDir, 'rev-parse', `${commits[0]}^`);
  const dirBancs = join(o.racine, 'bancs');
  const n = 1 + Math.max(0, ...(existsSync(dirBancs) ? readdirSync(dirBancs) : []).map((id) => Number(id.split('-')[0]) || 0));
  const id = `${n}-${basename(o.projetDir)}-${o.lot}`;
  const dir = join(dirBancs, id); const secrets = join(o.racine, 'secrets', id);
  mkdirSync(dir, { recursive: true }); mkdirSync(join(secrets, 'tests-origine'), { recursive: true });
  writeFileSync(join(dir, 'banc.yaml'), stringify({ projet: basename(o.projetDir), source: o.projetDir, base, install: o.install, tests: o.tests,
    visible: o.visible, taille: o.taille, frais: true }));
  writeFileSync(join(dir, 'demande.md'), `${o.demande.trim()}\n`);
  const dernier = commits.at(-1)!;
  writeFileSync(join(secrets, 'diff-origine.patch'), commits.map((c) => git(o.projetDir, 'show', '--format=### %h %s', c)).join('\n'));
  const fichiers = new Set(commits.flatMap((c) => git(o.projetDir, 'show', '--name-only', '--format=', c).split('\n'))
    .filter((f) => /(test|spec)/.test(f) && !f.startsWith('docs/')));
  for (const f of fichiers) {
    try {
      const contenu = git(o.projetDir, 'show', `${dernier}:${f}`);
      mkdirSync(dirname(join(secrets, 'tests-origine', f)), { recursive: true });
      writeFileSync(join(secrets, 'tests-origine', f), contenu);
    } catch { /* fichier supprimé par le lot */ }
  }
  writeFileSync(join(secrets, 'mesure.md'), `# Mesure — banc frais ${id}\n\n## Conformité\nJugée contre demande.md et le diff d'origine (${join(secrets, 'diff-origine.patch')}) : le comportement livré à l'origine est l'attendu.\nTests cachés : ${join(secrets, 'tests-origine')} (fichiers de test touchés par le lot), commande de suite : \`${o.tests}\`.\n`);
  writeFileSync(join(secrets, 'attendu.md'), `Le comportement du diff d'origine : ${join(secrets, 'diff-origine.patch')}.\n`);
  return id;
}
```

Ajouter dans `bench()` de `v2/src/bench/cli.ts`, avant le calcul de `numeros` :
```ts
  if (sous === 'ajouter') {
    const [projetDir, lot, fichierDemande] = reste;
    const taille = (option(reste, 'taille') ?? 'fonction') as 'retouche' | 'fonction' | 'grosse';
    if (!projetDir || !lot || !fichierDemande) { io.err('usage : cadence2 bench ajouter <projet> <lot> <demande.md> --install c --tests c [--taille t] [--visible]'); return 2; }
    io.out(`banc ajouté : ${ajouterBanc({ racine, projetDir, lot, demande: readFileSync(fichierDemande, 'utf8'),
      install: option(reste, 'install') ?? 'true', tests: option(reste, 'tests') ?? 'true', taille, visible: reste.includes('--visible') })}`);
    return 0;
  }
```
Ajouter aussi `import { ajouterBanc } from './ajouter.js';` en tête de `cli.ts`.

- [ ] **Step 4 : Lancer, vérifier le passage**

Run: `cd v2 && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (suite complète de v2), budget respecté.

- [ ] **Step 5 : Commit**

```bash
git add v2/src/bench/ajouter.ts v2/src/bench/cli.ts v2/test/ajouter.test.ts
git commit -m "v2(bench): bancs frais à partir d'un lot livré (cadence2 bench ajouter)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10 : Garde de publication 2.x et rappel en début de session

**Files:**
- Modify: `src/release.ts:277-280` (fonction `release`, après `const p = plan(root, bump, today);`)
- Modify: `hooks/hooks.json` (ajout d'un `SessionStart`)
- Test: `test/release-banc-v2.test.ts`

**Interfaces:**
- Produces : `export function gardeBancV2(version: string, verifier: () => { code: number; sortie: string }): void` dans `src/release.ts`. Elle lève `RafError` pour une version ≥ 2.0.0 quand `verifier().code !== 0`.

- [ ] **Step 1 : Test qui échoue**

`test/release-banc-v2.test.ts` :
```ts
import { describe, expect, it } from 'vitest';
import { gardeBancV2 } from '../src/release.js';

// Refonte du 07-11 (docs/v2/2026-11-07-cadence-2-design.md §4.1) : aucune 2.x sans banc vert sur l'empreinte publiée.
describe('garde de publication 2.x', () => {
  it('1.62.2 : pas de banc demandé (v1 gelée, correctifs)', () => {
    expect(() => gardeBancV2('1.62.2', () => ({ code: 1, sortie: '' }))).not.toThrow();
  });
  it('2.0.0 sans banc vert : refus, avec la raison', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 1, sortie: 'aucun banc vert sur l\'empreinte e1' }))).toThrow(/banc vert.*e1/s);
  });
  it('2.0.0 avec banc vert : permis', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 0, sortie: 'banc vert' }))).not.toThrow();
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `npx vitest run test/release-banc-v2.test.ts`
Expected: FAIL, « gardeBancV2 is not exported ».

- [ ] **Step 3 : Implémenter dans `src/release.ts`**

Ajouter avant `export function release(` :
```ts
/** Refonte du 07-11 : une version 2.x ne se prépare qu'avec un banc vert sur l'empreinte de v2 (cadence2 bench verifier-publication). */
export function gardeBancV2(version: string, verifier: () => { code: number; sortie: string }): void {
  if (Number(version.split('.')[0]) < 2) return;
  const r = verifier();
  if (r.code !== 0) throw new RafError(`release : ${version} demande un banc vert sur cette version de v2 — ${r.sortie.trim() || 'cadence2 introuvable'}`);
}
```
Dans `release()`, juste après `const p = plan(root, bump, today);` :
```ts
  gardeBancV2(p.version, () => {
    const r = spawnSync('node', [join(root, 'v2', 'bin', 'cadence2.js'), 'bench', 'verifier-publication'], { cwd: root, encoding: 'utf8' });
    return { code: r.status ?? 1, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  });
```
Ajouter enfin `import { spawnSync } from 'node:child_process';` en tête du fichier.

- [ ] **Step 4 : Rappel en début de session**

Dans `hooks/hooks.json`, ajouter la clé `SessionStart` au même niveau que `PostToolUse` :
```json
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "command -v cadence2 >/dev/null 2>&1 && { cadence2 bench statut | grep '⚠' || true; } || true" }] }],
```
Le rappel n'affiche que les lignes d'alerte et n'échoue jamais.

- [ ] **Step 5 : Lancer les tests ciblés**

Run: `npx vitest run test/release-banc-v2.test.ts test/release.test.ts && npx tsc --noEmit`
Expected : PASS. **Pas la suite complète de v1** : la porte d'intégration la joue une seule fois.

- [ ] **Step 6 : Commit**

```bash
git add src/release.ts test/release-banc-v2.test.ts hooks/hooks.json
git commit -m "release: aucune 2.x sans banc vert ; rappel du banc du weekend en début de session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11 : Banc du weekend automatique (systemd sous WSL)

**Files:**
- Create: `v2/systeme/cadence-banc.service`, `v2/systeme/cadence-banc.timer`, `v2/systeme/installer.sh`, `docs/v2/banc.md`
- Modify: `package.json` (`files` : ajouter `docs/v2/banc.md` et `docs/v2/2026-11-07-cadence-2-design.md`, cf CLAUDE.md, bornes des docs publiées)

- [ ] **Step 1 : Écrire les unités**

`v2/systeme/cadence-banc.service` :
```ini
[Unit]
Description=Banc hebdomadaire de cadence 2 (docs/v2/banc.md)
After=network-online.target

[Service]
Type=oneshot
User=sylvain_ladoire
Environment=HOME=/home/sylvain_ladoire
ExecStart=/bin/bash -lc 'cadence2 bench hebdo >> "$HOME/bench-cadence/hebdo.log" 2>&1'
TimeoutStartSec=10h
```

`v2/systeme/cadence-banc.timer` :
```ini
[Unit]
Description=Banc de cadence 2, chaque samedi ; rattrapé au premier démarrage de WSL s'il a été manqué

[Timer]
OnCalendar=Sat *-*-* 10:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`v2/systeme/installer.sh` :
```bash
#!/usr/bin/env bash
# Installe le banc du weekend (sudo). À lancer une fois par Sylvain.
set -euo pipefail
D=$(dirname "$(readlink -f "$0")")
sudo cp "$D/cadence-banc.service" "$D/cadence-banc.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cadence-banc.timer
systemctl list-timers cadence-banc.timer --no-pager
```

- [ ] **Step 2 : Écrire `docs/v2/banc.md`**

Contenu :
- **Pourquoi** : un lien vers la spec §0 et ses cinq causes.
- **Ce que mesure le banc** : la table des critères de `verdict.ts`.
- **Commandes** : `court`, `hebdo`, `lancer`, `statut`, `verifier-publication` et `ajouter`, une ligne et un exemple chacune.
- **Installation du timer** : `bash v2/systeme/installer.sh`.
- **Rattrapage** : `Persistent=true` relance un samedi manqué au premier démarrage de WSL.
- **Où lire les rapports** : `~/bench-cadence/rapports/` et `historique.jsonl`.
- **Règle** : un mécanisme neuf n'entre qu'avec un rapport où il gagne.

Moins de 120 lignes.

- [ ] **Step 3 : Ajouter les deux pages à `files` de `package.json`, puis jouer le test des docs publiées**

Run: `npx vitest run test/docs-publiees-l626.test.ts`
Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add v2/systeme/cadence-banc.service v2/systeme/cadence-banc.timer v2/systeme/installer.sh docs/v2/banc.md package.json
git commit -m "v2(bench): banc du weekend par timer systemd (rattrapé au démarrage de WSL), doc du banc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 : Installation par Sylvain**

`sudo` est nécessaire : donner à Sylvain le bloc à lancer, ne pas le lancer soi-même.
```bash
bash ~/projects/developpeur/cadence/v2/systeme/installer.sh
```
Expected : `cadence-banc.timer` apparaît dans `list-timers`, avec le samedi suivant comme prochaine échéance.

---

### Task 12 : Sondes réelles — garde-fous prod et bruit du banc

**Files:**
- Create: `docs/v2/mesures/<AAAA-MM-JJ>-bruit-du-banc.md`, à la date du passage

- [ ] **Step 1 : Sonde des outils interdits**

Run :
```bash
cd /tmp && KUBECONFIG=/nonexistent claude -p "Lance exactement : kubectl version --client ; puis git push" --output-format json --model haiku \
  --permission-mode bypassPermissions --disallowedTools 'Bash(kubectl:*),Bash(git push:*)' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("permission_denials"))'
```
Expected : deux refus, `kubectl` et `git push`. Si les refus n'apparaissent pas, **arrêter le plan** : il faut alors passer par une liste `--settings` avec `permissions.deny`, et le prévoir dans `bras.ts` avec son test avant d'aller plus loin.

- [ ] **Step 2 : Bruit du banc, A contre A sur le banc 1**

Ajouter à `~/bench-cadence/bras.yaml` un bras `A2` identique à `A`. Puis :
```bash
cadence2 bench lancer --bancs 1 --candidat A2 --reference A
```
Expected : environ 10 minutes. Le rapport donne l'écart de temps et de tokens entre deux passages identiques. C'est le bruit plancher. Le noter dans `docs/v2/mesures/<date>-bruit-du-banc.md` : un écart plus petit que ce bruit ne prouve rien.

- [ ] **Step 3 : Commit de la mesure**

```bash
git add docs/v2/mesures/
git commit -m "docs(v2): bruit du banc mesuré (A contre A, banc 1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13 : Contre-essai « équipe légère » (bancs 1, 3, 6)

- [ ] **Step 1 : Prévenir Sylvain avant de lancer** : bancs 1, 3 et 6, environ 1 h 30, environ 2 M de tokens. Aucune autre vague pendant le passage.

- [ ] **Step 2 : Lancer**

```bash
cadence2 bench court --candidat equipe-legere --reference A
```
Expected : `VERT` ou `ROUGE`, et le rapport dans `~/bench-cadence/rapports/`.

- [ ] **Step 3 : Contrôler les fuites et relire le rapport soi-même**

Relire le rapport et deux diffs au hasard (`runs/<date>-<empreinte>/<banc>/eval/X.patch`), pour vérifier que les juges ne se sont pas trompés grossièrement. Re-vérifier après un agent.

- [ ] **Step 4 : Rendre le verdict à Sylvain**

Si le résultat est **vert**, le flux v2 de la spec est confirmé et le plan n°2 (`plan`, `accueil` avec le gardien, `run`) peut commencer. S'il est **rouge**, nommer les critères rouges, puis reprendre le §2 de la spec avec Sylvain avant tout code. Copier le rapport dans `docs/v2/mesures/` et le commiter.

---

### Task 14 : Tests anti-rechute rapides (moins d'une minute, sans IA)

Ajout de Sylvain le 07-11 : « prévoir des tests, pas d'1 h, pour tester qu'on ne recommence pas nos âneries ». Chaque cause de l'échec du 07-11 (spec §0) devient un test qui tourne dans la suite v2, en quelques secondes, à chaque commit.

**Files:**
- Create: `v2/test/anti-rechute.test.ts`, `v2/options.json`
- Modify: rien d'autre

**Interfaces:**
- Consumes : `v2/src/**`, `v2/briefs/**`, `v2/budget.json`, `~/bench-cadence` jamais lu (test autonome).
- Produces : `v2/options.json` = `{ "options": { "<sous-commande> --<option>": "<chemin d'un rapport de banc ou de la spec qui la justifie>" } }`.

Une règle par cause, chacune avec son `describe` nommé d'après la cause :
- **C1, conformité à une fiche figée** :
  - aucun fichier de `v2/src` ni de `v2/briefs` ne contient les mots `scell`, `acceptation`, `fiche`, `maquette` ou `spec:` (insensible à la casse) ;
  - le brief du bras candidat contient `{{DEMANDE}}` ;
  - la consigne du relecteur ne lui donne que la demande et le diff : le brief contient « le texte de la demande » et « git -C {{CLONE}} diff ».
- **C2, contexte découpé** :
  - les briefs de bras ne demandent jamais une nouvelle session pour écrire le code (pas de « nouvelle session », pas de `claude -p` dans un brief) ;
  - les bras de `bras.yaml` produits par la doc et les modèles par défaut de `cli.ts` (juge) ne sont jamais `sonnet` ni `haiku` pour écrire le code. Le test lit `v2/src/bench/cli.ts` et vérifie que la valeur par défaut de `--juge` vaut `opus`.
- **C3, portes empilées** : `v2/src` ne contient au plus que deux appels à la porte. Le test compte les occurrences de `preparer(` et de la future `porte(` hors des tests, et vérifie qu'il n'en existe pas plus de deux par fichier. Le seuil est écrit en constante avec la phrase de la spec qui le justifie.
- **C4, mécanismes sans mesure** :
  - le budget de lignes existe déjà dans `budget.test.ts` et n'est pas dupliqué ;
  - en plus, toute option `--xxx` lue dans `v2/src` (motif `option(reste, 'xxx')` ou `'--xxx'`) doit figurer dans `v2/options.json`, avec un chemin qui existe dans le dépôt : un rapport de banc copié dans `docs/v2/mesures/`, ou la spec. Une option sans justification fait échouer le test. Remplir `options.json` avec les options actuelles (`candidat`, `reference`, `juge`, `bancs`, `taille`, `install`, `tests`, `visible`), chacune pointant vers `docs/v2/2026-11-07-cadence-2-design.md`.
- **C5, rattrapages du lead** :
  - `verdict.ts` garde les critères bloquants `questions inutiles` et `aucun bras en échec`. Le test les cherche dans la sortie de `verdict()` sur un jeu minimal et vérifie `bloquant: true` ;
  - `statut()` refuse la publication sans passage couvrant 1, 3 et 6.

- [ ] **Step 1 : Écrire le test.** Il échoue sur un point s'il faut ajouter `options.json`.
- [ ] **Step 2 : Lancer, vérifier l'échec**, puis écrire `options.json`.
- [ ] **Step 3 : Lancer la suite v2 et chronométrer.** `cd v2 && time npx vitest run` doit rester sous 60 s au total.
- [ ] **Step 4 : Commit** (chemins explicites, ligne Co-Authored-By).

---

### Task 15 : Banc éclair (environ 15 min, réel)

Le banc court (1, 3, 6, environ 1 h) reste la condition de publication. Le banc éclair sert à vérifier vite, après un changement de v2, que le flux n'est pas redevenu lent ni bavard. Il joue le seul banc 1, une retouche, A contre le candidat, avec les juges.

**Files:**
- Modify: `v2/src/bench/cli.ts`, ajout de la sous-commande `eclair`, qui vaut `lancer --bancs 1`, avec deux contrôles en plus :
  - temps du candidat ≤ 1,2 × A ;
  - aucune question.

  Ces deux contrôles s'affichent en tête de sortie. Le passage n'entre **pas** dans les passages qui autorisent la publication, puisque `statut` exige 1, 3 et 6.
- Test: `v2/test/bench-cli.test.ts`, un cas `eclair` avec le faux exécuteur. Il vérifie qu'un seul banc est joué et que la ligne d'historique a `hebdo: false`.

- [ ] Steps TDD habituels ; commit.

---

### Task 16 : HUD — état du banc dans la barre

Ajout de Sylvain le 07-11 : la barre et le panneau de droite du HUD doivent suivre v2. Le HUD complet de v2 (demandes, étapes, gardien) arrivera avec le flux v2, au plan n°2. Ici, on ajoute seulement ce qui existe déjà : l'état du banc.

**Files:**
- Modify: `plugins/cadence-hud/hooks/collect.ts` (lecture de `~/bench-cadence/historique.jsonl`, sans lancer aucune commande, comme le HUD lit les vagues), `plugins/cadence-hud/hooks/format.ts`, plus le rendu de la barre.
- Test: `plugins/cadence-hud/tests/banc.test.ts`.

Une ligne, affichée seulement quand `historique.jsonl` existe :
- `banc ✓ 08-11 court · eq-legere/A` en vert : le dernier passage est vert ;
- `banc ✗ 08-11 : temps total, relecture aveugle` en rouge : il est rouge, avec ses trois premiers critères rouges ;
- `banc ⚠ weekend manquant` en orange, du lundi au vendredi, si aucun passage hebdo n'a eu lieu depuis le samedi (heure de Paris), avec la même règle que `statut` de `verdict.ts`, recopiée : le plugin ne dépend pas de v2.

Le panneau `/hud` ajoute le détail des 5 derniers passages : date, bancs, verdict, critères rouges.

- [ ] Lire `docs/cadence-hud.md` et le code du HUD ; suivre ses motifs (fonctions pures dans `format.ts`, tests sous `plugins/cadence-hud/tests/`, joués par `claude plugin test`, cf. son README).
- [ ] TDD sur la fonction pure qui transforme les lignes d'historique en ligne de barre, puis branchement dans le rendu.
- [ ] Mettre à jour `docs/cadence-hud.md` (une section courte « Banc »).
- [ ] Commit.

---

## Couverture de la spec par ce plan

| Spec | Tâches |
|---|---|
| §0 contre-mesures C3 (suite isolée), C4 (budget) | 1 |
| §0 C5 (interventions comptées) | 4 (questions), 7 (« questions inutiles ») |
| §1 barre | 7 |
| §4.1 banc court + refus de publier | 8, 10 |
| §4.2 banc complet du weekend, bancs fixes et frais, juges aveugles, fuites, courbe | 2, 3, 4, 5, 6, 7, 8, 9, 11 |
| §4.4 tests de l'outil sans dépense (faux `claude`) | 4, 6, 8 |
| §4.5 lancement, rappel si manqué | 8 (statut), 10 (hook), 11 (timer) |
| §5 budget de lignes | 1 |
| §6.2-6.3 bench d'abord, puis premier passage | 13 |
| §0 anti-rechute en tests rapides (ajout du 07-11) | 14, 15 |
| HUD (ajout du 07-11) : état du banc | 16 ; HUD complet de v2 au plan n°2 |
| §2, §3 (flux, gardien), §4.3 (audit de durée), §4.4 journal des demandes réelles, §6.4-6.5 | **plans suivants**, une fois le banc vert sur le contre-essai |
