import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArrowDown, ArrowLeft, ArrowUp, BarChart3, Check, ChevronRight,
  Copy, Download, ExternalLink, Eye, GitBranch, GripVertical, Link2,
  List, LoaderCircle, Pause, Pencil, Play, Plus, Search, Trash2, X,
} from 'lucide-react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { canOfferAlreadyProvided } from '@/lib/formAlreadyProvided';
import { activeQuestions, archiveFormResponse, archiveOwnerForm, CHARTABLE_TYPES, FORM_CHANGED_ELSEWHERE, CHOICE_TYPES, createField, createFormDraft, FIELD_TYPES, FORM_TYPES, getFormResponse, listFormResponses, listOwnerForms, publicFormURL, remapSkipTargets, responseCSV, saveOwnerForm, slugifyFormTitle, skipRuleProblems, updateFormResponseStatus, validateFormDraft } from '@/lib/xertForms';
import { answerImage, answerTable } from '@/lib/formAnswers';
import { continueDotPoints, toggleDotPoints } from '@/lib/formText';
import AdminConfirmDialog from './AdminConfirmDialog';
import FormQRCode from './FormQRCode';
import FormResponseRecord, { FormRecordLoading } from './FormResponseRecord';
import { respondentIdentity, respondentLabel } from '@/lib/formResponseRecord';
import { QuestionPreview } from '@/pages/PublicForm';
import { ADMIN_BUTTON, ADMIN_PANEL, AdminBadge, AdminDataTable, AdminEmptyState, AdminFilterBar, AdminFormField, AdminPageHeader, AdminSegmented, AdminSkeleton, AdminStatCard } from './ui';
import './forms.css';

const panel = ADMIN_PANEL;
const control = 'admin-kit-input';
const shell = 'forms-workspace admin-kit-container';
const button = 'admin-kit-button';
const primary = `admin-kit-button ${ADMIN_BUTTON.primary}`;

function FormCardsLoading() {
  return <div role="status" aria-label="Loading forms" className="forms-grid forms-grid-two">{[0,1,2].map(index => <article key={index} aria-hidden="true" data-form-placeholder="card" className={`${panel} forms-card`}><div className="forms-contact"><AdminSkeleton decorative size="title" /><AdminSkeleton decorative size="short" className="forms-loading-badge" /><AdminSkeleton decorative size="medium" /></div></article>)}</div>;
}

function AnalyticsLoading({ questions, view }) {
  if (view === 'trends') return <div role="status" aria-label="Loading responses"><section aria-hidden="true" data-form-placeholder="trend" className={`${panel} forms-card forms-loading-stack`}><AdminSkeleton decorative size="title" /><ol className="forms-trends forms-loading-trends">{Array.from({length:14}, (_,index) => <li key={index}><AdminSkeleton decorative size="short" /><AdminSkeleton decorative /><AdminSkeleton decorative size="short" /></li>)}</ol></section></div>;
  return <div role="status" aria-label="Loading responses" className="forms-grid forms-grid-two">{questions.map(question => <section key={question.id} aria-hidden="true" data-form-placeholder="question" className={`${panel} forms-card forms-loading-stack`}><AdminSkeleton decorative size="title" /><AdminSkeleton decorative size="short" /><div className="forms-loading-stack">{[0,1,2].map(index => <div key={index} data-form-placeholder="answer-row" className="forms-contact"><AdminSkeleton decorative /><AdminSkeleton decorative size="medium" /></div>)}</div></section>)}</div>;
}

function Toggle({ checked, onChange, label, description = '' }) {
  return <div className="forms-toggle"><span><span className="admin-kit-label">{label}</span>{description && <span className="forms-secondary">{description}</span>}</span><button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)} className={button}>{checked ? 'On' : 'Off'}</button></div>;
}
// Types whose answer box on the public form actually shows example text. Date
// and time inputs are handed one too, but no browser draws a placeholder on a
// date picker, so offering it there would be one more field nobody sees.
const EXAMPLE_ANSWER_TYPES = new Set(['short_text', 'long_text', 'email', 'phone', 'url', 'number']);
const TYPE_LABELS = Object.fromEntries(FIELD_TYPES.map(type => [type.value, type.label]));
const TYPE_GROUPS = [...new Set(FIELD_TYPES.map(type => type.group))];
const GROUP_LABELS = { Layout: 'Headings and text' };
const sectionTitle = 'text-xs font-bold uppercase tracking-wider text-text-secondary';

// Anything people read on the form: a hint, supporting text, a statement, the
// introduction. Dot points work the way they do in a document. The button
// turns the lines the cursor is on into points (or back), and Enter carries
// the list on, so nobody has to know that "•" at the start of a line is what
// makes one. The box grows with the text, up to a point, then scrolls.
function WritingBox({ label, note = '', value, onChange, ariaLabel = undefined, placeholder = '', minRows = 2, autoFocus = false }) {
  const id = useId();
  const box = useRef(null);
  const pendingSelection = useRef(null);
  useLayoutEffect(() => {
    if (!pendingSelection.current || !box.current) return;
    box.current.setSelectionRange(pendingSelection.current.selectionStart, pendingSelection.current.selectionEnd);
    pendingSelection.current = null;
  });
  const text = String(value || '');
  // Counting line breaks misses a long line that wraps, which is exactly what
  // a hint written along one line is; the rendered height does not.
  useLayoutEffect(() => {
    const current = box.current;
    if (!current) return;
    current.style.height = 'auto';
    current.style.height = `${current.scrollHeight + current.offsetHeight - current.clientHeight}px`;
  }, [text]);
  const apply = next => { pendingSelection.current = next; onChange(next.text); box.current?.focus(); };
  const dotPoints = () => {
    const current = box.current;
    apply(toggleDotPoints(text, current?.selectionStart ?? text.length, current?.selectionEnd ?? text.length));
  };
  const onKeyDown = event => {
    const current = event.currentTarget;
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || current.selectionStart !== current.selectionEnd) return;
    const next = continueDotPoints(current.value, current.selectionStart);
    if (!next) return;
    event.preventDefault();
    apply(next);
  };
  return <div className="text-xs text-text-secondary">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <label htmlFor={id}>{label}{note && <span className="forms-secondary">{note}</span>}</label>
      {/* Keeps the cursor in the box, so the button acts on the line it is on. */}
      <button type="button" className={`${button} px-3`} onMouseDown={event => event.preventDefault()} onClick={dotPoints}><List className="h-4 w-4" aria-hidden="true" /> Dot points</button>
    </div>
    <textarea ref={box} id={id} aria-label={ariaLabel} rows={minRows} autoFocus={autoFocus} className={`${control} mt-1`} value={text} placeholder={placeholder} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
  </div>;
}

function FieldEditor({ field, fields, index, count, open, onToggle, autoFocus = false, dragHandleProps = null, onUpdate, onPatch, onMove, onDuplicate, onRemove }) {
  const choices = field.type === 'yes_no' ? ['Yes', 'No'] : field.options || [];
  const layout = ['section_break', 'statement'].includes(field.type);
  const forwardDestinations = fields
    .map((destination, destinationIndex) => ({ destination, destinationIndex }))
    .filter(({ destinationIndex }) => destinationIndex >= index + 2);
  const validSkipTargets = new Set([
    ...forwardDestinations.map(({ destinationIndex }) => destinationIndex + 1),
    ...(index < count - 1 ? [count + 1] : []),
  ]);
  const hasInvalidSkipRules = (field.skip_rules || []).some(rule => !validSkipTargets.has(Number(rule.skip_to)));
  // Why each rule is broken, in the same words the save error uses.
  const skipProblems = skipRuleProblems(fields).filter(problem => problem.index === index);
  const clearInvalidSkipRules = () => onUpdate('skip_rules', (field.skip_rules || []).filter(rule => validSkipTargets.has(Number(rule.skip_to))));
  const hasSkipRules = (field.skip_rules || []).length > 0;
  // A question with no rules shows one button, not a dropdown per option that
  // all say "Continue to next field" — on a six-option question that was half
  // the editor. Rules that exist, or are broken, are always shown in full.
  const [showSkip, setShowSkip] = useState(false);
  const kind = field.type === 'section_break' ? 'Section' : field.type === 'statement' ? 'Statement' : `Q${index + 1}`;
  const name = layout ? kind.toLowerCase() : `question ${index + 1}`;
  const wording = String((layout ? field.content : field.question) || '').trim();
  // Example text typed into a question with no answer box is shown to nobody.
  // Say so where it was typed, rather than hide the field and leave the words
  // stranded where the owner can no longer see them either.
  const unseenExample = !layout && !EXAMPLE_ANSWER_TYPES.has(field.type) && Boolean(String(field.placeholder || '').trim());
  const moveExampleIntoHint = () => onPatch({
    description: [field.description, field.placeholder].map(text => String(text || '').trim()).filter(Boolean).join('\n\n'),
    placeholder: '',
  });
  return <article id={`form-field-${field.id}`} className={`${panel} ${field.hidden ? 'opacity-60' : ''}`}>
    {/* The heading is the whole field when it is closed: enough to scan a long
        form, find the one to change, and flip Required without opening it. */}
    <div className="flex flex-wrap items-center gap-2 p-3">
      <span className={`${button} cursor-grab px-2`} aria-label={`Drag to reorder ${name}`} {...(dragHandleProps || {})}><GripVertical className="h-4 w-4" aria-hidden="true" /></span>
      <span className="text-xs font-bold uppercase tracking-widest text-accent-default">{kind}</span>
      <button type="button" aria-expanded={open} onClick={onToggle} className="line-clamp-2 grow basis-48 text-left text-sm text-text-primary">{wording || <span className="text-text-secondary">{layout ? 'Untitled' : 'Untitled question'}</span>}</button>
      <span className="text-xs text-text-secondary">{TYPE_LABELS[field.type] || field.type}</span>
      {field.hidden && <AdminBadge status="inactive">Hidden</AdminBadge>}
      {hasSkipRules && !hasInvalidSkipRules && <AdminBadge status="new">Skip logic</AdminBadge>}
      {hasInvalidSkipRules && <span className="inline-flex items-center gap-1 self-start rounded-full border border-status-warning-300/40 bg-status-warning-300/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-status-warning-100"><GitBranch className="h-3 w-3" /> Skip logic</span>}
      {unseenExample && <AdminBadge status="pending">Unseen text</AdminBadge>}
      {/* Required lives on the heading so it can be read and changed without
          opening the field. It used to sit at the bottom of the expanded
          editor, so a collapsed field never said whether it was required. */}
      {!layout && <button type="button" role="switch" aria-checked={Boolean(field.required)} aria-label={`Question ${index + 1} is required`} className={`${button} px-3`} onClick={() => onUpdate('required', !field.required)}>{field.required ? 'Required' : 'Optional'}</button>}
      <button type="button" className={`${button} px-3`} aria-expanded={open} aria-label={`${open ? 'Close' : 'Edit'} ${name}`} onClick={onToggle}>{open ? 'Done' : 'Edit'}</button>
    </div>
    {open && <div className="border-t border-border-hairline p-4"><div className="forms-grid forms-grid-two gap-5">
      <div className="space-y-5">
        <section className="space-y-3">
          <p className={sectionTitle}>{layout ? kind : 'Question'}</p>
          {/* A statement is often a whole agreement. A one-line input cannot hold a
              line break: the browser strips them, so typing a single character
              into one used to flatten every paragraph and point into one line. */}
          {field.type === 'statement' ? <WritingBox label="What it says" ariaLabel={`Question ${index + 1}`} autoFocus={autoFocus} minRows={4} value={field.content} placeholder="e.g. Please bring a copy of each certificate to your first session." onChange={value => onUpdate('content', value)} /> : <label className="block text-xs text-text-secondary">{field.type === 'section_break' ? 'Heading' : 'What are you asking?'}<input aria-label={`Question ${index + 1}`} autoFocus={autoFocus} className={`${control} mt-1`} value={layout ? field.content || '' : field.question || ''} onChange={event => onUpdate(layout ? 'content' : 'question', event.target.value)} placeholder={layout ? 'e.g. Qualifications and certificates' : 'e.g. Do you have any injuries?'} /></label>}
          <label className="block text-xs text-text-secondary">Type<select aria-label={`Field type for question ${index + 1}`} className={`${control} mt-1`} value={field.type} onChange={event => onUpdate('type', event.target.value)}>{TYPE_GROUPS.map(group => <optgroup key={group} label={GROUP_LABELS[group] || group}>{FIELD_TYPES.filter(type => type.group === group).map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</optgroup>)}</select></label>
          {!layout && <WritingBox label="Hint" note="Shown under the question, in smaller text." ariaLabel={`Hint for question ${index + 1}`} value={field.description} onChange={value => onUpdate('description', value)} />}
          {!layout && EXAMPLE_ANSWER_TYPES.has(field.type) && <label className="block text-xs text-text-secondary">Example answer<span className="forms-secondary">Faint text inside the answer box. It disappears as they type.</span><input aria-label={`Example answer for question ${index + 1}`} className={`${control} mt-1`} value={field.placeholder || ''} onChange={event => onUpdate('placeholder', event.target.value)} /></label>}
          {/* A section break and a statement both render supporting text under their
              title on the public form. */}
          {layout && <WritingBox label="Supporting text" value={field.description} placeholder={field.type === 'section_break' ? 'Shown under the section heading' : 'Shown under the statement'} onChange={value => onUpdate('description', value)} />}
          {unseenExample && <div role="note" className="rounded-lg border border-status-warning-300/30 bg-status-warning-300/10 p-3"><p className="text-xs font-bold uppercase tracking-wider text-status-warning-100">Nobody sees this text</p><p className="mt-1 text-xs text-status-warning-100">&ldquo;{field.placeholder}&rdquo;</p><p className="mt-2 text-xs text-text-secondary">It is saved as example text for the answer box, but a {String(TYPE_LABELS[field.type] || 'question').toLowerCase()} question has no answer box to show it in. Move it into the hint to show it under the question, or clear it.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} onClick={moveExampleIntoHint}>Move into hint</button><button type="button" className={button} onClick={() => onUpdate('placeholder', '')}>Clear it</button></div></div>}
        </section>
        {['single_choice', 'multiple_choice', 'dropdown'].includes(field.type) && <section className="space-y-2"><p className={sectionTitle}>Answers they can pick</p>{(field.options || []).map((option, optionIndex) => <div className="flex gap-2" key={`${field.id}-${optionIndex}`}><input aria-label={`Option ${optionIndex + 1} for question ${index + 1}`} className={control} value={option} onChange={event => onUpdate('options', field.options.map((item, i) => i === optionIndex ? event.target.value : item))} /><button type="button" aria-label={`Remove option ${optionIndex + 1} for question ${index + 1}`} className={`${button} px-3`} onClick={() => onUpdate('options', field.options.filter((_, i) => i !== optionIndex))}><X className="h-4 w-4" /></button></div>)}<button type="button" className={button} onClick={() => onUpdate('options', [...(field.options || []), `Option ${(field.options || []).length + 1}`])}><Plus className="h-4 w-4" /> Add option</button><Toggle checked={Boolean(field.allow_other)} onChange={value => onUpdate('allow_other', value)} label="Allow an Other answer" description="Adds an Other choice with a box to type in." /></section>}
        {['linear_scale', 'star_rating'].includes(field.type) && <section className="space-y-2"><p className={sectionTitle}>Scale</p><div className="forms-grid forms-stats"><label className="text-xs text-text-secondary">Lowest<input type="number" className={`${control} mt-1`} value={field.scale_min ?? 1} onChange={event => onUpdate('scale_min', Number(event.target.value))} /></label><label className="text-xs text-text-secondary">Highest<input type="number" className={`${control} mt-1`} value={field.scale_max ?? 10} onChange={event => onUpdate('scale_max', Number(event.target.value))} /></label><label className="text-xs text-text-secondary">Word for the lowest<input className={`${control} mt-1`} value={field.scale_min_label || ''} onChange={event => onUpdate('scale_min_label', event.target.value)} /></label><label className="text-xs text-text-secondary">Word for the highest<input className={`${control} mt-1`} value={field.scale_max_label || ''} onChange={event => onUpdate('scale_max_label', event.target.value)} /></label></div></section>}
        {CHOICE_TYPES.has(field.type) && choices.length > 0 && (index < count - 1 || hasInvalidSkipRules) && <div className="border-t border-border-hairline pt-4"><p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-secondary"><GitBranch className="h-4 w-4" /> Skip logic</p>{showSkip || hasSkipRules ? <div className="grid gap-2">{choices.map(option => { const rule = (field.skip_rules || []).find(item => item.option === option); const selectedTarget = validSkipTargets.has(Number(rule?.skip_to)) ? Number(rule.skip_to) : 0; return <label key={option} className="forms-branch-row"><span>If “{option}”</span><ChevronRight className="hidden" /><select aria-label={`Skip destination for ${option}`} className={control} value={selectedTarget} onChange={event => { const others = (field.skip_rules || []).filter(item => item.option !== option); const target = Number(event.target.value); onUpdate('skip_rules', validSkipTargets.has(target) ? [...others, { option, skip_to: target }] : others); }}><option value={0}>Continue to next field</option>{forwardDestinations.map(({ destination, destinationIndex }) => <option key={destination.id} value={destinationIndex + 1}>Jump to Q{destinationIndex + 1}: {destination.question || destination.content || 'Untitled field'}</option>)}{index < count - 1 && <option value={count + 1}>End form</option>}</select></label>; })}</div> : <button type="button" className={button} onClick={() => setShowSkip(true)}><GitBranch className="h-4 w-4" /> Set up skip logic</button>}{hasInvalidSkipRules && <div className="mt-3 rounded-lg border border-status-warning-300/30 bg-status-warning-300/[0.06] p-3">{skipProblems.map(problem => <p key={`${problem.option}-${problem.target}`} className="text-xs text-status-warning-100">{problem.message} {problem.fix}</p>)}<button type="button" className={`${button} mt-2 border-status-warning-300/30 text-status-warning-100`} onClick={clearInvalidSkipRules}>Clear obsolete skip rules</button></div>}<p className="mt-2 text-xs text-text-secondary">Send people further ahead depending on their answer. Jumps only go forward, so the form can never loop.</p></div>}
        {hasInvalidSkipRules && !(CHOICE_TYPES.has(field.type) && choices.length > 0) && <div className="rounded-lg border border-status-warning-300/30 bg-status-warning-300/[0.06] p-3"><p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-status-warning-100"><GitBranch className="h-4 w-4" /> Skip logic left over</p>{skipProblems.map(problem => <p key={`${problem.option}-${problem.target}`} className="text-xs text-status-warning-100">{problem.message} {problem.fix}</p>)}<p className="mt-2 text-xs text-text-secondary">This field has no options to branch on any more, so the rules do nothing — but they still block saving.</p><button type="button" className={`${button} mt-2 border-status-warning-300/30 text-status-warning-100`} onClick={() => onUpdate('skip_rules', [])}>Clear skip rules</button></div>}
        {!layout && <section className="space-y-2"><p className={sectionTitle}>Picture, video or link above the question</p><div className="forms-grid forms-grid-three"><label className="text-xs text-text-secondary">Show<select className={`${control} mt-1`} value={field.media_type || ''} onChange={event => onUpdate('media_type', event.target.value || null)}><option value="">Nothing</option><option value="image">A picture</option><option value="video">A video</option><option value="link">A link</option></select></label>{field.media_type && <label className="text-xs text-text-secondary forms-span-two">Web address<input type="url" className={`${control} mt-1`} placeholder="https://" value={field.media_url || ''} onChange={event => onUpdate('media_url', event.target.value)} /></label>}</div></section>}
        <section className="space-y-2 border-t border-border-hairline pt-4"><p className={sectionTitle}>More settings</p><Toggle checked={Boolean(field.hidden)} onChange={value => onUpdate('hidden', value)} label={layout ? 'Hide this block' : 'Hide this question'} description="Nobody sees it. Answers already given are kept." />{canOfferAlreadyProvided(field) && <Toggle checked={field.allow_already_provided === true} onChange={value => onUpdate('allow_already_provided', value)} label="'Already provided' tick" description="Lets them tick instead of typing an answer they already gave." />}</section>
        <div className="flex flex-wrap items-center gap-2 border-t border-border-hairline pt-3"><span className="flex-1" /><button type="button" className={`${button} px-3`} disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move field up"><ArrowUp className="h-4 w-4" /></button><button type="button" className={`${button} px-3`} disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move field down"><ArrowDown className="h-4 w-4" /></button><button type="button" className={button} aria-label={`Duplicate question ${index + 1}`} onClick={onDuplicate}><Copy className="h-4 w-4" /> Duplicate</button><button type="button" className={`${button} text-status-danger-300`} aria-label={`Remove question ${index + 1}`} onClick={onRemove}><Trash2 className="h-4 w-4" /> Remove</button></div>
      </div>
      <aside aria-label={`Preview of ${name}`} className="space-y-2">
        <p className={sectionTitle}>What they will see</p>
        {field.hidden && <p className="text-xs text-text-secondary">Hidden: nobody sees this until you switch it back on.</p>}
        <QuestionPreview key={`${field.id}-${field.type}`} question={field} />
      </aside>
    </div></div>}
  </article>;
}
function FormEditor({ draft, setDraft, onSave, onCancel, saving, error, forms = [], onReloadStale = null }) {
  const [tab, setTab] = useState('fields');
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  // Functional so two changes in one handler both land; reading draft from the
  // closure made the second silently overwrite the first.
  const patchField = (index, patch) => setDraft(current => ({ ...current, questions: current.questions.map((field, i) => i === index ? { ...field, ...patch } : field) }));
  const updateField = (index, key, value) => patchField(index, { [key]: value });
  // Every change to the list's shape goes through here, so skip rules keep
  // pointing at the question they were written for rather than a position.
  const setQuestions = change => setDraft(current => ({ ...current, questions: remapSkipTargets(current.questions, change(current.questions)) }));
  const moveField = (from, to) => setQuestions(list => { const next = [...list]; const [field] = next.splice(from, 1); next.splice(to, 0, field); return next; });
  // One field open at a time: the first on arrival, a new one as soon as it is
  // added. Everything else stays a single scannable line.
  const [openId, setOpenId] = useState(() => draft.questions[0]?.id ?? null);
  const [newId, setNewId] = useState(null);
  const [adding, setAdding] = useState(false);
  const addField = type => { const field = createField(type); setQuestions(list => [...list, field]); setOpenId(field.id); setNewId(field.id); setAdding(false); };
  const duplicateField = index => { const source = draft.questions[index]; const layout = ['section_break', 'statement'].includes(source.type); const copy = { ...source, id: crypto.randomUUID(), ...(layout ? { content: `${source.content || ''} (copy)` } : { question: `${source.question || ''} (copy)` }) }; setQuestions(list => [...list.slice(0, index + 1), copy, ...list.slice(index + 1)]); setOpenId(copy.id); };
  const removeField = index => setQuestions(list => list.filter((_, i) => i !== index));
  const onDragEnd = ({ source, destination }) => { if (destination && destination.index !== source.index) moveField(source.index, destination.index); };
  // Headings and statements have no answer, so "required" means nothing on
  // them. Hidden questions are counted and changed too: the database already
  // skips them when checking a submission, so this cannot block anyone.
  const answerable = field => !['section_break', 'statement'].includes(field.type);
  const answerableCount = draft.questions.filter(answerable).length;
  const requiredCount = draft.questions.filter(field => answerable(field) && field.required).length;
  const setAllRequired = value => update('questions', draft.questions.map(field => answerable(field) ? { ...field, required: value } : field));
  return <fieldset disabled={saving} aria-busy={saving} className={`${shell} forms-editor space-y-5`}>
    <AdminPageHeader eyebrow="Form builder" title="Edit form" description={null}><button type="button" className={button} onClick={onCancel}><ArrowLeft className="h-4 w-4" /> Back</button><button type="button" className={primary} disabled={saving} onClick={onSave}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save form</button></AdminPageHeader>
    <AdminFormField label="Form title"><input aria-label="Form title" value={draft.title} onChange={event => update('title', event.target.value)} /></AdminFormField>
    {error && <div role="alert" className="border border-status-warning-300/30 bg-status-warning-300/10 p-3 text-sm text-status-warning-100"><p>{error}</p>{onReloadStale && <button type="button" className={`${button} mt-3`} disabled={saving} onClick={onReloadStale}>Reload the latest version</button>}</div>}
    <AdminSegmented label="Form editor view" options={[{value:'fields',label:'Fields'},{value:'settings',label:'Settings'}]} value={tab} onValueChange={setTab} />
    {tab === 'fields' ? <div className="space-y-3">{answerableCount > 0 && <div className={`${panel} forms-toggle p-4`}><span><span className="admin-kit-label">Required questions</span><span className="forms-secondary">{requiredCount} of {answerableCount} {answerableCount === 1 ? 'question is' : 'questions are'} marked required</span></span><span className="flex flex-wrap gap-2"><button type="button" className={button} disabled={requiredCount === answerableCount} onClick={() => setAllRequired(true)}>Make all required</button><button type="button" className={button} disabled={requiredCount === 0} onClick={() => setAllRequired(false)}>Make all optional</button></span></div>}
      {/* Drag by the handle with a mouse or finger, or with the keyboard: focus
          the handle, Space to lift, arrows to move, Space to drop. */}
      <DragDropContext onDragEnd={onDragEnd}><Droppable droppableId="form-questions">{list => <div ref={list.innerRef} {...list.droppableProps}>{draft.questions.map((field, index) => <Draggable key={field.id} draggableId={String(field.id)} index={index} isDragDisabled={saving}>{item => <div ref={item.innerRef} {...item.draggableProps} className="pb-3"><FieldEditor field={field} fields={draft.questions} index={index} count={draft.questions.length} open={openId === field.id} onToggle={() => setOpenId(current => current === field.id ? null : field.id)} autoFocus={newId === field.id} dragHandleProps={item.dragHandleProps} onUpdate={(key, value) => updateField(index, key, value)} onPatch={patch => patchField(index, patch)} onMove={offset => moveField(index, index + offset)} onDuplicate={() => duplicateField(index)} onRemove={() => removeField(index)} /></div>}</Draggable>)}{list.placeholder}</div>}</Droppable></DragDropContext>
      {/* Choosing the type first means a new question arrives already shaped
          for what it asks, rather than as short text to be converted. */}
      <button type="button" className={`${button} w-full border-dashed`} aria-expanded={adding} onClick={() => setAdding(current => !current)}><Plus className="h-4 w-4" /> Add a question</button>
      {adding && <div role="group" aria-label="Choose what to add" className={`${panel} space-y-4 p-4`}>{TYPE_GROUPS.map(group => <div key={group}><p className={`${sectionTitle} mb-2`}>{GROUP_LABELS[group] || group}</p><div className="flex flex-wrap gap-2">{FIELD_TYPES.filter(type => type.group === group).map(type => <button key={type.value} type="button" className={button} onClick={() => addField(type.value)}>{type.label}</button>)}</div></div>)}</div>}
    </div> : <div className="forms-grid forms-grid-two">
      <section className={`${panel} space-y-4 p-5`}><h2 className="font-display text-2xl uppercase text-text-primary">Respondent details</h2>{[['collect_name','collect_name_required','Name'],['collect_email','collect_email_required','Email'],['collect_phone','collect_phone_required','Phone']].map(([visible, required, label]) => <div key={visible} className="border-b border-border-hairline pb-3"><Toggle checked={Boolean(draft[visible])} onChange={value => update(visible, value)} label={`Collect ${label.toLowerCase()}`} />{draft[visible] && <Toggle checked={Boolean(draft[required])} onChange={value => update(required, value)} label={`Require ${label.toLowerCase()}`} />}</div>)}<Toggle checked={draft.one_response_per_email} onChange={value => { update('one_response_per_email', value); if (value) { update('collect_email', true); update('collect_email_required', true); } }} label="One response per email" description="Email collection becomes required to prevent duplicate submissions" /></section>
      <section className={`${panel} space-y-4 p-5`}><h2 className="font-display text-2xl uppercase text-text-primary">Publishing</h2><Toggle checked={draft.is_active} onChange={value => update('is_active', value)} label="Form is live" description="Public link accepts responses" /><Toggle checked={draft.show_progress_bar} onChange={value => update('show_progress_bar', value)} label="Show progress bar" /><Toggle checked={draft.notify_admin} onChange={value => update('notify_admin', value)} label="Flag new responses for owner review" /><Toggle checked={draft.email_copy_to_respondent} onChange={value => update('email_copy_to_respondent', value)} label="Email the person a copy" description="For anything somebody signs and should keep. Sends their answers as soon as they submit, to the email on the form." /><label className="block text-xs text-text-secondary">Public link slug<input className={`${control} mt-1`} value={draft.slug} onChange={event => update('slug', event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></label><label className="block text-xs text-text-secondary">Complete this form first<select className={`${control} mt-1`} value={draft.prerequisite_form_id || ''} onChange={event => update('prerequisite_form_id', event.target.value || null)}><option value="">No form comes first</option>{forms.filter(item => item.id !== draft.id && item.is_active).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><span className="mt-1 block text-text-secondary">Anyone opening this link is sent to that form first, and comes back here the moment it is submitted.</span></label></section>
      <section className={`${panel} space-y-4 p-5 forms-span-all`}><h2 className="font-display text-2xl uppercase text-text-primary">Introduction and completion</h2><WritingBox label="Description" note="Shown under the form's title." minRows={4} value={draft.description} onChange={value => update('description', value)} /><div className="forms-grid forms-grid-three"><label className="text-xs text-text-secondary">Header media<select className={`${control} mt-1`} value={draft.header_media_type || ''} onChange={event => update('header_media_type', event.target.value || null)}><option value="">None</option><option value="image">Image</option><option value="video">Video</option><option value="link">Link</option></select></label><label className="text-xs text-text-secondary forms-span-two">Media URL<input className={`${control} mt-1`} type="url" value={draft.header_media_url || ''} onChange={event => update('header_media_url', event.target.value)} /></label></div><label className="block text-xs text-text-secondary">Thank-you message<textarea rows={3} className={`${control} mt-1 py-3`} value={draft.thank_you_message || ''} onChange={event => update('thank_you_message', event.target.value)} /></label><label className="block text-xs text-text-secondary">Optional redirect URL<input className={`${control} mt-1`} type="url" value={draft.redirect_url || ''} onChange={event => update('redirect_url', event.target.value)} placeholder="https://" /></label></section>
    </div>}
  </fieldset>;
}
/**
 * One option inside a question breakdown. Shows how many chose it and what
 * share of answers that is, and opens to name the people who chose it —
 * "how many said no" is rarely the real question; "who said no" is.
 */
function OptionBreakdown({ label, count, total, maximum, people, isOpen, onToggle }) {
  const share = total ? Math.round((count / total) * 100) : 0;
  const rowLabel = `${label}: ${count} of ${total} (${share}%)`;
  return (
    <div>
      <button type="button" onClick={onToggle} disabled={count === 0} aria-expanded={isOpen}
        aria-label={count === 0 ? `${rowLabel}. Nobody chose this.` : `${rowLabel}. Show who chose this.`}
        className="forms-option-breakdown admin-kit-button">
        <span className="flex min-w-0 items-center gap-1.5">
          {count > 0 && <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-accent-default transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true" />}
          <span className="text-text-secondary">{label}</span>
        </span>
        <span className="h-2 bg-surface-sunken"><span className="block h-full bg-accent-default" style={{ width: `${maximum ? count / maximum * 100 : 0}%` }} /></span>
        <span className="whitespace-nowrap text-right tabular-nums text-text-primary">{count}<span className="ml-1 text-xs text-text-secondary">({share}%)</span></span>
      </button>
      {isOpen && (
        <ul className="mb-2 mt-1 space-y-1 border-l-2 border-border-hairline pl-3">
          {people.map(person => (
            <li key={person.id} className="text-xs leading-5 text-text-secondary">
              <span className="text-text-primary">{respondentLabel(person)}</span>
              {respondentIdentity(person).email && <> · <a className="text-accent-default" href={`mailto:${respondentIdentity(person).email}`}>{respondentIdentity(person).email}</a></>}
              {respondentIdentity(person).phone && <> · <a className="text-accent-default" href={`tel:${String(respondentIdentity(person).phone).replace(/\s+/g, '')}`}>{respondentIdentity(person).phone}</a></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Analytics({ form, onBack }) {
  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState('');
  const [selectedResponseID, setSelectedResponseID] = useState(null);
  const [selectedResponse, setSelectedResponse] = useState(null);
  const [loadingSelectedResponse, setLoadingSelectedResponse] = useState(false);
  const [updatingResponseID, setUpdatingResponseID] = useState(null);
  const [responseToArchive, setResponseToArchive] = useState(null);
  const [responseQuery, setResponseQuery] = useState('');
  const [openOption, setOpenOption] = useState(null);
  const [responseStatus, setResponseStatus] = useState('all');
  const [listError, setListError] = useState('');
  const [listAttempt, setListAttempt] = useState(0);
  const [recordAttempt, setRecordAttempt] = useState(0);
  const responseMutation = useRef(false);

  useEffect(() => {
    let current = true;
    setResponses([]);
    setSelectedResponseID(null);
    setLoading(true);
    setError('');
    setListError('');
    listFormResponses(form.id)
      .then(items => { if (current) setResponses(items); })
      .catch(err => { if (current) setListError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [form.id, listAttempt]);

  useEffect(() => {
    let current = true;
    setSelectedResponse(null);
    if (!selectedResponseID) {
      setLoadingSelectedResponse(false);
      return () => { current = false; };
    }
    setLoadingSelectedResponse(true);
    setError('');
    getFormResponse(selectedResponseID)
      .then(item => { if (current) setSelectedResponse(item); })
      .catch(err => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoadingSelectedResponse(false); });
    return () => { current = false; };
  }, [selectedResponseID, recordAttempt]);

  const questions = activeQuestions(form);
  const filteredResponses = useMemo(() => {
    const needle = responseQuery.trim().toLocaleLowerCase('en-AU');
    return responses.filter(response => {
      if (responseStatus !== 'all' && response.status !== responseStatus) return false;
      if (!needle) return true;
      return [response.respondent_name, response.respondent_email, response.respondent_phone]
        .some(value => String(value || '').toLocaleLowerCase('en-AU').includes(needle));
    });
  }, [responseQuery, responseStatus, responses]);
  const days = useMemo(() => Array.from({ length: 14 }, (_, offset) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 13 + offset);
    const key = date.toISOString().slice(0, 10);
    return { key, label: date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), count: responses.filter(item => item.completed_at?.slice(0, 10) === key).length };
  }), [responses]);

  const download = () => {
    const blob = new Blob([responseCSV(form, responses)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${form.slug}-responses.csv`; link.click(); URL.revokeObjectURL(link.href);
  };
  const updateStatus = async (response, status) => {
    if (status === response.status || responseMutation.current) return;
    responseMutation.current = true;
    setUpdatingResponseID(response.id); setError('');
    try {
      await updateFormResponseStatus(response.id, status);
      setResponses(current => current.map(item => item.id === response.id ? { ...item, status } : item));
      setSelectedResponse(current => current?.id === response.id ? { ...current, status } : current);
    } catch (err) {
      setError(err.message);
    } finally {
      responseMutation.current = false;
      setUpdatingResponseID(null);
    }
  };
  const archive = async () => {
    if (!responseToArchive || responseMutation.current) return;
    responseMutation.current = true;
    setUpdatingResponseID(responseToArchive.id); setError('');
    try {
      await archiveFormResponse(responseToArchive.id);
      setResponses(current => current.filter(item => item.id !== responseToArchive.id));
      setResponseToArchive(null);
    } catch (err) {
      setError(err.message);
      setResponseToArchive(null);
    } finally {
      responseMutation.current = false;
      setUpdatingResponseID(null);
    }
  };

  const responseColumns = [
    {key:'respondent',header:'Respondent',renderSkeleton:() => <div className="forms-contact"><AdminSkeleton decorative /><AdminSkeleton decorative size="medium" /></div>,render:response => <div className="forms-contact"><h2 className="font-semibold">{respondentLabel(response)}</h2>{respondentIdentity(response).email && <a href={`mailto:${respondentIdentity(response).email}`}>{respondentIdentity(response).email}</a>}{respondentIdentity(response).phone && <a href={`tel:${respondentIdentity(response).phone}`}>{respondentIdentity(response).phone}</a>}</div>},
    {key:'status',header:'Status',render:response => <AdminBadge status={response.status}>{String(response.status || 'new').replace('_', ' ')}</AdminBadge>},
    {key:'submitted',header:'Submitted',render:response => <div className="forms-contact"><time dateTime={response.completed_at}>{new Date(response.completed_at).toLocaleString('en-AU')}</time><span className="forms-secondary">{response.time_taken_seconds || 0}s</span></div>},
    {key:'actions',header:'Actions',renderSkeleton:() => <AdminSkeleton decorative variant="control" />,render:response => <div className="forms-actions"><button type="button" className={primary} disabled={Boolean(updatingResponseID)} onClick={() => setSelectedResponseID(response.id)}><Eye className="h-4 w-4" /> View full form</button><button type="button" className={button} disabled={Boolean(updatingResponseID)} onClick={() => setResponseToArchive(response)} aria-label={`Archive response from ${respondentLabel(response)}`}><Archive className="h-4 w-4" /></button></div>},
  ];

  const selectedResponseMatches = selectedResponseID && selectedResponse?.id === selectedResponseID;

  if (selectedResponseID && !selectedResponseMatches) {
    return <div className={shell}><button type="button" className={button} onClick={() => setSelectedResponseID(null)}><ArrowLeft className="h-4 w-4" /> All responses</button>{loadingSelectedResponse ? <FormRecordLoading /> : <div role="alert"><AdminEmptyState title="Unable to load full response" description={error || 'This response could not be loaded.'} action={<button type="button" className={button} onClick={() => setRecordAttempt(value => value + 1)}>Retry full response</button>} /></div>}</div>;
  }

  if (selectedResponseMatches) {
    return <div className={`${shell} max-w-6xl`}><FormResponseRecord form={form} response={selectedResponse} responses={responses} onSelect={setSelectedResponseID} onBack={() => setSelectedResponseID(null)} onStatusChange={updateStatus} updating={updatingResponseID === selectedResponse.id} error={error} /></div>;
  }

  return <div className={`${shell} max-w-6xl space-y-5`}>
    <AdminPageHeader eyebrow="Analytics" title={form.title} description={null}><button className={button} onClick={onBack}><ArrowLeft className="h-4 w-4" /> Forms</button><button className={button} onClick={download} disabled={loading || Boolean(listError) || !responses.length}><Download className="h-4 w-4" /> Export CSV</button></AdminPageHeader>
    <div className="forms-grid forms-stats">{[['Responses',responses.length],['New',responses.filter(item => item.status === 'new').length],['Avg. time',responses.length ? `${Math.round(responses.reduce((sum,item) => sum + (item.time_taken_seconds || 0), 0) / responses.length)}s` : '—'],['Fields',questions.length]].map(([label,value]) => <AdminStatCard key={label} label={label} value={loading ? '—' : value} />)}</div>
    <AdminSegmented label="Analytics view" options={[{value:'overview',label:'Overview'},{value:'responses',label:'Responses'},{value:'trends',label:'Trends'}]} value={tab} onValueChange={setTab} />
    {error && <p role="alert" className="border border-status-warning-300/30 bg-status-warning-300/10 p-3 text-sm text-status-warning-100">{error}</p>}
    {tab !== 'responses' && loading ? <AnalyticsLoading questions={questions} view={tab} /> : tab !== 'responses' && listError ? <div role="alert"><AdminEmptyState title="Unable to load responses" description={listError} action={<button type="button" className={button} onClick={() => setListAttempt(value => value + 1)}>Retry</button>} /></div> : tab === 'overview' ? <div className="space-y-4">
    <WrittenAnswers responses={responses} questions={questions.filter(question => !CHARTABLE_TYPES.has(question.type))} />
    <div className="forms-grid forms-grid-two">{questions.filter(question => CHARTABLE_TYPES.has(question.type)).map(question => {
      const values = responses.map(item => item.answers?.[question.id]).filter(value => value !== undefined && value !== null && value !== '');
      {
        const flattened = values.flatMap(value => Array.isArray(value) ? value : [value]).map(String);
        const labels = question.type === 'yes_no' ? ['Yes','No'] : question.type === 'star_rating' ? ['1','2','3','4','5'] : question.type === 'nps' ? Array.from({length:11},(_,i) => String(i)) : question.options || [...new Set(flattened)];
        // Keep the respondents behind each option, not just the tally, so staff
        // can act on an answer (who declined photography, who needs clearance).
        const rows = labels.map(label => {
          const people = responses.filter(item => {
            const answer = item.answers?.[question.id];
            if (answer === undefined || answer === null || answer === '') return false;
            return (Array.isArray(answer) ? answer : [answer]).map(String).includes(String(label));
          });
          return { label, count: people.length, people };
        });
        const maximum = Math.max(1, ...rows.map(row => row.count));
        return <section className={`${panel} p-5`} key={question.id}><h2 className="font-semibold text-text-primary">{question.question}</h2><p className="mb-4 text-xs text-text-secondary">{values.length} answers · select an option to see who</p><div className="space-y-1">{rows.map(row => <OptionBreakdown key={row.label} {...row} total={values.length} maximum={maximum} isOpen={openOption === `${question.id}:${row.label}`} onToggle={() => setOpenOption(current => current === `${question.id}:${row.label}` ? null : `${question.id}:${row.label}`)} />)}</div></section>;
      }
    })}</div></div> : tab === 'responses' ? <div className="space-y-4">
      <div className="forms-grid forms-grid-two"><label className="relative"><span className="sr-only">Search respondents</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-text-secondary" /><input className={`${control} pl-10`} value={responseQuery} onChange={event => setResponseQuery(event.target.value)} placeholder="Search name, email or phone" /></label><select aria-label="Filter responses by status" className={control} value={responseStatus} onChange={event => setResponseStatus(event.target.value)}><option value="all">All statuses</option><option value="new">New</option><option value="reviewed">Reviewed</option><option value="followed_up">Followed up</option><option value="closed">Closed</option></select></div>
      <AdminDataTable rows={filteredResponses} columns={responseColumns} label="Form responses" getRowLabel={respondentLabel} loading={loading} error={listError} onRetry={() => setListAttempt(value => value + 1)} emptyTitle={responses.length ? 'No matching responses' : 'No responses yet'} emptyDescription={responses.length ? 'Clear the search or status filter to see other submissions.' : 'Share the live link to start collecting responses.'} />
    </div> : <section className={`${panel} p-5`}><h2 className="mb-5 font-display text-2xl uppercase text-text-primary">Last 14 days</h2><ol className="forms-trends">{days.map(day => { const max = Math.max(1,...days.map(item => item.count)); return <li key={day.key}><span>{day.label}</span><span className="forms-trend-track" aria-hidden="true"><span style={{width:`${day.count/max*100}%`}} /></span><span>{day.count}</span></li>; })}</ol></section>}
    <AdminConfirmDialog open={Boolean(responseToArchive)} onOpenChange={open => !open && setResponseToArchive(null)} title="Archive this response?" description="It will be removed from analytics and the response list. The underlying record remains recoverable in the database." warning={undefined} cancelLabel="Keep response" confirmLabel="Archive response" busy={updatingResponseID === responseToArchive?.id} onConfirm={archive} />
  </div>;
}
/**
 * One answer. A signature is a PNG data URI, and printing it as text gave a
 * wall of base64 that squeezed every other column and told nobody anything.
 */
function AnswerCell({ value, person, label }) {
  const image = answerImage(value);
  if (!image) return value;
  return <img src={image} alt={`${label} from ${person}`} className="forms-signature" />;
}

/**
 * Every written answer in one table: a row per person, a column per question.
 * Reading a name against its own phone number was the whole problem with the
 * old side-by-side lists, so the name is frozen in the first column and the
 * questions scroll under it. On a phone there is no room for that, so each
 * person becomes a card instead.
 */
function WrittenAnswers({ responses, questions }) {
  const { columns, rows } = answerTable(responses, questions);
  if (!columns.length || !rows.length) return null;

  return <section aria-label="Written answers" className={`${panel} p-5`}>
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-semibold text-text-primary">Written answers</h2>
      <p className="text-xs text-text-secondary">{rows.length} {rows.length === 1 ? 'person' : 'people'} · {columns.length} {columns.length === 1 ? 'question' : 'questions'}{columns.length > 2 ? ' · scroll sideways for more' : ''}</p>
    </div>

    {/* Phones: one card per person. */}
    <ul className="forms-written-cards space-y-3">
      {rows.map(row => <li key={row.id} className="border-l-2 border-border-hairline pl-3">
        <p className="flex gap-2 text-sm font-semibold text-text-primary"><span aria-hidden="true" className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-text-secondary">{row.number}</span>{row.person}</p>
        <dl className="mt-1 space-y-0.5">
          {columns.filter(column => row.cells[column.id]).map(column => <div key={column.id} className="flex flex-wrap gap-x-2 text-sm">
            <dt className="text-text-secondary">{column.label}</dt>
            <dd className="text-text-secondary"><AnswerCell value={row.cells[column.id]} person={row.person} label={column.label} /></dd>
          </div>)}
        </dl>
      </li>)}
    </ul>

    {/* Everything wider: a real table, name column pinned. */}
    <div tabIndex={0} role="region" aria-label="Written answers table" className="forms-written-table">
      <table className="border-collapse text-sm">
        <caption className="sr-only">Written answers, one row per person</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-20 border-b border-border-hairline bg-surface-raised px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-text-secondary">Person</th>
            {columns.map(column => <th key={column.id} scope="col" className="sticky top-0 z-10 whitespace-nowrap border-b border-border-hairline bg-surface-raised px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-text-secondary">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <tr key={row.id} className="align-top">
            <th scope="row" className="sticky left-0 z-10 border-b border-border-hairline bg-surface-raised px-3 py-2 text-left font-medium text-text-primary">
              <span aria-hidden="true" className="mr-2 font-mono text-xs tabular-nums text-text-secondary">{row.number}</span>{row.person}
            </th>
            {columns.map(column => <td key={column.id} className="border-b border-border-hairline px-3 py-2 text-text-secondary">
              {row.cells[column.id]
                ? <AnswerCell value={row.cells[column.id]} person={row.person} label={column.label} />
                : <span className="text-text-secondary">&mdash;</span>}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

function Empty({ title, detail }) { return <AdminEmptyState title={title} description={detail} />; }

export default function FormsSurveysManager({ initialAction = null, onIntentHandled = () => {}, onDirtyChange = (_dirty) => {} }) {
  const [forms, setForms] = useState([]); const [loading, setLoading] = useState(true); const [view, setView] = useState('list');
  const [draft, setDraftState] = useState(null); const [active, setActive] = useState(null); const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const [saving, setSaving] = useState(false); const [dirty, setDirty] = useState(false); const [error, setError] = useState(''); const [staleFormID, setStaleFormID] = useState(null); const [notice, setNotice] = useState(''); const [confirmArchive, setConfirmArchive] = useState(null); const [confirmDiscard, setConfirmDiscard] = useState(false);
  const handledIntent = useRef(false);
  const pendingMutation = useRef(false);
  const load = async () => { setLoading(true); try { setForms(await listOwnerForms()); setError(''); } catch (err) { setError(err.message); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const markDirty = value => { setDirty(value); onDirtyChange(value); };
  const setDraft = updater => { setDraftState(updater); markDirty(true); };
  const edit = form => { setDraftState(structuredClone(form)); setView('edit'); setError(''); markDirty(false); };
  const create = type => { setActive(null); setDraftState(createFormDraft(type)); setView('edit'); setError(''); markDirty(true); };
  const leaveEditor = () => { if (pendingMutation.current) return; markDirty(false); setConfirmDiscard(false); setDraftState(null); setView(active ? 'manage' : 'list'); };
  // Recovery from a lost save race: fetch the row as it stands now and
  // reopen it. The unsaved edits go, which is the honest outcome when
  // somebody else's version is already the live one.
  const reloadStale = async () => { if (pendingMutation.current) return; pendingMutation.current=true; setSaving(true); try { const latest=(await listOwnerForms()).find(item => item.id === staleFormID); if (!latest) { setError('This form has been deleted.'); setStaleFormID(null); return; } setForms(await listOwnerForms()); setDraftState(structuredClone(latest)); setActive(latest); setStaleFormID(null); setError(''); markDirty(false); setNotice('Reloaded the latest version of this form.'); } catch(err) { setError(err.message); } finally { pendingMutation.current=false; setSaving(false); } };
  const save = async () => { if (pendingMutation.current) return; const validation = validateFormDraft(draft); if (validation) { setError(validation); return; } pendingMutation.current=true; setSaving(true); setStaleFormID(null); try { const saved=await saveOwnerForm(draft); await load(); setActive(saved); setView('manage'); markDirty(false); setNotice('Form saved.'); } catch(err) { setError(err.message); setStaleFormID(err.code === FORM_CHANGED_ELSEWHERE ? draft.id : null); } finally { pendingMutation.current=false; setSaving(false); } };
  const duplicate = form => { const copy=structuredClone(form); delete copy.id; delete copy.created_at; delete copy.updated_at; copy.title=`${form.title} (Copy)`; copy.slug=slugifyFormTitle(copy.title); copy.is_active=false; copy.response_count=0; setDraftState(copy); setView('edit'); markDirty(true); };
  useEffect(() => {
    if (initialAction !== 'create' || handledIntent.current) return;
    handledIntent.current = true;
    setActive(null);
    setDraftState(createFormDraft('survey'));
    setView('edit');
    setError('');
    setDirty(true);
    onDirtyChange(true);
    onIntentHandled();
  }, [initialAction, onDirtyChange, onIntentHandled]); // Consume the URL intent once per mounted Forms workspace.
  const toggleLive = async form => { if (pendingMutation.current) return; pendingMutation.current=true; setSaving(true); setError(''); try { const saved=await saveOwnerForm({ ...form, is_active: !form.is_active }); setActive(saved); await load(); } catch(err){ setError(err.message); } finally { pendingMutation.current=false; setSaving(false); } };
  const filtered = forms.filter(form => (filter === 'all' || form.form_type === filter) && (!query || `${form.title} ${form.description}`.toLowerCase().includes(query.toLowerCase())));
  if (view === 'edit' && draft) return <><FormEditor draft={draft} setDraft={setDraft} forms={forms} onSave={save} saving={saving} error={error} onReloadStale={staleFormID ? reloadStale : null} onCancel={() => { if (!pendingMutation.current) { if (dirty) setConfirmDiscard(true); else leaveEditor(); } }} /><AdminConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} title="Discard unsaved form changes?" description="Your edits have not been saved and cannot be recovered." warning={undefined} cancelLabel="Keep editing" confirmLabel="Discard changes" busy={saving} onConfirm={leaveEditor} /></>;
  if (view === 'analytics' && active) return <Analytics form={active} onBack={() => setView('manage')} />;
  if (view === 'manage' && active) {
    const url=publicFormURL(active); return <fieldset disabled={saving} aria-busy={saving} className={`${shell} space-y-5`}><AdminPageHeader eyebrow={active.is_active ? 'Live form' : 'Paused form'} title={active.title} description={null}><button className={button} onClick={() => setView('list')}><ArrowLeft className="h-4 w-4" /> Forms</button><button className={button} onClick={() => edit(active)}><Pencil className="h-4 w-4" /> Edit</button><button className={primary} onClick={() => setView('analytics')}><BarChart3 className="h-4 w-4" /> Analytics</button></AdminPageHeader>
      {notice && <p role="status" className="border border-status-success-300/25 bg-status-success-300/10 p-3 text-sm text-status-success-100">{notice}</p>}{error && <p role="alert" className="text-status-warning-200">{error}</p>}
      <div className="forms-grid forms-grid-two"><section className={`${panel} p-5`}><h2 className="font-display text-2xl uppercase text-text-primary">Share form</h2><p className="mt-1 text-sm text-text-secondary">Public links work on mobile and desktop without an account.</p><div className="mt-4 flex"><input aria-label="Public form link" readOnly value={url} className={`${control} min-w-0 flex-1`} /><button className={`${button} px-3`} onClick={async()=>{setError('');setNotice('');try{await navigator.clipboard.writeText(url);setNotice('Link copied.');}catch(err){setError(err.message || 'The public link could not be copied.');}}} aria-label="Copy public link"><Link2 className="h-4 w-4" /></button></div><div className="mt-3 flex flex-wrap gap-2"><a href={url} target="_blank" rel="noopener noreferrer" className={button}><Eye className="h-4 w-4" /> Preview</a>{navigator.share && <button className={button} onClick={async()=>{setError('');setNotice('');try{await navigator.share({title:active.title,url});}catch(err){if(err.name !== 'AbortError')setError(err.message || 'The public link could not be shared.');}}}><ExternalLink className="h-4 w-4" /> Share</button>}</div></section>
      <section className={`${panel} p-5`}><h2 className="font-display text-2xl uppercase text-text-primary">Form controls</h2><div className="mt-4 grid gap-2"><button className={button} onClick={()=>toggleLive(active)}>{active.is_active?<><Pause className="h-4 w-4" /> Pause responses</>:<><Play className="h-4 w-4" /> Publish form</>}</button><button className={button} onClick={()=>duplicate(active)}><Copy className="h-4 w-4" /> Duplicate and edit</button><button className={`${button} text-status-danger-300`} onClick={()=>setConfirmArchive(active)}><Archive className="h-4 w-4" /> Archive form</button></div></section>
      <FormQRCode form={active} publicURL={url} onNotice={setNotice} /></div>
      <div className="forms-grid forms-grid-three">{[['Responses',active.response_count||0],['Fields',activeQuestions(active).length],['Type',FORM_TYPES.find(type=>type.value===active.form_type)?.label||'Custom']].map(([label,value])=><AdminStatCard key={label} label={label} value={value} />)}</div>
      <AdminConfirmDialog open={Boolean(confirmArchive)} onOpenChange={open => !open && setConfirmArchive(null)} title="Archive this form?" description="The public link will stop accepting responses. Existing response history is preserved." warning={undefined} cancelLabel="Keep form" confirmLabel="Archive form" busy={saving} onConfirm={async()=>{if(pendingMutation.current)return;pendingMutation.current=true;setSaving(true);setError('');try{await archiveOwnerForm(confirmArchive);setConfirmArchive(null);setActive(null);setView('list');await load();}catch(err){setError(err.message);setConfirmArchive(null);}finally{pendingMutation.current=false;setSaving(false);}}} />
    </fieldset>;
  }
  return <div className={shell}>
    <AdminPageHeader eyebrow="Engage and learn" title="Forms & surveys" description="Build branded forms, publish a link, review every response and spot trends from any device.">
      <AdminFormField label="New form type"><select aria-label="New form type" defaultValue="" onChange={event => { if(event.target.value) create(event.target.value); event.target.value=''; }}><option value="">+ New form…</option>{FORM_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></AdminFormField>
    </AdminPageHeader>
    <div className="forms-grid forms-stats">{[['Total forms',forms.length],['Live',forms.filter(item=>item.is_active).length],['Responses',forms.reduce((sum,item)=>sum+(item.response_count||0),0)],['Types used',new Set(forms.map(item=>item.form_type)).size]].map(([label,value]) => <AdminStatCard key={label} label={label} value={loading ? '—' : value} />)}</div>
    <AdminFilterBar queryKey="form-search" searchLabel="Search forms" filters={[{key:'form-type',label:'Form type',options:FORM_TYPES}]} onChange={values => {setQuery(values['form-search'] || '');setFilter(values['form-type'] || 'all');}} />
    {loading ? <FormCardsLoading />
      : error ? <div role="alert"><AdminEmptyState title="Unable to load forms" description={error} action={<button type="button" className={button} onClick={load}>Retry</button>} /></div>
      : filtered.length ? <div className="forms-grid forms-grid-two">{filtered.map(form => <button type="button" key={form.id} onClick={() => {setActive(form);setView('manage');setNotice('');setError('');}} className={`${panel} forms-card`}><div className="forms-contact"><span className="font-semibold text-text-primary">{form.title}</span><span><AdminBadge status={form.is_active ? 'active' : 'inactive'}>{form.is_active ? 'Live' : 'Paused'}</AdminBadge></span><span className="forms-secondary">{FORM_TYPES.find(type=>type.value===form.form_type)?.label} · {activeQuestions(form).length} fields · {form.response_count||0} responses</span></div></button>)}</div>
      : <Empty title={forms.length ? 'No matching forms' : 'No forms yet'} detail={forms.length ? 'Clear the search or type filter to see other forms.' : 'Create a survey, registration, application, feedback form or anything else Byron needs.'} />}
  </div>;
}

FormsSurveysManager.displayName = 'FormsSurveysManager';
