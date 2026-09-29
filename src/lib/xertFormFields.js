import { skipRuleProblems } from './formBranching.js';
import { signOffProblem } from './formSignatories.js';
// ─── Shared building blocks for repo-owned form definitions ──────────────────
// The PEQ and the terms agreement are legal documents, so their field IDs must
// stay stable across deploys: a response snapshot references them forever.
// Definitions therefore live in the repo and are applied to the database by a
// script, rather than being hand-built in the Command Centre.

export const DEFAULT_FIELD = Object.freeze({
  description: '',
  required: false,
  hidden: false,
  placeholder: '',
  options: ['Option 1', 'Option 2', 'Option 3'],
  allow_other: false,
  scale_min: 1,
  scale_max: 10,
  scale_min_label: '',
  scale_max_label: '',
  media_type: null,
  media_url: '',
  media_caption: '',
  correct_answer: null,
  points: 0,
  content: '',
  skip_rules: [],
});

export function field(id, type, question, overrides = {}) {
  return { ...DEFAULT_FIELD, id, type, question, ...overrides };
}

export function section(id, title, description = '') {
  return field(id, 'section_break', '', { content: title, description });
}

export function statement(id, content, description = '') {
  return field(id, 'statement', '', { content, description });
}

export function required(id, type, question, overrides = {}) {
  return field(id, type, question, { required: true, ...overrides });
}

export function acknowledgement(id, question, description) {
  return required(id, 'single_choice', question, {
    description,
    options: ['I confirm and agree'],
  });
}

/** Shares validateFormDraft's rules for definitions the Command Centre never edits. */
export function validateXertFormDefinition(definition) {
  const questions = definition?.questions || [];
  const ids = questions.map(question => question.id);
  if (new Set(ids).size !== ids.length) return 'Question IDs must be unique.';
  if (ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 128)) {
    return 'Every question needs a stable ID of 1 to 128 characters.';
  }
  if (questions.length > 100) return 'The form exceeds the 100-field platform limit.';
  // Same rules as the builder, and the same named reason: these definitions are
  // checked in a test, and "a skip destination is invalid" across a 40-field
  // waiver was the least useful thing that check could have said.
  const [problem] = skipRuleProblems(questions);
  if (problem) return `${problem.message} ${problem.fix}`;
  return questions.map(signOffProblem).find(Boolean) || null;
}
