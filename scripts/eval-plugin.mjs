// L740 : l'éval du plugin (étape de `cadence release`, `npm run eval:plugin`) avec un rejeu. Un cas sous le seuil sur un seul run sur six
// arrêtait la release pour un aléa du modèle ou du juge (14-11 orchestrate-id-avec-slash 0,83 ; 15-11 livrer-sh-sans-bloc 0,83). Règle :
// un cas sous le seuil est rejoué une fois, ses runs « with » seuls ; il ne fait échouer l'éval que s'il reste sous le seuil au rejeu.
// Le rapport (rejeu.md, rejeu.json et un bandeau dans report.html) dit « rejoué » et garde les deux mesures.
// Usage : node scripts/eval-plugin.mjs npm run eval:plugin -- --trust-plugin (l'étape de `cadence release`), ou
// node scripts/eval-plugin.mjs claude plugin eval . --max-cost-usd 5 --no-publish [options] : la commande enveloppée reçoit en plus
// --output-dir, et pour le rejeu --case, --ablation none et le reste du plafond de coût. package.json n'est pas touché : ses scripts
// sont une config que le cliquet qualité refuse de voir changer dans un lot de code (docs/qualite.md).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Les options de `claude plugin eval` que le rejeu remplace : elles ne sont jamais recopiées telles quelles. */
const REMPLACEES = ['--case', '--ablation', '--output-dir', '--max-cost-usd', '--report', '--json'];

/** La valeur d'une option (`--x v` ou `--x=v`), ou undefined. */
export function option(args, nom) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === nom) return args[i + 1];
    if (args[i].startsWith(`${nom}=`)) return args[i].slice(nom.length + 1);
  }
  return undefined;
}

/** Les arguments sans les options nommées (et leur valeur). */
export function sans(args, noms) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (noms.includes(args[i])) { i++; continue; }
    if (noms.some((n) => args[i].startsWith(`${n}=`))) continue;
    out.push(args[i]);
  }
  return out;
}

/** Sous `npm run`, ce qui suit doit passer après `--`, sinon npm le prend pour lui. */
export function avecSeparateur(cmd, args) {
  return cmd === 'npm' && args[0] === 'run' && !args.includes('--') ? [...args, '--'] : args;
}

/** Le plafond de coût de la commande : son option, ou sous `npm run <script>` celle du script de package.json. */
export function plafondDe(cmd, args, racine = '.') {
  const ici = option(args, '--max-cost-usd');
  if (ici !== undefined || cmd !== 'npm' || args[0] !== 'run') return ici === undefined ? undefined : Number(ici);
  const f = join(racine, 'package.json');
  const script = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).scripts?.[args[1]] : undefined;
  const v = typeof script === 'string' ? /--max-cost-usd[= ](\S+)/.exec(script)?.[1] : undefined;
  return v === undefined ? undefined : Number(v);
}

const lireAgregat = (dir) => {
  const f = join(dir, 'aggregate-result.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};

const seuilDe = (agregat) => agregat.suite?.threshold ?? 1;

/** Les cas sous le seuil d'un agrégat de `claude plugin eval`, avec leur score « with ». */
export function casSousLeSeuil(agregat) {
  const seuil = seuilDe(agregat);
  return agregat.cases.filter((c) => c.aggregates.score < seuil).map((c) => ({ name: c.name, score: c.aggregates.score }));
}

/** Les arguments du rejeu d'un cas : ce cas seul, le bras avec le plugin seul, son dossier, le reste du plafond de coût. */
export function argsDuRejeu(args, cas, dossier, plafond) {
  return [...sans(args, REMPLACEES), '--case', cas, '--ablation', 'none', '--output-dir', dossier,
    ...(plafond === undefined ? [] : ['--max-cost-usd', String(plafond)])];
}

const virgule = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '—');

/** Le rapport du rejeu, en Markdown : chaque cas rejoué avec ses deux mesures et son verdict, puis le verdict de l'éval. */
export function rapportRejeu(seuil, rejoues) {
  const lignes = [`# Éval du plugin : rejeu (L740)`, '', `Seuil : ${virgule(seuil)}. Un cas sous le seuil est rejoué une fois (runs « with ») ;`
    + ' il ne fait échouer l\'éval que s\'il reste sous le seuil au rejeu.', ''];
  for (const r of rejoues) {
    const fin = r.rejeu === null ? `rejeu impossible (${r.raison})` : `rejoué : ${virgule(r.rejeu)}`;
    lignes.push(`- ${r.name} : ${virgule(r.premier)} au premier passage, ${fin} — ${r.passe ? 'passe' : 'échoue'}`);
  }
  const echecs = rejoues.filter((r) => !r.passe);
  lignes.push('', echecs.length === 0 ? 'Éval verte après rejeu.' : `Éval rouge : ${echecs.map((r) => r.name).join(', ')} reste sous le seuil.`);
  return `${lignes.join('\n')}\n`;
}

const echapper = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Écrit rejeu.md et rejeu.json dans le dossier du premier passage, et met le rapport en tête de son report.html. */
function ecrireRapport(dossier, seuil, rejoues) {
  const md = rapportRejeu(seuil, rejoues);
  writeFileSync(join(dossier, 'rejeu.md'), md);
  writeFileSync(join(dossier, 'rejeu.json'), `${JSON.stringify({ seuil, rejoues }, null, 2)}\n`);
  const html = join(dossier, 'report.html');
  if (existsSync(html)) {
    const bandeau = `<section id="rejeu-l740" style="border:2px solid #b45309;padding:8px;margin:8px"><pre>${echapper(md)}</pre></section>`;
    const page = readFileSync(html, 'utf8');
    const m = /<body[^>]*>/i.exec(page);
    writeFileSync(html, m ? page.slice(0, m.index + m[0].length) + bandeau + page.slice(m.index + m[0].length) : bandeau + page);
  }
  return md;
}

const lancer = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;

/** Rejoue un cas et dit sa mesure ; null avec la raison quand le rejeu n'a pas de résultat complet. */
function rejouer({ cmd, args, dossier, run }, cas, plafond) {
  if (plafond !== undefined && plafond <= 0) return { rejeu: null, raison: 'plafond de coût atteint' };
  const sortie = join(dossier, 'rejeu', cas.name);
  mkdirSync(sortie, { recursive: true });
  const code = run(cmd, argsDuRejeu(args, cas.name, sortie, plafond));
  const agregat = lireAgregat(sortie);
  const mesure = agregat?.cases.find((c) => c.name === cas.name);
  if (!mesure || agregat.partial) return { rejeu: null, raison: `pas de résultat complet (code ${code})`, cout: agregat?.costUsd ?? 0 };
  return { rejeu: mesure.aggregates.score, cout: agregat.costUsd ?? 0 };
}

/**
 * Lance l'éval, puis rejoue une fois chaque cas sous le seuil. Code de sortie : celui du premier passage quand il n'est ni 0 ni 1
 * (plafond de coût, panne : rien n'est rejoué), 1 si un cas reste sous le seuil au rejeu, 0 sinon.
 */
export function evalAvecRejeu(argv, { run = lancer, maintenant = new Date(), log = console.log } = {}) {
  const [cmd, ...donnes] = argv;
  const brut = avecSeparateur(cmd, donnes);
  const dossier = resolve(option(brut, '--output-dir')
    ?? join(option(brut, '--eval-dir') ?? 'evals', 'results', maintenant.toISOString().replace(/[:.]/g, '-')));
  const args = [...sans(brut, ['--output-dir']), '--output-dir', dossier];
  const code = run(cmd, args);
  if (code === 0) return 0;
  const agregat = lireAgregat(dossier);
  if (code !== 1 || !agregat || agregat.partial) return code;
  const sous = casSousLeSeuil(agregat);
  if (sous.length === 0) return code;
  const max = plafondDe(cmd, brut);
  let plafond = max === undefined ? undefined : max - (agregat.costUsd ?? 0);
  const seuil = seuilDe(agregat);
  const rejoues = sous.map((cas) => {
    log(`eval:plugin : ${cas.name} sous le seuil (${virgule(cas.score)}), rejoué une fois (runs « with »)`);
    const r = rejouer({ cmd, args: brut, dossier, run }, cas, plafond);
    if (plafond !== undefined) plafond -= r.cout ?? 0;
    return { name: cas.name, premier: cas.score, rejeu: r.rejeu, ...(r.raison ? { raison: r.raison } : {}), passe: r.rejeu !== null && r.rejeu >= seuil };
  });
  log(ecrireRapport(dossier, seuil, rejoues));
  return rejoues.every((r) => r.passe) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(evalAvecRejeu(process.argv.slice(2)));
}
