import { expect, test } from 'claude-code/testing'

import { buildDecisions, decisionsOf, parseDeliveries, wrapCommand } from '../hooks/decisions'
import type { FailedDelivery, LotsBoard, TourLot, Wave, WaveLot } from '../types'

const wlot = (lot: string, status: string, extra: Partial<WaveLot> = {}): WaveLot => ({ project: 'ol', repo: `/p/${extra.project ?? 'ol'}`, lot, title: `T ${lot}`, status, pass: 0, model: 'sonnet', next: null, steps: 1, step: null, ...extra })
const wave = (lots: WaveLot[], extra: Partial<Wave> = {}): Wave => ({ id: 'w1', pid: 1, cwd: '/p', started: '2026-10-29T16:00:00Z', live: true, lots, ...extra })

test('L412 R1 — une question de session d’une vague finie : le texte court et la commande --answer de la vague, qui commence par `cd <dossier de lancement de la vague> &&`', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?', 'Quelle date ?'] })], { live: false })], [])
  expect(d).toEqual([{ kind: 'question', project: 'ol', lot: 'L5', text: 'Quel format ? / Quelle date ?', command: 'cd /p && cadence orchestrate --resume --wave w1 --answer ol:L5 "…"' }])
})

test('L412 R28 — une question d’une vague VIVANTE porte la même commande `--resume --wave --answer` que celle d’une vague finie (orchestrate la dépose dans la file de la vague vivante, L407) : pas de note d’attente', () => {
  const cmd = 'cd /p && cadence orchestrate --resume --wave w1 --answer ol:L5 "…"'
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?'] })])], [])
  expect(d).toEqual([{ kind: 'question', project: 'ol', lot: 'L5', text: 'Quel format ?', command: cmd }])
  const { lines } = buildDecisions(d, 120, 10)
  expect(lines.map(l => [l.text, l.tone])).toEqual([
    ['Ce qui attend une décision (1)', 'title'],
    ['? ol:L5  Quel format ?', 'text'],
    [`   ${cmd}`, 'subtle'],
  ])
  expect(lines.map(l => l.text).join('\n')).not.toMatch(/fin de la vague/)
  // la même vague finie : la même commande
  expect(decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?'] })], { live: false })], [])[0]).toMatchObject({ command: cmd })
})

test('L412 R2 — un lot rendu au lead : la cause en une ligne (première ligne de l’issue), à défaut le statut', () => {
  const d = decisionsOf([wave([wlot('L1', 'handed-back', { outcome: 'revue non conforme après 3 passes\nsuite' }), wlot('L2', 'failed'), wlot('L3', 'suspended', { outcome: 'quota' })])], [])
  expect(d.map(x => [x.kind, x.kind === 'livraison' ? '' : x.lot, x.kind === 'rendu' ? x.text : ''])).toEqual([['rendu', 'L1', 'revue non conforme après 3 passes'], ['rendu', 'L2', 'échec']])
})

test('L412 R3 — un verdict UX à poser : lot prêt, visible, verdict de la revue lu, avec `cd <dépôt du lot> && raf ux`', () => {
  const d = decisionsOf([wave([wlot('L1', 'ready', { visible: true, uxVerdict: 'conforme' }), wlot('L2', 'ready', { visible: false, uxVerdict: 'conforme' }), wlot('L3', 'ready', { visible: true, uxVerdict: null }), wlot('L4', 'reviewing', { visible: true, uxVerdict: 'x' })])], [])
  expect(d).toEqual([{ kind: 'ux', project: 'ol', lot: 'L1', text: 'conforme', command: 'cd /p/ol && raf ux L1 "verdict"' }])
})

test('L412 R27 — les commandes à copier nomment leur dossier : `cd` du dépôt du lot (`repo` de son état) pour raf ux, du dossier de lancement de la vague (`cwd`) pour --answer ; un chemin avec espace ou apostrophe est quoté ; un état de lot sans `repo` (jamais écrit par orchestrate) garde raf ux nu', () => {
  const w = wave([wlot('L1', 'ready', { visible: true, uxVerdict: 'ok', repo: "/home/s l/projets/l'ol" }), wlot('L2', 'ready', { visible: true, uxVerdict: 'ok', repo: undefined }), wlot('L3', 'question', { questions: ['q'] })], { cwd: '/home/s l/projets', live: false })
  const cmd = (d: ReturnType<typeof decisionsOf>[number]) => (d.kind === 'question' || d.kind === 'ux' ? d.command : '')
  expect(decisionsOf([w], []).map(cmd)).toEqual([
    `cd '/home/s l/projets/l'\\''ol' && raf ux L1 "verdict"`,
    'raf ux L2 "verdict"',
    `cd '/home/s l/projets' && cadence orchestrate --resume --wave w1 --answer ol:L3 "…"`,
  ])
  // le chemin réel du dossier des vagues : tel quel, sans guillemets
  const real = wave([wlot('L412', 'question', { project: 'cadence', questions: ['q'] })], { id: '2026-10-29-1650', cwd: '/home/sylvain_ladoire/projects/developpeur', live: false })
  expect(cmd(decisionsOf([real], [])[0]!)).toBe('cd /home/sylvain_ladoire/projects/developpeur && cadence orchestrate --resume --wave 2026-10-29-1650 --answer cadence:L412 "…"')
})

test('L412 R4 — une livraison en échec par projet : la dernière raison et le sha court (7 caractères : deliver écrit le sha entier, 40 caractères qui ne laissaient que 6 caractères de raison à 80 colonnes)', () => {
  const failed: FailedDelivery[] = [{ project: 'maritime', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }, { project: 'cadence', day: '2026-10-29', sha: 'b4d4507a82121e94d3d2427dea25759c9d2fafbf', reason: 'vérification en échec : GET /healthz → 502' }]
  expect(decisionsOf([], failed)).toEqual([
    { kind: 'livraison', project: 'maritime', text: 'abc1234 · CI en échec (2026-10-29)' },
    { kind: 'livraison', project: 'cadence', text: 'b4d4507 · vérification en échec : GET /healthz → 502 (2026-10-29)' },
  ])
  // à 80 colonnes, la raison se lit (avec le sha entier il n'en restait que 6 caractères) ; à 100, la ligne entière
  const { lines } = buildDecisions(decisionsOf([], failed.slice(1)), 80, 10)
  expect(lines[1]!.text).toMatch(/^✖ cadence  livraison : b4d4507 · vérification en échec : GET \/healthz → 502 \(20…$/)
  expect(buildDecisions(decisionsOf([], failed.slice(1)), 100, 10).lines[1]!.text).toBe('✖ cadence  livraison : b4d4507 · vérification en échec : GET /healthz → 502 (2026-10-29)')
})

test('L412 R5 — les vagues finies se lisent dans `ended` (toutes, de la plus récente à la plus ancienne, sans délai de 30 min, à part de la bande), après les vivantes ; un lot n’est compté qu’une fois ; sans vivante, celle que porte `waves` se lit aussi', () => {
  const old = wave([wlot('L9', 'question', { questions: ['q'] }), wlot('L8', 'handed-back', { outcome: 'cause' })], { id: 'old', live: false, ended: '2026-10-29T10:00:00Z' })
  const lots = (d: ReturnType<typeof decisionsOf>) => d.map(x => (x.kind === 'livraison' ? '' : x.lot))
  expect(lots(decisionsOf([], [], [old]))).toEqual(['L9', 'L8'])
  expect(lots(decisionsOf([old], []))).toEqual(['L9', 'L8']) // sans vague vivante, la bande porte la vague finie
  expect(lots(decisionsOf([old], [], [old]))).toEqual(['L9', 'L8']) // la même vague des deux côtés : une fois
  const recent = wave([wlot('L5', 'question', { questions: ['ancienne'] })], { id: 'rec', live: false, ended: '2026-10-29T16:50:00Z' })
  const live = wave([wlot('L5', 'question', { questions: ['vivante'] })], { id: 'liv' })
  const d = decisionsOf([live], [], [recent])
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ text: 'vivante' })
  // le cas de la revue : un lot rendu dans une vague ancienne, trois vagues finies depuis sans rien à décider — il attend toujours
  const quiet = (id: string, ended: string) => wave([wlot('L1', 'ready', { project: 'evatosorus' })], { id, live: false, ended })
  const handed = wave([wlot('L412', 'handed-back', { project: 'cadence', outcome: 'correction non jouée (budget)' })], { id: '1650', live: false, ended: '2026-10-29T16:30:00Z' })
  const finished = [quiet('wo1', '2026-10-29T17:30:00Z'), quiet('ev43', '2026-10-29T17:10:00Z'), quiet('ew1', '2026-10-29T16:50:00Z'), handed]
  expect(decisionsOf([], [], finished)).toEqual([{ kind: 'rendu', project: 'cadence', lot: 'L412', text: 'correction non jouée (budget)' }])
  // la bande porte la plus récente (`waves`), `ended` toutes : la plus récente n'est lue qu'une fois, l'ancienne est lue
  expect(lots(decisionsOf([finished[0]!], [], finished))).toEqual(['L412'])
  // le même lot dans deux vagues finies : la plus récente tranche (repris et rendu à nouveau), l'ancienne est sautée
  const again = wave([wlot('L412', 'handed-back', { project: 'cadence', outcome: 'rendu à nouveau' })], { id: 'later', live: false, ended: '2026-10-29T18:00:00Z' })
  expect(decisionsOf([], [], [again, ...finished]).map(x => (x.kind === 'rendu' ? x.text : ''))).toEqual(['rendu à nouveau'])
})

test('L412 R6 — rien à décider : aucune décision, aucune ligne', () => {
  expect(decisionsOf([wave([wlot('L1', 'reviewing')])], [])).toEqual([])
  expect(buildDecisions([], 60, 10)).toEqual({ lines: [], more: 0 })
})

test('L412 R7 — une question sans texte, ou aux types faux, reste une question (texte vide dit « question sans texte »)', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: [] }), wlot('L6', 'question', { questions: undefined })])], [])
  expect(d.map(x => (x.kind === 'question' ? x.text : ''))).toEqual(['question sans texte', 'question sans texte'])
})

test('L412 R8 — le panneau coupe les textes à la largeur et compte les décisions qu’il ne montre pas', () => {
  const many = Array.from({ length: 6 }, (_, i) => wlot(`L${i}`, 'handed-back', { outcome: 'x'.repeat(100) }))
  const built = buildDecisions(decisionsOf([wave(many)], []), 40, 4)
  expect(built.lines.every(l => l.text.length <= 40)).toBe(true)
  expect(built.lines.length).toBe(4)
  expect(built.more).toBe(4)
  expect(built.lines[3]!.text).toMatch(/\+4 décisions/)
})

test('L412 R9 — les lignes : un titre, puis une ligne par décision, la commande à copier sous une question (de vague finie) ou un verdict', () => {
  const d = decisionsOf([wave([wlot('L5', 'question', { questions: ['Quel format ?'] })], { live: false })], [])
  const { lines } = buildDecisions(d, 120, 10)
  expect(lines[0]!.text).toMatch(/Ce qui attend une décision/)
  expect(lines[1]!.text).toMatch(/ol:L5.*Quel format \?/)
  expect(lines[2]!.text).toMatch(/cd \/p && cadence orchestrate --resume --wave w1 --answer ol:L5 "…"/)
})

test('L412 R10 — journal des livraisons : lu de la sortie du script, une sortie étrangère ou illisible ne donne rien', () => {
  expect(parseDeliveries('[{"project":"a","day":"2026-10-29","sha":"s","reason":"r"},{"project":3},"x"]')).toEqual([{ project: 'a', day: '2026-10-29', sha: 's', reason: 'r' }])
  expect(parseDeliveries('{"waves":[]}')).toEqual([])
  expect(parseDeliveries('pas du json')).toEqual([])
})

const tlot = (id: string): TourLot => ({ id, title: `T ${id}`, status: 'todo', after: [] })

test('L412 R21 — le plan tranche : une décision dont le lot n’est plus ouvert dans un projet lu du tableau disparaît ; un projet absent du tableau, en erreur ou sans lots garde les siennes', () => {
  const w = wave([
    wlot('L1', 'ready', { visible: true, uxVerdict: 'conforme' }), // clos au plan (raf ux puis raf done) : plus rien à poser
    wlot('L2', 'handed-back', { outcome: 'cause' }), // encore ouvert : attend
    wlot('L3', 'question', { questions: ['q'] }), // clos au plan : la question n'a plus d'objet
    wlot('L4', 'question', { questions: ['q'], project: 'maritime' }), // projet absent du tableau : on ne sait pas, elle reste
    wlot('L5', 'handed-back', { project: 'erreur' }), // projet illisible par le tour : reste
    wlot('L6', 'handed-back', { project: 'ancien' }), // ligne sans lots (cadence trop ancien) : reste
  ])
  const board: LotsBoard = { outdated: false, rows: [{ project: 'ol', lots: [tlot('L2'), tlot('L9/1')] }, { project: 'erreur', error: 'plan illisible' }, { project: 'ancien' }] }
  const lots = (d: ReturnType<typeof decisionsOf>) => d.map(x => (x.kind === 'livraison' ? '' : x.lot))
  expect(lots(decisionsOf([w], [], [], board))).toEqual(['L2', 'L4', 'L5', 'L6'])
  expect(lots(decisionsOf([w], [], [], null))).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) // sans tableau lu, rien n'est écarté
  // une sous-tâche ouverte se reconnaît par son id complet ; une livraison en échec ne dépend pas du plan
  const sub = wave([wlot('L9/1', 'question', { questions: ['q'] }), wlot('L9/2', 'question', { questions: ['q'] })])
  const failed: FailedDelivery[] = [{ project: 'ol', day: '2026-10-29', sha: 'abc1234', reason: 'CI en échec' }]
  expect(decisionsOf([sub], failed, [], board).map(x => (x.kind === 'livraison' ? x.kind : x.lot))).toEqual(['L9/1', 'livraison'])
})

/** Ce que le shell lit des lignes collées : le retrait ôté, `\` en fin de ligne efface le saut de ligne (le shell joint, l'espace qui précède `\` reste). */
const pasted = (lines: readonly string[]): string => lines.map(l => l.replace(/^ {3}/, '')).join('\n').replace(/\\\n/g, '')

test('L412 R22 — la commande à copier se replie sur plusieurs lignes à la largeur, aux espaces, jamais coupée par « … » ; le plafond du bloc compte les lignes repliées', () => {
  const q = wave([wlot('Q4/accueil-4-ux12', 'question', { questions: ['Quel titre ?'], project: 'maritime-atlas' })], { id: '2026-10-29-1650', cwd: '/p', live: false })
  const command = 'cd /p && cadence orchestrate --resume --wave 2026-10-29-1650 --answer maritime-atlas:Q4/accueil-4-ux12 "…"'
  const { lines } = buildDecisions(decisionsOf([q], []), 70, 20)
  const cmd = lines.slice(2)
  expect(cmd.length).toBeGreaterThan(1)
  expect(cmd.every(l => l.text.length <= 70 && l.tone === 'subtle' && l.text.startsWith('   '))).toBe(true)
  expect(pasted(cmd.map(l => l.text))).toBe(command) // recopiable : rien de perdu
  expect(cmd.map(l => l.text)).toEqual(['   cd /p && cadence orchestrate --resume --wave 2026-10-29-1650 \\', '   --answer maritime-atlas:Q4/accueil-4-ux12 "…"'])
  // le plafond compte le titre, la ligne de la question et ses 2 lignes de commande : 4 lignes
  expect(buildDecisions(decisionsOf([q], []), 70, 4)).toMatchObject({ more: 0 })
  expect(buildDecisions(decisionsOf([q], []), 70, 4).lines).toHaveLength(4)
  const short = buildDecisions(decisionsOf([q], []), 70, 3)
  expect(short.more).toBe(1)
  expect(short.lines.map(l => l.text)).toEqual(['Ce qui attend une décision (1)', '… +1 décision de plus'])
  // large : une seule ligne, sans continuation ; un mot plus long que la ligne est coupé sans « … » ; une largeur nulle ne donne rien de plus long qu'elle
  expect(wrapCommand(command, 120)).toEqual([`   ${command}`])
  expect(wrapCommand('a bbbbbbbbbb c', 9)).toEqual(['   a \\', '   bbbb\\', '   bbbb\\', '   bb c'])
  expect(wrapCommand('raf ux L1 "verdict"', 1).every(l => l.length <= 1)).toBe(true)
})

test('L412 R24 — aucune ligne repliée n’est une commande exécutable seule : chaque ligne sauf la dernière finit par la continuation ` \\` (`\\` collé quand un mot est coupé), et les lignes collées dans un shell redonnent la commande', () => {
  const command = 'cadence orchestrate --resume --wave 2026-10-29-1650 --answer maritime-atlas:Q4/accueil-4-ux12 "…"'
  // le cas de la revue : entre 54 et 62 colonnes, la ligne 1 tenait `--resume --wave <vague>` seule et s’exécutait sans `--answer`
  expect(wrapCommand(command, 62)).toEqual(['   cadence orchestrate --resume --wave 2026-10-29-1650 \\', '   --answer maritime-atlas:Q4/accueil-4-ux12 "…"'])
  expect(wrapCommand(command, 60)).toEqual(['   cadence orchestrate --resume --wave 2026-10-29-1650 \\', '   --answer maritime-atlas:Q4/accueil-4-ux12 "…"'])
  expect(wrapCommand(command, 54)).toEqual(['   cadence orchestrate --resume --wave \\', '   2026-10-29-1650 --answer \\', '   maritime-atlas:Q4/accueil-4-ux12 "…"'])
  expect(wrapCommand(command, 70)).toEqual(['   cadence orchestrate --resume --wave 2026-10-29-1650 --answer \\', '   maritime-atlas:Q4/accueil-4-ux12 "…"'])
  for (const columns of [54, 60, 62, 70, 9, 37]) {
    const lines = wrapCommand(command, columns)
    expect(lines.every(l => l.length <= columns), `${columns} colonnes`).toBe(true)
    expect(lines.slice(0, -1).every(l => l.endsWith('\\')), `${columns} colonnes : continuation`).toBe(true)
    expect(lines.at(-1)?.endsWith('\\'), `${columns} colonnes : dernière ligne`).toBe(false)
    expect(pasted(lines), `${columns} colonnes : collage`).toBe(command)
  }
  // un mot coupé (largeur sous le mot le plus long) : `\` collé au morceau, le shell recolle le mot ; joindre les lignes par un espace ne redonnerait PAS la commande
  const cut = wrapCommand(command, 30)
  expect(cut.some(l => l.endsWith('\\') && !l.endsWith(' \\'))).toBe(true)
  expect(pasted(cut)).toBe(command)
  expect(cut.map(l => l.trim()).join(' ')).not.toBe(command)
})
