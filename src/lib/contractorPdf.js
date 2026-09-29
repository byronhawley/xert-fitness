// ─── The contractor agreement as a PDF ──────────────────────────────────────
// One layout, two outputs:
//
//   interactive — the blank agreement with real AcroForm fields, so it can be
//                 filled in a PDF reader instead of the step-by-step web form.
//   signed      — the same agreement with a response's answers drawn in and
//                 the signature images placed on their lines, which is what
//                 gets attached to the copy email.
//
// They share every measurement deliberately. A signed PDF that did not line up
// with the blank one would not be the same document, and this is the document.
//
// Field names are the form's question ids, so filling from a response is a
// lookup rather than a mapping that can drift.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  XERT_CONTRACTOR_BUSINESS_TYPES, XERT_CONTRACTOR_PARTIES, XERT_CONTRACTOR_QUALIFICATIONS,
  XERT_CONTRACTOR_SECTIONS,
  XERT_CONTRACTOR_SERVICES, XERT_CONTRACTOR_SUBTITLE, XERT_CONTRACTOR_TITLE,
} from './xertContractorAgreement.js';

// A4, in points, and the frame the paper agreement uses.
const PAGE = Object.freeze({ width: 595.28, height: 841.89 });
const MARGIN = Object.freeze({ top: 56, bottom: 56, left: 48, right: 48 });
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const SIZE = Object.freeze({ title: 16, subtitle: 10.5, heading: 11, body: 9, label: 8.5, foot: 7.5 });
const LEADING = Object.freeze({ body: 12.2, heading: 15 });

const INK = Object.freeze({
  text: rgb(0.063, 0.094, 0.125),
  muted: rgb(0.353, 0.42, 0.478),
  rule: rgb(0.667, 0.71, 0.753),
  field: rgb(0.973, 0.98, 0.988),
});

// The blanks on the paper, in the order they appear, named by question id.
const DETAIL_FIELDS = Object.freeze([
  { id: 'ic-01-name', label: 'Full name' },
  { id: 'ic-02-address', label: 'Address' },
  { id: 'ic-03-abn', label: 'A.B.N.' },
  { id: 'ic-04-business-name', label: 'Business name (if any)' },
  { id: 'ic-05-phone', label: 'Phone' },
  { id: 'ic-06-email', label: 'Email' },
]);

const SIGN_OFF_FIELDS = Object.freeze([
  { id: 'ic-92-contractor-name', label: 'Independent contractor name' },
  { id: 'ic-94-commencement', label: 'Date signed' },
]);

const SIGNATURE_SLOTS = Object.freeze([
  { id: 'ic-93-contractor-signature', label: 'Independent contractor signature' },
  { id: 'ic-98-owner-signature', label: 'Signed for XERT Fitness: Byron Hawley, Owner' },
]);

// Helvetica is drawn with WinAnsi, which covers the agreement's curly quotes,
// dashes and bullets. Anything outside it is replaced rather than thrown on,
// so a clause can never stop the document being produced.
const WINANSI_SUBSTITUTES = Object.freeze([
  [/[‘’‛]/g, "'"], [/[“”‟]/g, '"'],
  [/[‐‑]/g, '-'], [/…/g, '...'], [/[   ]/g, ' '],
  [/−/g, '-'], [/•/g, '•'],
]);

export function pdfSafe(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of WINANSI_SUBSTITUTES) text = text.replace(pattern, replacement);
  // Anything still outside WinAnsi's printable range would throw when drawn.
  return text.replace(/[^ -~¡-ÿ–—•€]/g, '?');
}

/** Greedy wrap, measured in the font that will actually draw it. */
export function wrapText(text, font, size, maxWidth) {
  const lines = [];
  // Split before sanitising: a newline is not in WinAnsi, so sanitising first
  // would turn every paragraph break into a stray "?".
  for (const raw of String(text ?? '').split('\n')) {
    const paragraph = pdfSafe(raw);
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** A cursor that lays content down the page and starts a new one when full. */
class Sheet {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN.top;
    return this.page;
  }

  /** Reserve vertical space, moving to a new page if it will not fit. */
  claim(height) {
    if (this.y - height < MARGIN.bottom) this.newPage();
    this.y -= height;
    return this.y;
  }

  gap(height) {
    if (this.y - height > MARGIN.bottom) this.y -= height;
  }

  text(content, { size = SIZE.body, font = this.fonts.regular, colour = INK.text,
    leading = LEADING.body, indent = 0, width = CONTENT_WIDTH, bullet = null } = {}) {
    let pending = bullet;
    for (const line of wrapText(content, font, size, width - indent)) {
      const y = this.claim(leading);
      if (!line) continue;
      this.page.drawText(line, { x: MARGIN.left + indent, y, size, font, color: colour });
      // The bullet belongs beside the first line that actually lands, on
      // whichever page that turns out to be. Drawing it afterwards put it on
      // the wrong page whenever a clause broke across one.
      if (pending) {
        this.page.drawText(pending, {
          x: MARGIN.left + 3, y, size, font: this.fonts.regular, color: INK.muted,
        });
        pending = null;
      }
    }
  }

  rule(colour = INK.rule) {
    const y = this.claim(8) + 4;
    this.page.drawLine({
      start: { x: MARGIN.left, y }, end: { x: PAGE.width - MARGIN.right, y },
      thickness: 0.6, color: colour,
    });
  }
}

function drawHeader(sheet) {
  sheet.text(XERT_CONTRACTOR_TITLE, { size: SIZE.title, font: sheet.fonts.bold, leading: 20 });
  sheet.text(XERT_CONTRACTOR_SUBTITLE, { size: SIZE.subtitle, colour: INK.muted, leading: 14 });
  sheet.rule();
  sheet.gap(6);
  sheet.text(XERT_CONTRACTOR_PARTIES);
  sheet.gap(10);
}

function drawClauses(sheet) {
  for (const section of XERT_CONTRACTOR_SECTIONS) {
    // Keep a heading with at least its first line rather than stranding it.
    if (sheet.y - (LEADING.heading + LEADING.body * 2) < MARGIN.bottom) sheet.newPage();
    sheet.gap(8);
    sheet.text(section.title, { size: SIZE.heading, font: sheet.fonts.bold, leading: LEADING.heading });
    sheet.gap(2);
    for (const point of section.points) {
      sheet.text(point, { indent: 14, bullet: '•' });
      sheet.gap(4);
    }
  }
}

/** A labelled blank: an AcroForm field when interactive, a ruled line when not. */
function drawBlank(sheet, { name, label, value, form, height = 20, width = CONTENT_WIDTH }) {
  sheet.gap(6);
  const labelY = sheet.claim(LEADING.body);
  sheet.page.drawText(pdfSafe(label), {
    x: MARGIN.left, y: labelY, size: SIZE.label, font: sheet.fonts.regular, color: INK.muted,
  });
  // Clear of the label's descenders, or the box lid cuts through the "y" in
  // "Business name" and the label reads as half a word.
  sheet.gap(4);
  const boxY = sheet.claim(height);
  if (form) {
    const field = form.createTextField(name);
    field.setText('');
    field.addToPage(sheet.page, {
      x: MARGIN.left, y: boxY, width, height,
      backgroundColor: INK.field, borderColor: INK.rule, borderWidth: 0.6,
      textColor: INK.text, font: sheet.fonts.regular,
    });
  } else {
    sheet.page.drawLine({
      start: { x: MARGIN.left, y: boxY }, end: { x: MARGIN.left + width, y: boxY },
      thickness: 0.6, color: INK.rule,
    });
    if (value) {
      sheet.page.drawText(pdfSafe(value), {
        x: MARGIN.left + 2, y: boxY + 5, size: SIZE.body, font: sheet.fonts.regular, color: INK.text,
      });
    }
  }
}

function drawTickList(sheet, { title, note, options, name, selected, form, radio = false }) {
  // Measure the whole group first. Splitting a three-option choice across a
  // page break leaves an orphan option under a heading it has lost, so if the
  // group fits on a fresh page it starts on one.
  const optionHeight = options.reduce((total, option) => total
    + Math.max(14, wrapText(option, sheet.fonts.regular, SIZE.body, CONTENT_WIDTH - 22).length
      * LEADING.body) + 3, 0);
  const groupHeight = 8 + LEADING.heading + (note ? LEADING.body : 0) + 4 + optionHeight;
  const fitsOnAFreshPage = groupHeight <= PAGE.height - MARGIN.top - MARGIN.bottom;
  if (fitsOnAFreshPage && sheet.y - groupHeight < MARGIN.bottom) sheet.newPage();

  sheet.gap(8);
  sheet.text(title, { size: SIZE.heading, font: sheet.fonts.bold, leading: LEADING.heading });
  if (note) sheet.text(note, { size: SIZE.label, colour: INK.muted });
  sheet.gap(4);

  const group = form && radio ? form.createRadioGroup(name) : null;
  const chosen = new Set((Array.isArray(selected) ? selected : [selected]).filter(Boolean).map(pdfSafe));

  for (const [index, option] of options.entries()) {
    const lines = wrapText(option, sheet.fonts.regular, SIZE.body, CONTENT_WIDTH - 22);
    const blockHeight = Math.max(14, lines.length * LEADING.body);
    if (sheet.y - blockHeight < MARGIN.bottom) sheet.newPage();
    const top = sheet.y;
    const boxY = top - 11;

    if (group) {
      group.addOptionToPage(pdfSafe(option), sheet.page, {
        x: MARGIN.left, y: boxY, width: 11, height: 11,
        backgroundColor: INK.field, borderColor: INK.rule, borderWidth: 0.6,
      });
    } else if (form) {
      const box = form.createCheckBox(`${name}.${index}`);
      box.addToPage(sheet.page, {
        x: MARGIN.left, y: boxY, width: 11, height: 11,
        backgroundColor: INK.field, borderColor: INK.rule, borderWidth: 0.6,
      });
    } else {
      sheet.page.drawRectangle({
        x: MARGIN.left, y: boxY, width: 11, height: 11,
        borderColor: INK.rule, borderWidth: 0.6,
      });
      if (chosen.has(pdfSafe(option))) {
        // A drawn tick, so a printed copy reads the same as the screen.
        sheet.page.drawLine({
          start: { x: MARGIN.left + 2, y: boxY + 5.5 }, end: { x: MARGIN.left + 4.4, y: boxY + 2.4 },
          thickness: 1.4, color: INK.text,
        });
        sheet.page.drawLine({
          start: { x: MARGIN.left + 4.4, y: boxY + 2.4 }, end: { x: MARGIN.left + 9, y: boxY + 8.6 },
          thickness: 1.4, color: INK.text,
        });
      }
    }

    for (const [row, line] of lines.entries()) {
      sheet.page.drawText(line, {
        x: MARGIN.left + 20, y: top - 9 - row * LEADING.body,
        size: SIZE.body, font: sheet.fonts.regular, color: INK.text,
      });
    }
    sheet.y = top - blockHeight - 3;
  }
}

async function drawSignatures(sheet, { form, signatures, presigned, doc }) {
  const boxHeight = 46;
  for (const slot of SIGNATURE_SLOTS) {
    const needed = boxHeight + LEADING.body * 2 + 10;
    if (sheet.y - needed < MARGIN.bottom) sheet.newPage();
    sheet.gap(10);
    const labelY = sheet.claim(LEADING.body);
    sheet.page.drawText(pdfSafe(slot.label), {
      x: MARGIN.left, y: labelY, size: SIZE.label, font: sheet.fonts.regular, color: INK.muted,
    });
    // Same clearance the detail blanks get, so "signature" keeps its tail.
    sheet.gap(4);
    const boxY = sheet.claim(boxHeight);
    const width = 260;

    // A signature given in advance fills its line on every copy, blank or
    // signed; one recorded on the response takes its place when there is one.
    const drawn = signatures?.[slot.id] || presigned?.[slot.id];
    if (drawn) {
      const png = await doc.embedPng(drawn);
      // Fit inside the box without distorting: the signature keeps its shape.
      const scale = Math.min(width / png.width, (boxHeight - 4) / png.height);
      sheet.page.drawImage(png, {
        x: MARGIN.left + 2, y: boxY + 3,
        width: png.width * scale, height: png.height * scale,
      });
    } else if (form) {
      // Readers stamp a signature into a blank area; a bordered box tells them
      // where, and the printed-name field below records who.
      sheet.page.drawRectangle({
        x: MARGIN.left, y: boxY + 2, width, height: boxHeight - 2,
        borderColor: INK.rule, borderWidth: 0.6, color: INK.field,
      });
      sheet.page.drawText('Sign here', {
        x: MARGIN.left + 6, y: boxY + boxHeight - 12,
        size: SIZE.foot, font: sheet.fonts.regular, color: INK.muted,
      });
    }

    sheet.page.drawLine({
      start: { x: MARGIN.left, y: boxY }, end: { x: MARGIN.left + width, y: boxY },
      thickness: 0.8, color: INK.text,
    });
  }
}

function drawFooter(sheet, { mode }) {
  const total = sheet.pages.length;
  const note = mode === 'signed'
    ? 'Signed copy generated by XERT Fitness. ABN 65 327 079 634.'
    : 'XERT Fitness, Shop 14/15 27-31 Pound St, Kingaroy QLD 4610. ABN 65 327 079 634.';
  sheet.pages.forEach((page, index) => {
    page.drawText(pdfSafe(`${note}   Page ${index + 1} of ${total}`), {
      x: MARGIN.left, y: MARGIN.bottom - 24,
      size: SIZE.foot, font: sheet.fonts.regular, color: INK.muted,
    });
  });
}

/**
 * Render the agreement.
 *
 * @param {object} options
 * @param {'interactive'|'signed'} options.mode
 * @param {Record<string, string>} [options.values]     answers, keyed by question id
 * @param {string[]} [options.qualifications]           ticked qualification options
 * @param {string} [options.service]                    chosen service
 * @param {string} [options.businessType]               Pty Ltd, Ltd, or nothing
 * @param {string} [options.accepted]                   the acceptance answer
 * @param {string} [options.marketing]                  the marketing consent answer
 * @param {Record<string, Uint8Array>} [options.signatures] PNG bytes per signature id
 * @param {Record<string, Uint8Array>} [options.presigned]  PNG bytes for lines signed in advance
 * @returns {Promise<Uint8Array>}
 */
export async function renderContractorPdf({
  mode = 'interactive', values = {}, qualifications = [], service = null, businessType = null,
  accepted = null, marketing = null, signatures = null, presigned = null,
} = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(mode === 'signed'
    ? `${XERT_CONTRACTOR_TITLE} (signed)` : XERT_CONTRACTOR_TITLE);
  doc.setAuthor('XERT Fitness');
  doc.setSubject(XERT_CONTRACTOR_SUBTITLE);
  doc.setProducer('XERT Fitness');
  doc.setCreator('XERT Fitness');

  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const interactive = mode === 'interactive';
  const form = interactive ? doc.getForm() : null;
  const sheet = new Sheet(doc, fonts);

  drawHeader(sheet);

  sheet.text('Your details', { size: SIZE.heading, font: fonts.bold, leading: LEADING.heading });
  for (const detail of DETAIL_FIELDS) {
    drawBlank(sheet, { ...detail, name: detail.id, value: values[detail.id], form });
    // The company type belongs with the business name it describes, not in a
    // section of its own further down the page.
    if (detail.id === 'ic-04-business-name') {
      drawTickList(sheet, {
        title: 'Is the business a company?',
        note: 'Only if you trade under a registered company. Leave blank if you are a sole trader.',
        options: [...XERT_CONTRACTOR_BUSINESS_TYPES],
        name: 'ic-04b-business-type', selected: businessType, form, radio: true,
      });
    }
  }

  drawTickList(sheet, {
    title: 'Qualifications and certificates',
    note: 'Tick everything you hold and keep current.',
    options: [...XERT_CONTRACTOR_QUALIFICATIONS],
    name: 'ic-08-qualifications', selected: qualifications, form,
  });

  drawTickList(sheet, {
    title: 'Service you intend to provide',
    note: 'Choose one. Changing this later requires a new copy of this agreement.',
    options: [...XERT_CONTRACTOR_SERVICES],
    name: 'ic-09-service', selected: service, form, radio: true,
  });

  drawClauses(sheet);

  sheet.gap(10);
  sheet.rule(INK.text);
  drawTickList(sheet, {
    title: 'Do you accept this Independent Contractor Agreement?',
    note: 'Accepting records your agreement from the date signed below.',
    options: ['I accept this agreement', 'I decline'],
    name: 'ic-91-accept', selected: accepted, form, radio: true,
  });
  drawTickList(sheet, {
    title: 'Do you consent to being featured in XERT Fitness marketing material?',
    options: ['Yes, I consent', 'No, I do not consent'],
    name: 'ic-95-marketing', selected: marketing, form, radio: true,
  });

  for (const detail of SIGN_OFF_FIELDS) {
    drawBlank(sheet, { ...detail, name: detail.id, value: values[detail.id], form, width: 300 });
  }
  await drawSignatures(sheet, { form, signatures, presigned, doc });

  if (form) {
    // Readers should render the fields from their own appearance streams, so a
    // value typed in one reader is visible in the next.
    form.updateFieldAppearances(fonts.regular);
  } else {
    // A signed copy is a record. Flattening leaves nothing editable in it.
    doc.getForm().flatten({ updateFieldAppearances: false });
  }

  drawFooter(sheet, { mode });
  return doc.save();
}

export const CONTRACTOR_PDF_FIELDS = Object.freeze({
  details: DETAIL_FIELDS, signOff: SIGN_OFF_FIELDS, signatures: SIGNATURE_SLOTS,
});
