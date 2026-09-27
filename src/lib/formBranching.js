const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice', 'dropdown', 'yes_no']);
const LAYOUT_TYPES = new Set(['section_break', 'statement']);

/** Returns field IDs omitted by the form's forward-only branch rules. */
export function computeSkippedQuestionIDs(questions, answers) {
  const skipped = new Set();
  questions.forEach((question, index) => {
    if (skipped.has(question.id)) return;
    if (!CHOICE_TYPES.has(question.type)) return;
    const answer = answers[question.id];
    const rule = (question.skip_rules || []).find(candidate => {
      if (question.type === 'multiple_choice') return Array.isArray(answer) && answer.length === 1 && answer[0] === candidate.option;
      return answer === candidate.option;
    });
    const target = Number(rule?.skip_to);
    if (!Number.isInteger(target) || target <= index + 2) return;
    for (let step = index + 2; step < Math.min(target, questions.length + 1); step += 1) {
      const skippedID = questions[step - 1]?.id;
      if (skippedID) skipped.add(skippedID);
    }
  });
  return skipped;
}

/**
 * Groups informational layout blocks with the next answer field while keeping
 * the builder's complete, one-based skip destination sequence authoritative.
 * `omitted` names questions this respondent is not asked at all.
 * A trailing statement becomes its own review step so it is never silently
 * omitted before submission.
 */
export function buildPublicFormSteps(questions, answers, omitted = []) {
  const items = Array.isArray(questions) ? questions : [];
  // Questions that do not apply to this respondent join the skipped set rather
  // than being removed from the list: skip destinations are one-based
  // positions in the published definition, and dropping an item would silently
  // move every destination after it.
  const skipped = computeSkippedQuestionIDs(items, answers || {});
  for (const id of omitted) skipped.add(id);
  const steps = [];
  let information = [];

  items.forEach(item => {
    if (!item || item.hidden || skipped.has(item.id)) return;
    if (LAYOUT_TYPES.has(item.type)) {
      information.push(item);
      return;
    }
    steps.push({ information, question: item });
    information = [];
  });

  if (information.length) steps.push({ information, question: null });
  return { skipped, steps };
}

export function fieldPositionLabel(question, index) {
  const label = question?.question?.trim() || question?.content?.trim() || 'Untitled field';
  return `Q${index + 1} \u201c${label}\u201d`;
}

/**
 * Every broken skip rule in a draft, with the field it sits on and why it fails.
 *
 * The builder's destination menu only ever offers valid jumps, so these rules
 * are not typed by hand — they are left behind when fields are reordered,
 * deleted, or changed to a type that has no options. That is why the reason
 * matters: "clear it" is right for a rule stranded past the end of the form,
 * and wrong for one that simply needs a destination chosen.
 */
export function skipRuleProblems(questions = []) {
  const end = questions.length + 1;
  return questions.flatMap((question, index) => (question?.skip_rules || []).flatMap(rule => {
    const target = Number(rule?.skip_to);
    const where = fieldPositionLabel(question, index);
    const forOption = rule?.option ? ` for \u201c${rule.option}\u201d` : '';
    const problem = { index, position: index + 1, option: rule?.option ?? null, target: rule?.skip_to };

    // Number(null), Number('') and Number(false) are all 0, and 0 is what the
    // builder stores for nothing at all — so an empty destination has to be
    // caught before the range checks, or it reports as a jump back to "Q0".
    if (rule?.skip_to === null || rule?.skip_to === undefined || rule?.skip_to === ''
      || !Number.isInteger(target) || target < 1) {
      return [{ ...problem, reason: 'no-destination',
        message: `${where} has a skip rule${forOption} with no destination.`,
        fix: 'Choose where it should jump, or clear the rule.' }];
    }
    if (target > end) {
      return [{ ...problem, reason: 'past-end',
        message: `${where} skips to Q${target}${forOption}, but the form ends at Q${questions.length}.`,
        fix: 'The fields were probably reordered or deleted. Clear the rule or pick a destination that still exists.' }];
    }
    // index + 1 is this field's own number, so anything at or below it loops.
    if (target <= index + 1) {
      return [{ ...problem, reason: 'backwards',
        message: `${where} skips back to Q${target}${forOption}.`,
        fix: 'Skip logic can only jump forward, otherwise the form loops.' }];
    }
    if (target === index + 2) {
      return [{ ...problem, reason: 'next-field',
        message: `${where} skips to Q${target}${forOption}, which is already the next field.`,
        fix: 'A skip has to jump over at least one field. Choose a later one, or set it back to "Continue to next field".' }];
    }
    return [];
  }));
}
