import type { ClientModule } from 'claude-code'

import { lotRow } from './lot-row'
import type { RowMark } from './lot-row'
import type { PanelLot } from './lots'

// ── L402 : les lots d'un projet dans le panneau, réordonnables à la souris (glisser-déposer) et au clavier (Alt+↑ / Alt+↓) ──
// Région Client : elle ne connaît que ses lignes ; le dépôt est posté au module de hooks, qui contrôle la demande et lance raf.

type Props = { project: string; lines: PanelLot[] }
/** Le glisser retient le lot saisi par son id, pas par sa ligne : les props changent pendant un geste (relecture du tableau), les indices bougent avec elles. */
type State = { selected?: string; drag?: { id: string; over: number } }

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
  /** La ligne que le glisser tient dans les props d'à présent, `-1` si le lot saisi a disparu. */
  const grabbed = (drag: NonNullable<State['drag']> | undefined) => (drag ? at(drag.id) : -1)
  const ask = (from: number, to: number, place: 'before' | 'after') => surface.post({ kind: 'move', project, id: lines[from]!.id, target: lines[to]!.id, place })
  /** Déplie ou replie les sous-lots d'un lot (L411) : la région ne connaît que ses lignes, le module de hooks garde le choix. */
  const toggle = (i: number) => {
    const subs = lines[i]!.subs
    if (subs) surface.post({ kind: 'toggle', project, key: subs.key })
  }
  /** La cellule ▸/▾ d'un lot à sous-lots : la dernière de son retrait, collée à l'id. */
  const onToggleCell = (i: number, x: number) => lines[i]!.subs !== undefined && x === lines[i]!.lead.length - 1

  surface.onPointer(e => {
    if (e.button !== 'left') return // un survol n'a pas de bouton
    const { drag, selected } = current()
    if (e.type === 'down') {
      const i = rowAt(e.y)
      if (onToggleCell(i, e.x)) {
        // un appui sur la bascule déplie ou replie, sans commencer de glisser ; la ligne est sélectionnée comme à tout appui
        keep({ selected: lines[i]!.id })
        toggle(i)
        return
      }
      keep({ selected: lines[i]!.id, drag: { id: lines[i]!.id, over: i } })
    } else if (e.type === 'move' && drag) {
      keep({ selected, drag: { id: drag.id, over: rowAt(e.y) } })
    } else if (e.type === 'up' && drag) {
      const from = grabbed(drag) // retrouvé à l'arrivée : le lot saisi a pu changer de ligne, ou disparaître (rien n'est alors demandé)
      const over = rowAt(e.y)
      keep({ selected })
      if (from >= 0 && over !== from) ask(from, over, over > from ? 'after' : 'before')
    }
  })

  surface.onKey(k => {
    if (k.key === 'return') {
      // Entrée sur la ligne sélectionnée : la bascule de ses sous-lots (rien sur un lot sans sous-lot)
      const cur = at(current().selected)
      if (cur >= 0) toggle(cur)
      return
    }
    if (k.key !== 'up' && k.key !== 'down') return
    const step = k.key === 'up' ? -1 : 1
    const cur = at(current().selected)
    if (!k.meta) {
      const i = cur < 0 ? (step > 0 ? 0 : lines.length - 1) : Math.min(lines.length - 1, Math.max(0, cur + step))
      keep({ selected: lines[i]!.id })
      return
    }
    if (cur < 0) return
    // le frère voisin AFFICHÉ : les lignes d'un autre groupe (les sous-tâches du lot voisin) ne comptent pas, et un lot caché (sous-lots repliés,
    // reste du projet derrière « + N lots », L411) n'est pas une ligne : au bord des lignes affichées, rien ne part
    let to = cur + step
    while (to >= 0 && to < lines.length && lines[to]!.group !== lines[cur]!.group) to += step
    if (to >= 0 && to < lines.length) ask(cur, to, step < 0 ? 'before' : 'after')
  })

  const state = current()
  const { Box } = surface.elements
  const held = grabbed(state.drag)
  const hover = state.drag?.over ?? -1
  const dragging = held >= 0 && hover !== held // un lot disparu pendant le geste ne laisse aucun repère
  const mark = (i: number): RowMark | undefined => {
    if (dragging) {
      if (i === held) return { glyph: '●', color: 'claude' }
      if (i === hover) return lines[i]!.group !== lines[held]!.group ? { glyph: '⊘', color: 'error' } : { glyph: hover > held ? '⇣' : '⇡', color: 'claude' }
    }
    return lines[i]!.id === state.selected ? { glyph: '▸', color: 'claude' } : undefined
  }
  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line, i) => lotRow(surface.elements, line, `l${i}`, { mark: mark(i), emphasis: dragging && i === hover ? 'target' : line.id === state.selected ? 'selected' : undefined }))}
    </Box>
  )
}

export default List
