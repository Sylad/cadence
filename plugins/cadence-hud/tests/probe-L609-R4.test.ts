import { expect, test } from 'claude-code/testing'

import { estClos, foldWave } from '../hooks/lots'
import type { LotsRow } from '../types'

const wl = (lot: string, project = 'ol') => ({ project, lot })
const board = (rows: LotsRow[]) => ({ rows, outdated: false })

test('R4 probe — estClos : absent, vide, id inconnu', () => {
  expect(estClos(undefined, 'L1')).toBe(false)
  expect(estClos([], 'L1')).toBe(false)
  expect(estClos([{ id: 'L10', finished: 'x' }] as LotsRow['closed'], 'L1')).toBe(false)
})

test('R4 probe — foldWave : aucun lot, liste vide', () => {
  expect(foldWave(board([]), [])).toEqual({ open: [], livres: 0, clos: 0 })
})

test('R4 probe — foldWave : ligne de projet en erreur, lots listés', () => {
  const rows = [{ project: 'ol', error: 'illisible' }] as unknown as LotsRow[]
  expect(foldWave(board(rows), [wl('L1')])).toMatchObject({ livres: 0, clos: 0 })
})
