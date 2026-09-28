import assert from 'node:assert/strict';
import test from 'node:test';
import { continueDotPoints, dotPointParts, formTextBlocks, toggleDotPoints } from '../src/lib/formText.js';
import { XERT_TERMS_FORM_DEFINITION } from '../src/lib/xertTermsForm.js';
import { XERT_CONTRACTOR_FORM_DEFINITION } from '../src/lib/xertContractorForm.js';
import { XERT_PEQ_FORM_DEFINITION } from '../src/lib/xertPeqForm.js';

// The hint under a question was a one-line box, and the form showed it as one
// paragraph. An owner who wanted dot points typed "•" between them, and every
// point ran into the next.

// Word for word what the contractor form's Q10 hint says on the live form.
const KIRRA = 'Circumstances requiring a new copy of this agreement to be signed • Changing from Personal Trainer to Group Trainer • Changing from Group Trainer to Personal Trainer • Adding the responsibility to train Group Classes whilst still Personal Training • Adding the responsibility to do Personal Training, whilst conducting Group Classes • Choosing to no longer conduct Group Classes and / or Personal Training at the same time, and to just provide one of these services;';

test('points already typed along one line show as a list, with the words before them as the lead-in', () => {
  assert.deepEqual(formTextBlocks(KIRRA), [
    { type: 'text', text: 'Circumstances requiring a new copy of this agreement to be signed' },
    { type: 'list', loose: false, items: [
      'Changing from Personal Trainer to Group Trainer',
      'Changing from Group Trainer to Personal Trainer',
      'Adding the responsibility to train Group Classes whilst still Personal Training',
      'Adding the responsibility to do Personal Training, whilst conducting Group Classes',
      'Choosing to no longer conduct Group Classes and / or Personal Training at the same time, and to just provide one of these services;',
    ] },
  ]);
});

test('a line that starts with a dot point is one, however it was typed', () => {
  for (const marker of ['•', '• ', '- ', '* ', '– ', '  • ']) {
    assert.deepEqual(formTextBlocks(`Bring:\n${marker}CPR\n${marker}First aid`), [
      { type: 'text', text: 'Bring:' },
      { type: 'list', loose: false, items: ['CPR', 'First aid'] },
    ], JSON.stringify(marker));
  }
});

test('a hyphen or asterisk that is not a dot point stays as written', () => {
  assert.deepEqual(formTextBlocks('-5 kg on the bar\n*Conditions apply'), [{ type: 'text', text: '-5 kg on the bar\n*Conditions apply' }]);
  assert.deepEqual(formTextBlocks('Mon - Fri'), [{ type: 'text', text: 'Mon - Fri' }]);
});

test('text with no dot points renders exactly as it did before', () => {
  const text = 'First paragraph.\nSame paragraph, next line.\n\nSecond paragraph.';
  assert.deepEqual(formTextBlocks(text), [{ type: 'text', text }]);
  assert.deepEqual(formTextBlocks(''), []);
  assert.deepEqual(formTextBlocks(null), []);
  assert.deepEqual(formTextBlocks('\n  \n'), []);
});

test('points separated by blank lines stay one list, spaced out', () => {
  assert.deepEqual(formTextBlocks('• One\n\n• Two\n\n• Three\n\nAfter.'), [
    { type: 'list', loose: true, items: ['One', 'Two', 'Three'] },
    { type: 'text', text: 'After.' },
  ]);
});

test('a dot point with nothing written after it is left out, and Windows line endings are lines', () => {
  assert.deepEqual(formTextBlocks('Intro\r\n• A\r\n• \r\n• B'), [
    { type: 'text', text: 'Intro' },
    { type: 'list', loose: true, items: ['A', 'B'] },
  ]);
  assert.deepEqual(dotPointParts('abc •'), { marked: false, lead: 'abc •', points: [] });
});

test('the signed agreements lose no words when their points become lists', () => {
  const words = text => text.replace(/•/g, ' ').replace(/(^|\n)\s*[-*–]\s/g, '$1 ').replace(/\s+/g, ' ').trim();
  const rendered = blocks => blocks.map(block => block.type === 'list' ? block.items.join(' ') : block.text).join(' ');
  for (const definition of [XERT_TERMS_FORM_DEFINITION, XERT_CONTRACTOR_FORM_DEFINITION, XERT_PEQ_FORM_DEFINITION]) {
    for (const field of definition.questions) {
      for (const text of [field.content, field.description].filter(Boolean)) {
        assert.equal(words(rendered(formTextBlocks(text))), words(text), `${definition.title}: ${text.slice(0, 60)}`);
      }
    }
  }
});

// ─── The builder's Dot points button, and Enter ────────────────────────────

test('the button turns the line the cursor is on into a dot point, and back', () => {
  const text = 'Bring:\nCPR\nFirst aid';
  const on = toggleDotPoints(text, 8);
  assert.equal(on.text, 'Bring:\n• CPR\nFirst aid');
  assert.equal(on.selectionStart, on.selectionEnd);
  assert.equal(on.text.slice(0, on.selectionStart), 'Bring:\n• CPR', 'the cursor lands at the end of the point');
  assert.equal(toggleDotPoints(on.text, 9).text, text);
});

test('the button does every line in a selection, and an empty box gets a point to type into', () => {
  const text = 'Bring:\nCPR\n\nFirst aid';
  const on = toggleDotPoints(text, 7, text.length);
  assert.equal(on.text, 'Bring:\n• CPR\n\n• First aid');
  assert.deepEqual([on.selectionStart, on.selectionEnd], [7, on.text.length], 'the lines stay selected');
  assert.equal(toggleDotPoints(on.text, 7, on.text.length).text, text);
  assert.deepEqual(toggleDotPoints('', 0), { text: '• ', selectionStart: 2, selectionEnd: 2 });
  assert.equal(toggleDotPoints('Bring:\n', 7).text, 'Bring:\n• ');
});

test('points typed along one line go onto a line each when the button is pressed on it', () => {
  const { text } = toggleDotPoints(KIRRA, 10);
  assert.equal(text.split('\n')[0], 'Circumstances requiring a new copy of this agreement to be signed');
  assert.equal(text.split('\n')[1], '• Changing from Personal Trainer to Group Trainer');
  assert.equal(text.split('\n').length, 6);
  assert.deepEqual(formTextBlocks(text), formTextBlocks(KIRRA), 'the form reads the same either way');
});

test('Enter in a dot point starts the next one, and Enter on an empty one ends the list', () => {
  const first = '• CPR';
  const next = continueDotPoints(first, first.length);
  assert.deepEqual(next, { text: '• CPR\n• ', selectionStart: 8, selectionEnd: 8 });
  assert.deepEqual(continueDotPoints(next.text, next.text.length), { text: '• CPR\n', selectionStart: 6, selectionEnd: 6 });
  // Enter part way along a point splits it into two.
  assert.equal(continueDotPoints('• CPR and first aid', 5).text, '• CPR\n• and first aid');
  assert.equal(continueDotPoints('Plain line', 10), null, 'an ordinary line gets an ordinary new line');
  assert.equal(continueDotPoints('• CPR', 0), null, 'before the dot itself, Enter just moves the point down');
});
