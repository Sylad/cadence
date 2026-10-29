import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';


// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { DELIVERIES, COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { DELIVERIES: string; COLLECTOR: string };
const { wrapCommand } = (await import(new URL('../plugins/cadence-hud/hooks/decisions.ts', import.meta.url).href)) as { wrapCommand: (command: string, columns: number) => string[] };

// L412 : les scripts Python du mod (livraisons en échec, collecteur des vagues) joués pour de vrai, et la commande repliée collée dans un vrai shell ;
// les tests du mod n'ont pas accès au système de fichiers ni aux processus.

it('L412 R11 — le script DELIVERIES lit la dernière livraison en échec, effacée par une livraison verte écrite après', () => {
  const root = mkdtempSync(join(tmpdir(), 'deliveries-'))
  try {
    const repo = (name: string, failed: string | null, green: string | null, greenIsNewer = true) => {
      const dir = join(root, name, '.git', 'cadence')
      mkdirSync(dir, { recursive: true })
      if (failed !== null) writeFileSync(join(dir, 'deliveries-failed.log'), failed)
      if (green !== null) writeFileSync(join(dir, 'deliveries.log'), green)
      const old = new Date('2026-10-28T10:00:00Z')
      const recent = new Date('2026-10-29T10:00:00Z')
      if (failed !== null) utimesSync(join(dir, 'deliveries-failed.log'), old, greenIsNewer ? old : recent)
      if (green !== null) utimesSync(join(dir, 'deliveries.log'), recent, greenIsNewer ? recent : old)
    }
    repo('rouge', '2026-10-27 aaa1111 [ci] CI en échec ⏎ x\n2026-10-29 bbb2222 [deploiement] script en échec (code 1) ⏎ boum\n', null)
    repo('retabli', '2026-10-28 ccc3333 [ci] CI en échec\n', '2026-10-29 ddd4444\n')
    repo('apres', '2026-10-29 eee5555 [verification] vérification en échec\n', '2026-10-28 fff6666\n', false)
    repo('vide', '\n\n', null)
    repo('propre', null, '2026-10-29 ggg7777\n')
    mkdirSync(join(root, 'sans-git'))
    writeFileSync(join(root, 'cadence.yaml'), '')
    const run = spawnSync('python3', ['-I', '-c', DELIVERIES, root], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual([
      { project: 'apres', day: '2026-10-29', sha: 'eee5555', reason: 'vérification en échec' },
      { project: 'rouge', day: '2026-10-29', sha: 'bbb2222', reason: 'script en échec (code 1)' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('L412 R12 — le collecteur rend les vagues finies du dossier dans `ended` même sous une vague vivante dont le wave.json est plus récent ; `waves` ne porte que la dernière finie, et sans vivante seulement', () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-'))
  try {
    const home = join(root, 'home')
    const cwd = join(root, 'proj')
    mkdirSync(join(home, 'waves'), { recursive: true })
    const runs = (id: string) => join(cwd, '.cadence', 'runs', id)
    mkdirSync(runs('fini'), { recursive: true })
    mkdirSync(runs('vivant'), { recursive: true })
    writeFileSync(join(runs('fini'), 'wave.json'), JSON.stringify({ id: 'fini', status: 'done', consumed: 3 }))
    writeFileSync(join(runs('fini'), 'ol--L5.json'), JSON.stringify({ project: 'ol', lot: 'L5', status: 'question', questions: ['q ?'] }))
    // la vague vivante a aussi son wave.json, et c'est TOUJOURS le plus récent du dossier : orchestrate y réécrit `consumed` en continu
    writeFileSync(join(runs('vivant'), 'wave.json'), JSON.stringify({ id: 'vivant', status: 'implementing', consumed: 1 }))
    writeFileSync(join(runs('vivant'), 'ol--L6.json'), JSON.stringify({ project: 'ol', lot: 'L6', status: 'implementing' }))
    const older = new Date('2026-10-29T10:00:00Z')
    const newer = new Date('2026-10-29T11:00:00Z')
    utimesSync(join(runs('fini'), 'wave.json'), older, older)
    utimesSync(join(runs('vivant'), 'wave.json'), newer, newer)
    writeFileSync(join(home, 'waves', `${process.pid}.json`), JSON.stringify({ wave: 'vivant', pid: process.pid, cwd }))
    type Out = { waves: { id: string; live: boolean }[]; ended: { id: string; live: boolean; lots: { lot: string }[] }[] }
    const collect = (): Out => {
      const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } })
      expect(run.status).toBe(0)
      return JSON.parse(run.stdout) as Out
    }
    // une vague vit : la bande ne reçoit qu'elle ; la vague finie, plus ancienne, attend dans `ended` avec ses lots — la vivante n'est pas la « dernière finie »
    const withLive = collect()
    expect(withLive.waves.map(w => [w.id, w.live])).toEqual([['vivant', true]])
    expect(withLive.ended).toMatchObject([{ id: 'fini', live: false }])
    expect(withLive.ended[0]!.lots.map(l => l.lot)).toEqual(['L5'])
    // plus de vague vivante : la bande reçoit la dernière vague du dossier (la plus récente, comme avant le lot), et `ended` la porte aussi
    rmSync(join(home, 'waves', `${process.pid}.json`))
    const alone = collect()
    expect(alone.waves.map(w => [w.id, w.live])).toEqual([['vivant', false]])
    expect(alone.ended.map(w => w.id)).toEqual(['vivant', 'fini'])
    expect(alone.ended[0]!.lots.map(l => l.lot)).toEqual(['L6'])
    // sans la vague « vivant » : la finie seule, dans `waves` comme dans `ended`
    rmSync(runs('vivant'), { recursive: true, force: true })
    const only = collect()
    expect(only.waves.map(w => [w.id, w.live])).toEqual([['fini', false]])
    expect(only.ended).toMatchObject([{ id: 'fini', live: false }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('L412 R25 — les lignes de la commande repliée, collées telles quelles dans bash, lancent UNE commande avec tous ses arguments, à toute largeur', () => {
  // la commande affiche chaque argument entre crochets : ce que bash a reçu se lit sur la sortie
  const command = 'printf "[%s]" orchestrate --resume --wave 2026-10-29-1650 --answer maritime-atlas:Q4/accueil-4-ux12 "…"'
  const expected = '[orchestrate][--resume][--wave][2026-10-29-1650][--answer][maritime-atlas:Q4/accueil-4-ux12][…]'
  for (const columns of [54, 60, 62, 70, 120, 30, 9]) {
    const lines = wrapCommand(command, columns)
    if (columns <= 70) expect(lines.length, `${columns} colonnes : repliée`).toBeGreaterThan(1)
    const run = spawnSync('bash', [], { input: `${lines.map(l => l.replace(/^ {3}/, '')).join('\n')}\n`, encoding: 'utf8' })
    expect(run.status, `${columns} colonnes`).toBe(0)
    expect(run.stderr, `${columns} colonnes`).toBe('')
    expect(run.stdout, `${columns} colonnes`).toBe(expected)
  }
})

it('L412 R26 — le collecteur rend TOUTES les vagues finies du dossier (7 derniers jours, 30 au plus), de la plus récente à la plus ancienne : un lot rendu d’une vague ancienne survit à trois vagues finies depuis', () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-'))
  try {
    const home = join(root, 'home')
    const cwd = join(root, 'proj')
    mkdirSync(join(home, 'waves'), { recursive: true })
    const runs = (id: string) => join(cwd, '.cadence', 'runs', id)
    const HOUR = 3_600_000
    // la date du wave.json est sa fin : posée par rapport à maintenant, la borne des 7 jours se mesure sur la vraie horloge
    const wave = (id: string, agoMs: number, lot: Record<string, unknown> | null) => {
      mkdirSync(runs(id), { recursive: true })
      writeFileSync(join(runs(id), 'wave.json'), JSON.stringify({ id, cwd, status: 'done' }))
      if (lot) writeFileSync(join(runs(id), `${lot.project}--${lot.lot}.json`), JSON.stringify(lot))
      const d = new Date(Date.now() - agoMs)
      utimesSync(join(runs(id), 'wave.json'), d, d)
    }
    // le cas de la revue : L412 rendu dans la vague 1650, puis ew1, ev43 et wo1 finies sans rien à décider
    wave('2026-10-29-1650', 4 * HOUR, { project: 'cadence', lot: 'L412', status: 'handed-back', outcome: 'correction non jouée (budget)' })
    wave('2026-10-29-ew1', 3 * HOUR, { project: 'evatosorus', lot: 'L42', status: 'ready' })
    wave('2026-10-29-ev43', 2 * HOUR, { project: 'evatosorus', lot: 'L43', status: 'ready' })
    wave('2026-10-29-wo1', 1 * HOUR, null)
    wave('2026-10-20-old', 8 * 24 * HOUR, { project: 'ol', lot: 'L1', status: 'question', questions: ['trop vieille'] }) // plus de 7 jours : hors du bloc
    writeFileSync(join(cwd, '.cadence', 'runs', 'etranger.txt'), '') // un fichier étranger dans runs/ ne gêne pas
    type Out = { waves: { id: string; live: boolean }[]; ended: { id: string; live: boolean; cwd: string; lots: { lot: string; status: string }[] }[] }
    const collect = (): Out => {
      const run = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home } })
      expect(run.status, run.stderr).toBe(0)
      return JSON.parse(run.stdout) as Out
    }
    const out = collect()
    expect(out.ended.map(w => w.id)).toEqual(['2026-10-29-wo1', '2026-10-29-ev43', '2026-10-29-ew1', '2026-10-29-1650'])
    expect(out.ended.every(w => !w.live && w.cwd === cwd)).toBe(true)
    expect(out.ended[3]!.lots).toMatchObject([{ lot: 'L412', status: 'handed-back' }])
    // la bande, elle, ne reçoit que la plus récente
    expect(out.waves.map(w => w.id)).toEqual(['2026-10-29-wo1'])
    // 30 au plus : 31 vagues plus récentes poussent la vague 1650 hors de la liste
    for (let i = 0; i < 31; i++) wave(`2026-10-29-n${i}`, (31 - i) * 60_000, null)
    const capped = collect()
    expect(capped.ended).toHaveLength(30)
    expect(capped.ended.map(w => w.id)).not.toContain('2026-10-29-1650')
    expect(capped.ended[0]!.id).toBe('2026-10-29-n30')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
