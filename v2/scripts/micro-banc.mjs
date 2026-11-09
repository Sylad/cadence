#!/usr/bin/env node
// Micro-banc (09-11) : trier une idée en minutes, sur une petite application piégée, SANS juge LLM.
// Chaque bras joue les demandes du micro-banc l'une après l'autre dans son clone (une session neuve par demande),
// lancé par la MÊME fonction que le vrai banc (lancerBras : même brief, même hook de lecture, mêmes interdictions).
// Puis des tests cachés disent, mécaniquement, ce qui est fait : demandes, pièges de cohérence, demande glissée, norme lue.
// Les 2 × N bras tournent en parallèle, chacun dans son espace de processus (unshare) et avec son port.
// Usage : micro-banc.mjs <candidat> <référence> <N> [dossier du micro-banc, ~/bench-cadence/micro]
// Le banc AetherWX reste la validation finale d'une idée qui gagne ici.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const V2 = new URL('..', import.meta.url).pathname;
const [mode, ...args] = process.argv.slice(2);

if (mode === 'bras') { // un bras, une répétition : node micro-banc.mjs bras <nom> <dossier> <micro>
  const [nom, dir, micro] = args;
  const { chargerBras, creerExecuteur, lancerBras } = await import(join(V2, 'dist/bench/bras.js'));
  const d = chargerBras(join(homedir(), 'bench-cadence'))[nom];
  const clone = join(dir, 'clone'); mkdirSync(dir, { recursive: true });
  execFileSync('git', ['clone', '-q', join(micro, 'mini-carte'), clone]);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
  const etapes = readdirSync(join(micro, 'demandes')).sort();
  const res = { bras: nom, etapes: [] };
  for (const k of etapes) {
    const b = { id: `micro-${k}`, dir: join(micro, 'demandes', k), secrets: '', projet: 'mini-carte', source: '', base, install: '', tests: 'node --test',
      visible: false, taille: 'fonction', frais: false, reponses: false };
    const pieces = existsSync(join(micro, 'demandes', k, 'pieces.json')) ? JSON.parse(readFileSync(join(micro, 'demandes', k, 'pieces.json'), 'utf8')).map((p) => join(clone, p)) : [];
    const m = lancerBras(b, d, clone, creerExecuteur('claude', 30 * 60_000), undefined, { pieces, racine: dir });
    res.etapes.push({ k, duree_s: m.duree_s, echec: m.echec ?? null, cout_usd: m.cout_usd });
  }
  // Juge mécanique : la suite du bras, puis tous les tests cachés copiés dans une copie du clone.
  const suite = (cwd) => { try { execFileSync('node', ['--test'], { cwd, stdio: 'pipe', timeout: 120_000 }); return true; } catch { return false; } };
  res.suite_ok = suite(clone);
  const copie = join(dir, 'juge'); cpSync(clone, copie, { recursive: true });
  const caches = readdirSync(join(micro, 'caches')).map((f) => { cpSync(join(micro, 'caches', f), join(copie, 'test', `cache-${f}`)); return join('test', `cache-${f}`); });
  let sortie = ''; // seulement les tests cachés : ceux que le bras a écrits ne comptent pas
  try { sortie = execFileSync('node', ['--test', '--test-reporter=tap', ...caches], { cwd: copie, encoding: 'utf8', stdio: 'pipe', timeout: 120_000 }); } catch (e) { sortie = String(e.stdout ?? ''); }
  res.caches = [...sortie.matchAll(/^\s*(not ok|ok) \d+ - (.+)$/gm)].filter((x) => !/^test\//.test(x[2].trim())).map((x) => ({ test: x[2].trim(), ok: x[1] === 'ok' }));
  res.commits = Number(execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: clone, encoding: 'utf8' }).trim());
  res.duree_s = res.etapes.reduce((a, e) => a + e.duree_s, 0);
  writeFileSync(join(dir, 'resultat.json'), JSON.stringify(res, null, 1));
  process.exit(0);
}

// Orchestrateur : node micro-banc.mjs <candidat> <référence> <N> [micro]
const [cand, ref, nTexte, microArg] = [mode, ...args];
const N = Number(nTexte), micro = microArg ?? join(homedir(), 'bench-cadence', 'micro');
if (!cand || !ref || !(N > 0)) { console.error('usage : micro-banc.mjs <candidat> <référence> <N> [dossier]'); process.exit(2); }
const lot = join(micro, 'lots', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${cand}-${ref}`);
mkdirSync(lot, { recursive: true });
const jobs = [];
let port = 4500;
for (let i = 1; i <= N; i++) for (const nom of [cand, ref]) {
  const dir = join(lot, `r${i}-${nom}`); port += 10;
  jobs.push(new Promise((ok) => {
    const p = spawn('unshare', ['--user', '--map-current-user', '--pid', '--fork', '--mount-proc', process.execPath, new URL(import.meta.url).pathname, 'bras', nom, dir, micro],
      { env: { ...process.env, CADENCE_PORT: String(port), PLAYWRIGHT_MCP_ISOLATED: 'true' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (x) => { err += x; });
    p.on('close', (code) => { if (code) writeFileSync(join(lot, `r${i}-${nom}.erreur.txt`), err); ok(); });
  }));
}
console.log(`micro-banc : ${jobs.length} bras en parallèle → ${lot}`);
await Promise.all(jobs);

// Bilan : par bras, les tests cachés réussis (au total et par catégorie), le temps, les échecs.
const lus = readdirSync(lot).filter((d) => existsSync(join(lot, d, 'resultat.json'))).map((d) => JSON.parse(readFileSync(join(lot, d, 'resultat.json'), 'utf8')));
const cat = (t) => (/^PIÈGE/.test(t) ? 'pièges' : /^DEMANDE GLISSÉE/.test(t) ? 'glissée' : 'demandes');
const lignes = [`# Micro-banc ${cand} contre ${ref}, ${N} répétitions`, '', `| bras | répétitions | tests cachés réussis | demandes | pièges | demande glissée | suite verte | temps médian | échecs |`, '|---|---|---|---|---|---|---|---|---|'];
for (const nom of [cand, ref]) {
  const r = lus.filter((x) => x.bras === nom);
  if (!r.length) { lignes.push(`| ${nom} | 0 | – | – | – | – | – | – | tous en erreur |`); continue; }
  const somme = (f) => r.reduce((a, x) => a + x.caches.filter((c) => f(c.test) && c.ok).length, 0);
  const total = (f) => r.reduce((a, x) => a + x.caches.filter((c) => f(c.test)).length, 0);
  const t = r.map((x) => x.duree_s).sort((a, b) => a - b), med = t[Math.floor(t.length / 2)];
  const echecs = r.flatMap((x) => x.etapes.filter((e) => e.echec).map((e) => `${e.k}: ${e.echec}`));
  lignes.push(`| ${nom} | ${r.length} | ${somme(() => true)}/${total(() => true)} | ${somme((c) => cat(c) === 'demandes')}/${total((c) => cat(c) === 'demandes')} | ${somme((c) => cat(c) === 'pièges')}/${total((c) => cat(c) === 'pièges')} | ${somme((c) => cat(c) === 'glissée')}/${total((c) => cat(c) === 'glissée')} | ${r.filter((x) => x.suite_ok).length}/${r.length} | ${med} s | ${echecs.length ? echecs.join(' ; ') : '–'} |`);
}
const erreurs = readdirSync(lot).filter((f) => f.endsWith('.erreur.txt'));
if (erreurs.length) lignes.push('', `Bras en erreur (voir les fichiers) : ${erreurs.join(', ')}`);
writeFileSync(join(lot, 'bilan.md'), lignes.join('\n') + '\n');
console.log(lignes.join('\n'));
