// ─── A signed form, as the PDF people keep ──────────────────────────────────
// What somebody signs is the form as it stood when they signed it: every
// heading, every clause, every answer and every signature. This lays that out
// on A4 from the response's own snapshot, so the PDF says exactly what they
// agreed to even after the wording is edited for the next person.
//
// It deliberately reads the response the way the admin's printed record does
// (formDefinitionForResponse + fieldsForResponseRecord): skipped and hidden
// fields stay out, text keeps its dot points, and a signature signed in
// advance for XERT Fitness is the one the database wrote into the response.
//
// Plain JavaScript with no browser APIs, so the server can run it.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fieldsForResponseRecord, formDefinitionForResponse, formatResponseAnswer, responseAnswerIsPresent } from './formResponseRecord.js';
import { formTextBlocks } from './formText.js';
import { formSignatory } from './formSignatories.js';

const PAGE = Object.freeze({ width: 595.28, height: 841.89 });
const MARGIN = Object.freeze({ top: 56, bottom: 60, left: 50, right: 50 });
const WIDTH = PAGE.width - MARGIN.left - MARGIN.right;
const SIZE = Object.freeze({ title: 17, heading: 12, body: 9.5, label: 8.5, foot: 7.5 });
const LEADING = Object.freeze({ body: 12.6, heading: 16 });
const INK = Object.freeze({
  text: rgb(0.063, 0.094, 0.125),
  muted: rgb(0.353, 0.42, 0.478),
  rule: rgb(0.72, 0.76, 0.8),
  box: rgb(0.973, 0.98, 0.988),
});

const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'dropdown', 'yes_no']);
const BRISBANE = 'Australia/Brisbane';

// Helvetica draws WinAnsi. Owners paste text from Word and phones, so anything
// outside it is swapped for the nearest thing that is, never thrown on.
const SUBSTITUTES = [
  [/[‘’‚‛′]/g, "'"], [/[“”„‟″]/g, '"'],
  [/[‐‑‒−]/g, '-'], [/…/g, '...'], [/[     ]/g, ' '],
  [/[​-‍﻿]/g, ''], [/[☐□⬜]/g, '[ ]'], [/[☑☒✓✔]/g, '[x]'],
];

export function pdfText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SUBSTITUTES) text = text.replace(pattern, replacement);
  return text.replace(/[^ -~¡-ÿ–—•€]/g, '');
}

/** Greedy wrap, measured in the font that draws it. Long words are split. */
export function wrapLine(text, font, size, maxWidth) {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while (font.widthOfTextAtSize(word, size) > maxWidth) {
      // An email address or a pasted link with no spaces still has to fit.
      let cut = word.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut -= 1;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export function signedAt(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: BRISBANE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function signedOn(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: BRISBANE, day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

const SIGNATURE_URI = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i;

/** The bytes and format of a signature answer, or null when it is not one. */
export function signatureImage(value) {
  const match = typeof value === 'string' ? SIGNATURE_URI.exec(value.trim()) : null;
  if (!match) return null;
  return { format: match[1].toLowerCase() === 'png' ? 'png' : 'jpg', bytes: base64Bytes(match[2].replace(/\s+/g, '')) };
}

function base64Bytes(base64) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(base64, 'base64'));
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Lays content down the page and starts the next one when it runs out. */
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
  }

  room(height) {
    return this.y - height >= MARGIN.bottom;
  }

  /** Move down by `height`, on a fresh page if it will not fit on this one. */
  claim(height) {
    if (!this.room(height)) this.newPage();
    this.y -= height;
    return this.y;
  }

  gap(height) {
    if (this.room(height)) this.y -= height;
  }

  lines(text, { size = SIZE.body, font = this.fonts.regular, colour = INK.text, leading = LEADING.body, indent = 0, bullet = null } = {}) {
    let marker = bullet;
    for (const line of wrapLine(text, font, size, WIDTH - indent)) {
      const y = this.claim(leading);
      this.page.drawText(line, { x: MARGIN.left + indent, y, size, font, color: colour });
      if (marker) {
        // Beside the first line that lands, on whichever page that is.
        this.page.drawText(marker, { x: MARGIN.left + indent - 11, y, size, font: this.fonts.regular, color: INK.muted });
        marker = null;
      }
    }
  }

  /** Owner-written text: paragraphs keep their breaks, dot points are a list. */
  formText(value, options = {}) {
    for (const block of formTextBlocks(value)) {
      if (block.type === 'list') {
        for (const item of block.items) {
          this.lines(item, { ...options, indent: (options.indent || 0) + 14, bullet: '•' });
          if (block.loose) this.gap(4);
        }
      } else {
        for (const paragraph of String(block.text).split('\n')) {
          if (paragraph.trim()) this.lines(paragraph, options);
          else this.gap(LEADING.body * 0.6);
        }
      }
      this.gap(4);
    }
  }

  rule(colour = INK.rule, thickness = 0.6) {
    const y = this.claim(8) + 4;
    this.page.drawLine({ start: { x: MARGIN.left, y }, end: { x: PAGE.width - MARGIN.right, y }, thickness, color: colour });
  }
}

function drawTick(page, x, y) {
  page.drawLine({ start: { x: x + 2, y: y + 5.5 }, end: { x: x + 4.4, y: y + 2.4 }, thickness: 1.4, color: INK.text });
  page.drawLine({ start: { x: x + 4.4, y: y + 2.4 }, end: { x: x + 9, y: y + 8.6 }, thickness: 1.4, color: INK.text });
}

function drawOptions(sheet, field) {
  const options = field.type === 'yes_no' ? ['Yes', 'No'] : (Array.isArray(field.options) ? field.options : []);
  const chosen = new Set((Array.isArray(field.answer) ? field.answer : [field.answer]).filter(responseAnswerIsPresent).map(String));
  const listed = options.map(String);
  // An "Other" answer is whatever was typed that is not one of the options.
  const other = [...chosen].filter(answer => !listed.includes(answer));
  for (const option of [...listed, ...other.map(answer => `Other: ${answer}`)]) {
    const lines = wrapLine(option, sheet.fonts.regular, SIZE.body, WIDTH - 22);
    const height = Math.max(14, lines.length * LEADING.body) + 3;
    if (!sheet.room(height)) sheet.newPage();
    const top = sheet.y;
    const boxY = top - 11;
    const ticked = chosen.has(option) || (option.startsWith('Other: ') && chosen.has(option.slice(7)));
    sheet.page.drawRectangle({ x: MARGIN.left, y: boxY, width: 11, height: 11, borderColor: INK.rule, borderWidth: 0.7 });
    if (ticked) drawTick(sheet.page, MARGIN.left, boxY);
    lines.forEach((line, row) => sheet.page.drawText(line, {
      x: MARGIN.left + 20, y: top - 9 - row * LEADING.body, size: SIZE.body,
      font: ticked ? sheet.fonts.bold : sheet.fonts.regular, color: INK.text,
    }));
    sheet.y = top - height;
  }
}

async function drawSignature(sheet, field, { completedAt }) {
  const signatory = formSignatory(field);
  const image = signatureImage(field.answer);
  const boxHeight = 52;
  const width = 250;
  const needed = boxHeight + LEADING.body * 3;
  if (!sheet.room(needed)) sheet.newPage();
  const boxY = sheet.claim(boxHeight);
  if (image) {
    const embedded = image.format === 'png' ? await sheet.doc.embedPng(image.bytes) : await sheet.doc.embedJpg(image.bytes);
    // Fitted inside the line without stretching: a signature keeps its shape.
    const scale = Math.min(width / embedded.width, (boxHeight - 4) / embedded.height, 1.5);
    sheet.page.drawImage(embedded, { x: MARGIN.left + 2, y: boxY + 3, width: embedded.width * scale, height: embedded.height * scale });
  }
  sheet.page.drawLine({ start: { x: MARGIN.left, y: boxY }, end: { x: MARGIN.left + width, y: boxY }, thickness: 0.8, color: INK.text });
  const caption = signatory
    ? `${signatory.name}, ${signatory.role}`
    : image ? `Signed ${signedOn(completedAt)}` : 'Not signed';
  sheet.lines(caption, { size: SIZE.label, colour: INK.muted });
}

// A name and an address are stored as parts. Printed part by part they come
// out in storage order ("Last: …, First: …"), so they are put back together
// the way they are written on paper. Anything unexpected falls through to the
// generic labelled form rather than being dropped.
const NAME_PARTS = ['first', 'last'];
const ADDRESS_PARTS = ['street', 'suburb', 'state', 'postcode', 'country'];

export function compoundAnswer(field) {
  const value = field?.answer;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const known = field.type === 'name_fields' ? NAME_PARTS : field.type === 'address' ? ADDRESS_PARTS : null;
  if (!known || Object.keys(value).some(key => !known.includes(key))) return null;
  const part = key => String(value[key] ?? '').trim();
  if (field.type === 'name_fields') return [part('first'), part('last')].filter(Boolean).join(' ');
  const locality = [part('suburb'), part('state'), part('postcode')].filter(Boolean).join(' ');
  return [part('street'), locality, part('country')].filter(Boolean).join('\n');
}

async function drawField(sheet, field, context) {
  if (field.type === 'section_break') {
    if (!sheet.room(LEADING.heading + LEADING.body * 3)) sheet.newPage();
    sheet.gap(10);
    if (field.content) sheet.lines(field.content, { size: SIZE.heading, font: sheet.fonts.bold, leading: LEADING.heading });
    if (field.description) sheet.formText(field.description, { colour: INK.muted });
    sheet.gap(2);
    return;
  }
  if (field.type === 'statement') {
    sheet.formText(field.content);
    if (field.description) sheet.formText(field.description, { colour: INK.muted, size: SIZE.label });
    return;
  }

  // Keep a question's label with at least the start of its answer.
  if (!sheet.room(LEADING.body * 4)) sheet.newPage();
  sheet.gap(6);
  sheet.lines(`${field.question || 'Question'}${field.required ? ' *' : ''}`, { font: sheet.fonts.bold });
  if (field.description) sheet.formText(field.description, { colour: INK.muted, size: SIZE.label, leading: 11 });

  if (field.type === 'signature') { await drawSignature(sheet, field, context); return; }
  if (CHOICE_TYPES.has(field.type)) { drawOptions(sheet, field); return; }
  if (field.type === 'file_upload') {
    sheet.lines(field.answer?.name ? `File: ${field.answer.name}` : 'No file', { colour: field.answer?.name ? INK.text : INK.muted });
    return;
  }
  const answer = compoundAnswer(field) ?? formatResponseAnswer(field.answer);
  if (!answer) { sheet.lines('Not answered', { colour: INK.muted }); return; }
  for (const line of answer.split('\n')) sheet.lines(line, { indent: 2 });
}

/**
 * Render one submitted response as its signed PDF.
 *
 * @param {object} response a row of xert_form_responses: answers, form_snapshot,
 *   respondent_name/email/phone, completed_at or created_at, and id.
 * @param {object} [form] the current form, only used for a legacy response
 *   with no snapshot of its own.
 * @returns {Promise<Uint8Array>}
 */
export async function renderSignedDocumentPdf(response, form = null) {
  const definition = formDefinitionForResponse(form, response);
  const { fields } = fieldsForResponseRecord(definition, response);
  const completedAt = response?.completed_at || response?.created_at;
  const name = String(response?.respondent_name || '').trim();

  const doc = await PDFDocument.create();
  doc.setTitle(pdfText(`${definition.title}${name ? ` - ${name}` : ''}`));
  doc.setSubject('Signed copy');
  doc.setAuthor('XERT Fitness');
  doc.setCreator('XERT Fitness');
  doc.setProducer('XERT Fitness');
  doc.setCreationDate(new Date(completedAt || Date.now()));

  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const sheet = new Sheet(doc, fonts);

  sheet.lines(definition.title, { size: SIZE.title, font: fonts.bold, leading: 22 });
  sheet.lines('Signed copy', { colour: INK.muted, size: SIZE.label });
  sheet.rule();
  // Who signed and when, the way the paper agreement opens with its parties.
  for (const [label, value] of [
    ['Name', name], ['Email', response?.respondent_email], ['Phone', response?.respondent_phone],
    ['Signed', signedAt(completedAt)],
  ]) {
    if (!String(value || '').trim()) continue;
    sheet.lines(`${label}:  ${value}`, { size: SIZE.label, colour: INK.muted, leading: 11.5 });
  }
  sheet.rule();
  if (definition.description) sheet.formText(definition.description);

  for (const field of fields) await drawField(sheet, field, { completedAt });

  const reference = String(response?.id || '').slice(0, 8);
  const footer = pdfText(`${definition.title}${name ? ` - signed by ${name}` : ''}${reference ? ` - ref ${reference}` : ''}`);
  sheet.pages.forEach((page, index) => {
    const pageLabel = `Page ${index + 1} of ${sheet.pages.length}`;
    const room = WIDTH - fonts.regular.widthOfTextAtSize(pageLabel, SIZE.foot) - 12;
    const text = wrapLine(footer, fonts.regular, SIZE.foot, room)[0] || '';
    page.drawText(text, { x: MARGIN.left, y: MARGIN.bottom - 28, size: SIZE.foot, font: fonts.regular, color: INK.muted });
    page.drawText(pageLabel, {
      x: PAGE.width - MARGIN.right - fonts.regular.widthOfTextAtSize(pageLabel, SIZE.foot),
      y: MARGIN.bottom - 28, size: SIZE.foot, font: fonts.regular, color: INK.muted,
    });
  });
  return doc.save();
}

/** A file name a mail client will keep: the form, the person, the date. */
export function signedDocumentFileName(response) {
  const title = response?.form_snapshot?.title || 'Signed form';
  const name = response?.respondent_name || '';
  const date = new Date(response?.completed_at || response?.created_at || Date.now());
  const day = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: BRISBANE }).format(date);
  const slug = [title, name, day].filter(Boolean).join(' ').replace(/[^A-Za-z0-9 -]+/g, '').trim().replace(/\s+/g, '-');
  return `${slug.slice(0, 120) || 'signed-form'}.pdf`;
}
