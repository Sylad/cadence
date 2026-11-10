// Fumée de cadence release (L696) : l'aide de cadence2 depuis le paquet installé. cadence2 n'y est pas un bin (le banc se lie
// depuis le checkout, docs/v2/banc.md) : on charge son point d'entrée publié, v2/dist/cli.js, celui que `cadence run` importe aussi.
const paquet = process.env.CADENCE_FUMEE_PAQUET;
if (!paquet) throw new Error('CADENCE_FUMEE_PAQUET absent : ce script se lance depuis cadence release');
const { run } = await import(`${paquet}/v2/dist/cli.js`);
const lignes = [];
process.exitCode = await run(['--help'], { cwd: process.cwd(), env: process.env, now: () => new Date(), out: (l) => lignes.push(l), err: (l) => console.error(l) });
console.log(lignes.join('\n'));
if (process.exitCode === 0 && !/cadence2 bench/.test(lignes.join('\n'))) { console.error("l'aide de cadence2 ne cite pas cadence2 bench"); process.exitCode = 1; }
