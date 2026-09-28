// Text an owner writes for people to read on a form: a hint under a question,
// the supporting text under a heading, a statement. Line breaks are kept, and
// a line that starts with a dot point is a dot point, the way it is in any
// document. Nothing else is interpreted: no bold, no links, no numbering.

// "•" from the builder's button or a paste from Word. "-", "*" and "–" only
// when a space follows, so "-5 kg" and "*Conditions apply" stay as written.
const LEADING_POINT = /^\s*(?:•|[-*–](?=\s))\s*/;

/**
 * Splits one line into any lead-in text and the dot points on it.
 *
 * A "•" part way along a line is a dot point too. That is how points get
 * written when the box they are typed into has no new line — the hint was a
 * single-line box until this change — and it is never punctuation.
 */
export function dotPointParts(line) {
  const text = String(line ?? '');
  const leading = LEADING_POINT.exec(text);
  const [first, ...rest] = (leading ? text.slice(leading[0].length) : text).split('•').map(part => part.trim());
  const others = rest.filter(Boolean);
  if (leading) return { marked: true, lead: '', points: [first, ...others].filter(Boolean) };
  if (!others.length) return { marked: false, lead: text, points: [] };
  return { marked: true, lead: first, points: others };
}

/**
 * The blocks to render: runs of text, and lists.
 *
 * Text runs keep their own line breaks and blank lines, so text with no dot
 * points renders exactly as it did before. Points separated by blank lines
 * are still one list, spaced apart ("loose"), because that is how the signed
 * agreements lay theirs out.
 */
export function formTextBlocks(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  /** @type {string[] | null} */
  let text = null;
  /** @type {{ type: 'list', items: string[], loose: boolean } | null} */
  let list = null;
  let gap = false;
  const closeText = () => {
    const joined = text?.join('\n').replace(/\s+$/, '');
    if (joined) blocks.push({ type: 'text', text: joined });
    text = null;
  };
  const closeList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const addText = line => {
    closeList();
    if (!text) text = [];
    text.push(line);
  };
  for (const line of lines) {
    const { marked, lead, points } = dotPointParts(line);
    if (!marked || !points.length) {
      // A bare "•" with nothing after it is a point not written yet.
      if (!line.trim() || marked) {
        if (list) gap = true;
        else if (text) text.push('');
        continue;
      }
      addText(lead);
      continue;
    }
    if (lead) addText(lead);
    closeText();
    if (!list) list = { type: 'list', items: [], loose: false };
    else if (gap) list.loose = true;
    gap = false;
    list.items.push(...points);
  }
  closeText();
  closeList();
  return blocks;
}

const MARKER = '• ';

function lineBounds(text, start, end) {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const next = text.indexOf('\n', end);
  return { from, to: next === -1 ? text.length : next };
}

/**
 * The builder's "Dot points" button, as a word processor does it: the lines
 * the cursor or selection touches become dot points, or stop being dot points
 * if they all already are. Returns the new text and where the selection goes.
 */
export function toggleDotPoints(value, selectionStart = 0, selectionEnd = selectionStart) {
  const text = String(value ?? '');
  const { from, to } = lineBounds(text, selectionStart, selectionEnd);
  const lines = text.slice(from, to).split('\n');
  const written = lines.filter(line => line.trim());
  const allPoints = written.length > 0 && written.every(line => {
    const { marked, lead } = dotPointParts(line);
    return marked && !lead;
  });
  const changed = allPoints
    ? lines.map(line => line.replace(LEADING_POINT, ''))
    : written.length === 0
      ? [MARKER]
      : lines.flatMap(line => {
        if (!line.trim()) return [line];
        const { marked, lead, points } = dotPointParts(line);
        if (!marked) return [`${MARKER}${line.trim()}`];
        // Points already typed along one line go onto a line each; the words
        // before the first one stay as the lead-in.
        return [...(lead ? [lead] : []), ...points.map(point => `${MARKER}${point}`)];
      });
  const replaced = changed.join('\n');
  const result = text.slice(0, from) + replaced + text.slice(to);
  const caret = from + replaced.length;
  return { text: result, selectionStart: lines.length > 1 ? from : caret, selectionEnd: caret };
}

/**
 * Enter inside a dot point starts the next one; Enter on an empty dot point
 * ends the list. Returns null when Enter should just be a new line.
 */
export function continueDotPoints(value, cursor) {
  const text = String(value ?? '');
  const { from, to } = lineBounds(text, cursor, cursor);
  const line = text.slice(from, to);
  const leading = LEADING_POINT.exec(line);
  if (!leading || cursor < from + leading[0].length) return null;
  if (!line.slice(leading[0].length).trim()) {
    const result = text.slice(0, from) + text.slice(to);
    return { text: result, selectionStart: from, selectionEnd: from };
  }
  const inserted = `\n${MARKER}`;
  const result = text.slice(0, cursor) + inserted + text.slice(cursor).replace(/^[ \t]+/, '');
  const caret = cursor + inserted.length;
  return { text: result, selectionStart: caret, selectionEnd: caret };
}
