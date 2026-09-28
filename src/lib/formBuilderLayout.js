// How the form builder lays a form out: each section break owns the fields
// after it, up to the next section break, the way a respondent meets them. The
// stored list stays flat — skip rules are positions in it — so grouping is
// only ever a view of that list, and every move maps back onto it.

const isSection = field => field?.type === 'section_break';

/**
 * The rows the builder shows. A collapsed section is one row that stands for
 * itself and everything under it (`span`); what it hides is left out. Fields
 * before the first section belong to no section.
 */
export function builderRows(questions = [], collapsed = new Set()) {
  const rows = [];
  let section = null;
  questions.forEach((field, index) => {
    if (isSection(field)) {
      let end = index + 1;
      while (end < questions.length && !isSection(questions[end])) end += 1;
      const childCount = end - index - 1;
      const folded = collapsed.has(field.id);
      section = { id: field.id, index, folded };
      rows.push({ index, field, section: true, depth: 0, childCount, folded, span: folded ? childCount + 1 : 1, lastInGroup: folded || childCount === 0 });
      return;
    }
    if (section?.folded) return;
    const next = questions[index + 1];
    rows.push({ index, field, section: false, depth: section ? 1 : 0, sectionId: section?.id ?? null, childCount: 0, folded: false, span: 1, lastInGroup: Boolean(section) && (!next || isSection(next)) });
  });
  return rows;
}

/**
 * Applies a drag between two visible rows, the way @hello-pangea/dnd reports
 * it: `to` is the row's position once the dragged row has been taken out. A
 * collapsed section moves with everything under it.
 */
export function moveVisibleRow(questions, rows, from, to) {
  const moving = rows[from];
  if (!moving || from === to) return questions;
  const block = questions.slice(moving.index, moving.index + moving.span);
  const rest = [...questions.slice(0, moving.index), ...questions.slice(moving.index + moving.span)];
  const others = rows.filter((_, position) => position !== from);
  const target = others[to];
  let insertAt = rest.length;
  if (target) insertAt = target.index > moving.index ? target.index - moving.span : target.index;
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}

/** Where a field added to the section containing `index` goes: after its last field. */
export function sectionEnd(questions = [], index = -1) {
  let end = index + 1;
  while (end < questions.length && !isSection(questions[end])) end += 1;
  return end;
}

/** The section break that `index` sits under, if any. */
export function sectionOf(questions = [], index = -1) {
  for (let position = index; position >= 0; position -= 1) {
    if (isSection(questions[position])) return questions[position];
  }
  return null;
}
