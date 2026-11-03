import { FIELDS, RafError, STATUSES, type Field, type Lot, type PlanFormat } from './plan.js';
import { normalizeLot } from './plan-read.js';

/** Lit une liste écrite dans un autre format : champs traduits, entrées à parent repliées en sous-tâches. */
export function foreignLots(raw: Record<string, unknown>[], format: PlanFormat): Lot[] {
  const entries = raw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RafError(`entrée n° ${i + 1} du plan : un objet est attendu`);
    const pick = (field: Field): unknown => {
      for (const key of format.fields[field] ?? [field]) if (r[key] != null) return r[key];
      return undefined;
    };
    // Un horodatage vaut pour son jour.
    const day = (field: Field): unknown => {
      const v = pick(field);
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v;
    };
    const id = pick('id');
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
      throw new RafError(`entrée n° ${i + 1} du plan : identifiant absent`);
    }
    const problems: string[] = [];
    const theirs = pick('status');
    const mapped = Object.keys(format.statuses).length > 0;
    if (mapped && theirs != null && !Object.hasOwn(format.statuses, String(theirs))) {
      problems.push(`état « ${String(theirs)} » sans correspondance (cadence.yaml : plan.statuses)`);
    }
    const effort = pick('estimate');
    if (typeof effort === 'string' && !(effort in format.estimates)) {
      problems.push(`effort « ${effort} » sans correspondance (cadence.yaml : plan.estimates)`);
    }
    const notes = pick('notes');
    const lot = normalizeLot(
      {
        id,
        title: pick('title'),
        status: mapped ? (Object.hasOwn(format.statuses, String(theirs)) ? format.statuses[String(theirs)] : undefined) : theirs,
        estimate: typeof effort === 'string' ? format.estimates[effort] : effort,
        quickwin: pick('quickwin'),
        visible: pick('visible'),
        screen: pick('screen'),
        // Le `spec:` d'un plan tenu par un autre outil n'est à nous que s'il est mappé, et seul `true` compte : ailleurs c'est souvent un chemin de document (L198).
        spec: format.fields.spec && pick('spec') === true ? true : undefined,
        public: pick('public'),
        every: pick('every'),
        last: day('last'),
        after: pick('after'),
        created: day('created'),
        started: day('started'),
        finished: day('finished'),
        notes: typeof notes === 'string' ? [{ text: notes }] : notes,
        repos: pick('repos'),
        gate: pick('gate'),
        goal: pick('goal'),
      },
      problems,
    );
    const parent = pick('parent');
    return { lot, parent: parent == null ? undefined : String(parent) };
  });
  const top = new Map(entries.filter((e) => !e.parent).map((e) => [e.lot.id, e.lot]));
  const lots: Lot[] = [];
  for (const { lot, parent } of entries) {
    const into = parent ? top.get(parent) : undefined;
    if (into && lot.id.startsWith(`${into.id}/`)) {
      into.tasks.push({ id: lot.id.slice(into.id.length + 1), title: lot.title, status: lot.status });
      into.problems.push(...lot.problems.map((p) => `${lot.id} : ${p}`));
    } else {
      lots.push(parent ? { ...lot, parent } : lot);
    }
  }
  return lots;
}
