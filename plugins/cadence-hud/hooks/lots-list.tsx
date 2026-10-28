import type { ClientModule } from 'claude-code'

import { lotRow } from './lot-row'
import type { RowMark } from './lot-row'
import type { PanelLot } from './lots'

// ── L402 : les lots d'un projet dans le panneau, réordonnables à la souris (glisser-déposer) et au clavier (Alt+↑ / Alt+↓) ──
// Région Client : elle ne connaît que ses lignes ; le dépôt est posté au module de hooks, qui contrôle la demande et lance raf.

type Props = { project: string; lines: PanelLot[] }
type State = { selected?: string; drag?: { from: number; over: number } }

/** L'état le plus récent de chaque instance : `surface.state` ne change qu'à l'image suivante, or un geste rapide peut en enchaîner deux dans la même (la clé est l'objet `surface`, le même d'un appel à l'autre). */
const live = new WeakMap<object, State>()

const List: ClientModule<Props, State> = (props, surface) => {
  const { lines, project } = props
  const current = (): State => live.get(surface) ?? surface.state ?? {}
  const keep = (next: State) => {
    live.set(surface, next)
    surface.setState(next)
  }
  const at = (id: string | undefined) => lines.findIndex(l => l.id === id)
  /** La ligne qui couvre la rangée `y` de la région (une ligne d'`after:` à part en prend deux) ; hors région, la plus proche. */
  const rowAt = (y: number) => {
    let top = 0
    for (let i = 0; i < lines.length; i++) {
      top += lines[i]!.afterOwnLine ? 2 : 1
      if (y < top) return i
    }
    return lines.length - 1
  }
  const ask = (from: number, to: number, place: 'before' | 'after') => surface.post({ kind: 'move', project, id: lines[from]!.id, target: lines[to]!.id, place })

  surface.onPointer(e => {
    if (e.button !== 'left') return // un survol n'a pas de bouton
    const { drag, selected } = current()
    if (e.type === 'down') {
      const i = rowAt(e.y)
      keep({ selected: lines[i]!.id, drag: { from: i, over: i } })
    } else if (e.type === 'move' && drag) {
      keep({ selected, drag: { from: drag.from, over: rowAt(e.y) } })
    } else if (e.type === 'up' && drag) {
      const { from } = drag
      const over = rowAt(e.y)
      keep({ selected })
      if (over !== from) ask(from, over, over > from ? 'after' : 'before')
    }
  })

  surface.onKey(k => {
    if (k.key !== 'up' && k.key !== 'down') return
    const step = k.key === 'up' ? -1 : 1
    const cur = at(current().selected)
    if (!k.meta) {
      const i = cur < 0 ? (step > 0 ? 0 : lines.length - 1) : Math.min(lines.length - 1, Math.max(0, cur + step))
      keep({ selected: lines[i]!.id })
      return
    }
    if (cur < 0) return
    // le frère voisin : les lignes d'un autre groupe (les sous-tâches du lot voisin) ne comptent pas
    let to = cur + step
    while (to >= 0 && to < lines.length && lines[to]!.group !== lines[cur]!.group) to += step
    if (to >= 0 && to < lines.length) ask(cur, to, step < 0 ? 'before' : 'after')
  })

  const state = current()
  const { Box } = surface.elements
  const mark = (i: number): RowMark | undefined => {
    const { drag } = state
    if (drag && drag.over !== drag.from) {
      if (i === drag.from) return { glyph: '●', color: 'claude' }
      if (i === drag.over) return lines[i]!.group !== lines[drag.from]!.group ? { glyph: '⊘', color: 'error' } : { glyph: drag.over > drag.from ? '⇣' : '⇡', color: 'claude' }
    }
    return lines[i]!.id === state.selected ? { glyph: '▸', color: 'claude' } : undefined
  }
  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line, i) => lotRow(surface.elements, line, `l${i}`, mark(i), state.drag && state.drag.over !== state.drag.from && i === state.drag.over ? 'target' : line.id === state.selected ? 'selected' : undefined))}
    </Box>
  )
}

export default List
