import { expect, test } from 'claude-code/testing'

import { besoinArbre, buildPanel } from '../hooks/lots'
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
