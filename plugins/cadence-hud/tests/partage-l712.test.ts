import { expect, test } from 'claude-code/testing'

import { besoinArbre, buildPanel, horsVue } from '../hooks/lots'
import { CEDENT, lignesDuBloc, partage } from '../hooks/partage'
import type { LotsRow, TourLot } from '../types'

// ── L712 (D-20) : l'arbre des lots d'abord dans le partage de la hauteur du panneau ──

const lot = (id: string, status: 'todo' | 'doing' = 'todo'): TourLot => ({ id, title: `Titre ${id}`, status, after: [] })
const row = (project: string, lots: TourLot[]): LotsRow => ({ project, lots })
/** La capture du 12-11 : cadence a L679 en cours ; au-dessus de l'arbre, 3 lignes de décisions, 2 de dépenses, 3 de livraisons et le banc (titre et 5 passages). */
const CAPTURE = { decisions: 3, depenses: 2, livraisons: 3, banc: 6 }
const BOARD = [row('cadence', [lot('L679', 'doing'), lot('L680'), lot('L681')]), row('ol', [lot('L80')])]
const input = (rows: LotsRow[] = BOARD) => ({ rows, columns: 70, waves: [], now: 0 })
const lotsOf = (rows: LotsRow[], height: number) => buildPanel({ ...input(rows), height }).lines.filter(l => l.kind === 'lot').map(l => (l as { id: string }).id)

test('L712 — la répartition de la capture : avant L712 l’arbre n’avait plus de quoi montrer un lot', () => {
  const corps = 18
  const avant = corps - Object.values(CAPTURE).reduce((a, b) => a + b, 0)
  expect(lotsOf(BOARD, avant)).toEqual([]) // le panneau disait alors « Aucun lot non clos »
  const h = partage(corps, besoinArbre(input(), corps), CAPTURE)
  const reste = corps - Object.values(h).reduce((a, b) => a + b, 0)
  expect(lotsOf(BOARD, reste)).toContain('L679')
  expect(h.banc).toBeLessThan(CAPTURE.banc) // le banc a cédé en premier
  expect(h.decisions).toBe(CAPTURE.decisions) // les décisions, en dernier, restent entières
})

test('L712 — l’ordre de repli : banc, livraisons, dépenses, décisions en une ligne, puis à zéro dans le même ordre', () => {
  expect(CEDENT).toEqual(['banc', 'livraisons', 'depenses', 'decisions'])
  const t = { decisions: 4, depenses: 3, livraisons: 3, banc: 6 }
  expect(partage(40, 10, t)).toEqual(t) // la place suffit : rien ne bouge
  expect(partage(21, 10, t)).toEqual({ decisions: 4, depenses: 3, livraisons: 3, banc: 1 })
  expect(partage(20, 10, t)).toEqual({ decisions: 4, depenses: 3, livraisons: 1, banc: 1 })
  expect(partage(18, 10, t)).toEqual({ decisions: 4, depenses: 1, livraisons: 1, banc: 1 })
  expect(partage(16, 10, t)).toEqual({ decisions: 1, depenses: 1, livraisons: 1, banc: 1 })
  expect(partage(13, 10, t)).toEqual({ decisions: 1, depenses: 1, livraisons: 1, banc: 0 })
  expect(partage(12, 10, t)).toEqual({ decisions: 1, depenses: 1, livraisons: 0, banc: 0 })
  expect(partage(11, 10, t)).toEqual({ decisions: 1, depenses: 0, livraisons: 0, banc: 0 })
  expect(partage(10, 10, t)).toEqual({ decisions: 0, depenses: 0, livraisons: 0, banc: 0 })
  expect(partage(3, 10, t)).toEqual({ decisions: 0, depenses: 0, livraisons: 0, banc: 0 })
})

test('L712 — un lot en dépassement garde sa ligne ⚠ (plancher, L414)', () => {
  const t = { decisions: 4, depenses: 3, livraisons: 3, banc: 6 }
  expect(partage(5, 10, t, { depenses: 1 })).toEqual({ decisions: 0, depenses: 1, livraisons: 0, banc: 0 })
})

test('L712 — lignesDuBloc : toutes, la ligne repliée, ou rien', () => {
  expect(lignesDuBloc(['t', 'a', 'b'], 't · 2', 3)).toEqual(['t', 'a', 'b'])
  expect(lignesDuBloc(['t', 'a', 'b'], 't · 2', 1)).toEqual(['t · 2'])
  expect(lignesDuBloc(['t', 'a', 'b'], 't · 2', 0)).toEqual([])
  expect(lignesDuBloc([], undefined, 1)).toEqual([])
})

test('L712 — besoinArbre : la plus petite hauteur qui montre le projet en cours, même placé après un autre', () => {
  const many = row('ol', ['L80', 'L81', 'L82', 'L83', 'L84', 'L85'].map(id => lot(id)))
  const rows = [many, row('cadence', [lot('L679', 'doing')])]
  const need = besoinArbre(input(rows), 60)
  expect(lotsOf(rows, need)).toContain('L679')
  expect(lotsOf(rows, need - 1)).not.toContain('L679')
})

test('L712 — besoinArbre : sans projet en cours, la hauteur d’un premier lot ; sans lot, une ligne ; trop petit, tout le corps', () => {
  const rows = [row('ol', [lot('L80'), lot('L81')])]
  const need = besoinArbre(input(rows), 60)
  expect(lotsOf(rows, need)).toContain('L80')
  expect(lotsOf(rows, need - 1)).toEqual([])
  expect(besoinArbre(input([row('ol', [])]), 60)).toBe(1)
  expect(besoinArbre(input(BOARD), 2)).toBe(2)
})

test('L712 — hauteurs réduites, de 30 à 4 lignes : dès que le corps le permet, le lot en cours est montré', () => {
  const seul = besoinArbre(input(), 60)
  for (let corps = 30; corps >= 4; corps--) {
    const h = partage(corps, besoinArbre(input(), corps), CAPTURE)
    const reste = corps - Object.values(h).reduce((a, b) => a + b, 0)
    expect(reste).toBeGreaterThanOrEqual(0)
    if (corps >= seul) expect(lotsOf(BOARD, reste)).toContain('L679')
    else expect(Object.values(h).every(n => n === 0)).toBe(true) // tout le corps va à l'arbre, qui dira qu'il manque de place
  }
})

// ── L712, suite de revue : la vision de l'avancement d'abord — chaque lot en cours de chaque projet, où qu'il soit dans priority: ──

/** 13 projets de `n` lots chacun ; le projet au rang `rang` (1 = le premier de priority:) a son premier lot en cours, placé où le plan le met (au milieu de ses lots). */
const treize = (rang: number, n: number): LotsRow[] =>
  Array.from({ length: 13 }, (_, i) => {
    const p = i + 1 === rang ? 'cadence' : `p${i + 1}`
    return row(p, Array.from({ length: n }, (_, j) => lot(`${p.toUpperCase()}-${j + 1}`, i + 1 === rang && j === Math.floor(n / 2) ? 'doing' : 'todo')))
  })
const enCoursId = (rang: number, n: number) => `CADENCE-${Math.floor(n / 2) + 1}`

test('L712 — 13 projets, le projet en cours 7e ou 13e de priority:, 3 ou 12 lots par projet : de 16 à 50 lignes, son lot en cours est montré, avec le nom de son projet', () => {
  for (const rang of [1, 7, 13])
    for (const n of [3, 12]) {
      const rows = treize(rang, n)
      for (let corps = 16; corps <= 50; corps++) {
        const h = partage(corps, besoinArbre(input(rows), corps), CAPTURE)
        const reste = corps - Object.values(h).reduce((a, b) => a + b, 0)
        const p = buildPanel({ ...input(rows), height: reste })
        const ids = p.lines.filter(l => l.kind === 'lot').map(l => (l as { id: string }).id)
        expect({ rang, n, corps, montre: ids.includes(enCoursId(rang, n)) }).toEqual({ rang, n, corps, montre: true })
        const at = p.lines.findIndex(l => l.kind === 'lot' && l.id === enCoursId(rang, n))
        const projet = p.lines.slice(0, at).reverse().find(l => l.kind === 'project')
        expect(projet).toMatchObject({ kind: 'project', name: 'cadence' })
        expect(p.enCours).toBe(0)
      }
    }
})

test('L712 — à toute hauteur au moins égale à besoinArbre, tous les lots en cours sont montrés (aucune monotonie supposée de buildPanel)', () => {
  for (const rang of [1, 7, 13])
    for (const n of [3, 12]) {
      const rows = treize(rang, n)
      const need = besoinArbre(input(rows), 200)
      for (let h = need; h <= 120; h++) expect({ h, ids: lotsOf(rows, h).includes(enCoursId(rang, n)) }).toEqual({ h, ids: true })
      expect(lotsOf(rows, need - 1)).not.toContain(enCoursId(rang, n))
    }
})

test('L712 — les lots en cours avant tout lot à faire de n’importe quel projet : le projet en cours 13e passe avant les lots des 12 premiers', () => {
  const rows = treize(13, 3)
  const p = buildPanel({ ...input(rows), height: 8 })
  // 5 lignes pour l'arbre : cadence et son lot en cours d'abord, puis le premier projet et deux de ses lots, dans l'ordre d'affichage
  expect(p.lines.map(l => (l.kind === 'project' ? l.name : l.kind === 'lot' ? l.id : l.kind))).toEqual(['p1', 'P1-1', 'P1-2', 'cadence', 'CADENCE-2'])
  expect(p.enCours).toBe(0)
  expect(p.more).toBe(13 * 3 - 3)
  expect(horsVue(p)).toBe('… +36 lots de plus')
})

test('L712 — même les lots en cours ne tiennent pas : ceux qui manquent sont comptés à part, jamais absents sans ligne', () => {
  // 13 projets, chacun avec un lot en cours et deux à faire ; 9 lignes de corps : 7 pour l'arbre, le pied compte le reste
  const rows = Array.from({ length: 13 }, (_, i) => row(`p${i + 1}`, [lot(`A${i + 1}`, 'doing'), lot(`B${i + 1}`), lot(`C${i + 1}`)]))
  const p = buildPanel({ ...input(rows), height: 9 })
  expect(p.lines.every(l => l.kind === 'project' || (l.kind === 'lot' && l.id.startsWith('A')))).toBe(true) // aucun lot à faire tant qu'un lot en cours manque
  expect(lotsOf(rows, 9)).toEqual(['A1', 'A2', 'A3'])
  expect(p.enCours).toBe(10)
  expect(p.more).toBe(13 * 3 - 3)
  expect(horsVue(p)).toBe('… +10 lots en cours non affichés · +26 lots de plus')
  expect(horsVue({ more: 1, enCours: 1 })).toBe('… +1 lot en cours non affiché')
  // tout tient sauf un lot à faire : le pied ne parle que de lui
  expect(horsVue(buildPanel({ ...input(rows), height: 2 + 13 * 2 + 1 }))).toBe('… +26 lots de plus')
})

test('L712 — un lot en cours sous un lot replié : le parent passe avec lui, et s’il manque, le sous-lot en cours est compté', () => {
  const rows = [row('a', [lot('A1'), lot('A2'), lot('A3')]), row('b', [lot('B1'), { ...lot('B1/1', 'doing'), parent: 'B1' }, lot('B2')])]
  const p = buildPanel({ ...input(rows), height: 5 })
  expect(p.lines.map(l => (l.kind === 'project' ? l.name : l.kind === 'lot' ? l.id : l.kind))).toEqual(['b', 'B1'])
  expect(buildPanel({ ...input(rows), height: 3 }).enCours).toBe(1)
})
