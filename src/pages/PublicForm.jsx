import React, { useEffect, useMemo, useRef, useState } from 'react';
import { resolveSemanticColor } from '@/lib/designTokens';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FileUp, LoaderCircle, Star } from 'lucide-react';
import { answerIsPresent, loadPublicForm, submitPublicForm } from '@/lib/xertForms';
import { buildPublicFormSteps } from '@/lib/formBranching';
import {
  formCompletionMarker, formPath, minorStatus, nextFormSlug, readFormCompletion,
  returnKeyAfterForm, returnPathAfterForm, writeFormCompletion,
} from '@/lib/formPrerequisites';
import { answerValidationMessage, firstInvalidAnswer } from '@/lib/formAnswerValidation';
import { ALREADY_PROVIDED_ANSWER, offersAlreadyProvided } from '@/lib/formAlreadyProvided';

const inputClass = 'xert-input';
const errorStyle = { color: 'var(--state-danger-text)', borderColor: 'var(--state-danger-text-35)', backgroundColor: 'var(--state-danger-text-8)' };
const optionIdle = 'border-xert-steel/20 bg-white/[0.03] text-xert-pale hover:border-xert-steel/50';
const optionChecked = 'border-xert-steel bg-xert-steel/15 text-white';

function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function formVideoEmbedURL(value) {
  const url = safeURL(value);
  if (!url) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const segments = url.pathname.split('/').filter(Boolean);
  let youtubeID = null;

  if (hostname === 'youtu.be' && segments.length === 1) {
    [youtubeID] = segments;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)) {
    if (url.pathname.replace(/\/+$/, '') === '/watch') youtubeID = url.searchParams.get('v');
    else if (segments.length === 2 && ['embed', 'shorts', 'live'].includes(segments[0])) [, youtubeID] = segments;
  } else if (hostname === 'www.youtube-nocookie.com'
    && segments.length === 2 && segments[0] === 'embed') {
    [, youtubeID] = segments;
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(youtubeID || '')) {
    return `https://www.youtube-nocookie.com/embed/${youtubeID}`;
  }

  let vimeoID = null;
  if (['vimeo.com', 'www.vimeo.com'].includes(hostname) && segments.length >= 1) {
    [vimeoID] = segments;
  } else if (hostname === 'player.vimeo.com'
    && segments.length === 2 && segments[0] === 'video') {
    [, vimeoID] = segments;
  }

  return /^\d{1,12}$/.test(vimeoID || '')
    ? `https://player.vimeo.com/video/${vimeoID}`
    : null;
}

function Media({ type, url, caption }) {
  const safe = safeURL(url);
  if (!type || !safe) return null;
  const embedURL = type === 'video' ? formVideoEmbedURL(safe) : null;
  return (
    <figure className="xert-card-flat mb-6 overflow-hidden">
      {type === 'image' && <img src={safe.toString()} alt={caption || ''} loading="lazy" decoding="async" className="max-h-[26rem] w-full object-contain" />}
      {embedURL && (
        <div className="aspect-video">
          <iframe title={caption || 'Form video'} src={embedURL} className="h-full w-full" allowFullScreen loading="lazy" referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      )}
      {(type === 'link' || (type === 'video' && !embedURL)) && (
        <a href={safe.toString()} target="_blank" rel="noopener noreferrer" className="flex min-h-14 items-center gap-3 p-4 text-xert-steel hover:bg-xert-steel/10 transition-colors">
          <ExternalLink className="h-5 w-5" /> <span>{caption || 'Open attached link'}</span>
        </a>
      )}
      {caption && type !== 'link' && (type !== 'video' || embedURL) && <figcaption className="px-4 py-3 text-center text-sm text-xert-pale/60">{caption}</figcaption>}
    </figure>
  );
}

// A legal agreement runs to thousands of words. Left inline it buries the
// Continue button under a page of scrolling, so anything this long reads
// inside its own scrollable panel.
const LONG_READ_CHARACTERS = 4000;

function InformationalBlocks({ items }) {
  if (!items.length) return null;
  const length = items.reduce((total, item) => total
    + String(item.content || item.question || '').length + String(item.description || '').length, 0);
  const blocks = (
    <>
      {items.map(item => {
        const title = String(item.content || item.question || '').trim();
        if (item.type === 'section_break') {
          return (
            <section key={item.id} className="border-b border-xert-steel/25 pb-3">
              <h2 className="font-display text-2xl uppercase tracking-wide text-white break-words">{title || 'Section'}</h2>
              {item.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-xert-pale/65">{item.description}</p>}
            </section>
          );
        }
        return (
          <section key={item.id} className="xert-card-flat p-4">
            {title && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-xert-offwhite">{title}</p>}
            {item.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-xert-pale/60">{item.description}</p>}
          </section>
        );
      })}
    </>
  );
  if (length <= LONG_READ_CHARACTERS) {
    return <div className="mb-8 space-y-4" aria-label="Form information">{blocks}</div>;
  }
  return (
    <div className="mb-8">
      <div tabIndex={0} role="region" aria-label="Form information"
        className="max-h-[70vh] space-y-4 overflow-y-auto overflow-x-hidden rounded-2xl border border-xert-steel/20 bg-black/20 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-xert-steel">
        {blocks}
      </div>
      <p className="mt-2 text-xs text-xert-pale/45">Scroll inside the panel to read it all. The buttons are below.</p>
    </div>
  );
}

function SignatureInput({ value, onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const point = event => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvasRef.current.width / rect.width, y: (event.clientY - rect.top) * canvasRef.current.height / rect.height };
  };
  const start = event => {
    drawing.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const p = point(event); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvasRef.current.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!drawing.current) return;
    const ctx = canvasRef.current.getContext('2d'); const p = point(event);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = resolveSemanticColor('signature.ink'); ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false; onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current; canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); onChange('');
  };
  return (
    <div>
      <canvas ref={canvasRef} width="720" height="220" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Signature pad" className="h-44 w-full touch-none rounded-xl border border-xert-steel/30 bg-white" />
      <div className="mt-2 flex items-center justify-between text-xs text-xert-pale/55"><span>Sign with your finger, mouse or Apple Pencil</span><button type="button" onClick={clear} className="min-h-11 rounded-full px-3 text-xert-steel hover:text-xert-pale transition-colors">Clear</button></div>
      {/* A signature is always dated. Recording it here saves asking for a
          date nobody should have to type, and it is the moment of signing. */}
      <p className="mt-2 text-xs text-xert-pale/55">
        Dated <time dateTime={new Date().toISOString().slice(0, 10)}>{new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</time>, recorded with your signature.
      </p>
      {value && <p className="text-xs text-status-success-300">Signature captured</p>}
    </div>
  );
}

// Wraps any text-type field that offers "Already provided". Ticking it hides
// the input rather than filling it, so an email field is never left holding
// words that are not an email, and unticking brings the input straight back.
function AnswerInput({ question, value, onChange }) {
  if (!offersAlreadyProvided(question)) return <FieldAnswerInput question={question} value={value} onChange={onChange} />;
  const ticked = value === ALREADY_PROVIDED_ANSWER;
  return (
    <div>
      {ticked
        ? <p className="rounded-xl border border-xert-steel/30 px-4 py-3 text-sm text-xert-pale/70">Marked as already provided.</p>
        : <FieldAnswerInput question={question} value={value} onChange={onChange} />}
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-xert-pale/85">
        <input type="checkbox" className="h-5 w-5 shrink-0 accent-xert-steel" checked={ticked} onChange={event => onChange(event.target.checked ? ALREADY_PROVIDED_ANSWER : '')} />
        Already provided
      </label>
    </div>
  );
}

function FieldAnswerInput({ question, value, onChange }) {
  const options = question.type === 'yes_no' ? ['Yes', 'No'] : question.options || [];
  if (question.type === 'long_text') return <textarea rows={6} className={inputClass} value={value || ''} placeholder={question.placeholder || ''} onChange={event => onChange(event.target.value)} />;
  if (['short_text', 'email', 'phone', 'url', 'number', 'date', 'time', 'datetime'].includes(question.type)) {
    const types = { email: 'email', phone: 'tel', url: 'url', number: 'number', date: 'date', time: 'time', datetime: 'datetime-local' };
    return <input className={inputClass} type={types[question.type] || 'text'} inputMode={question.type === 'number' ? 'decimal' : undefined} autoCapitalize={question.type === 'email' || question.type === 'url' ? 'none' : undefined} autoCorrect={question.type === 'email' || question.type === 'url' ? 'off' : undefined} value={value ?? ''} placeholder={question.placeholder || ''} onChange={event => onChange(question.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />;
  }
  if (question.type === 'dropdown') return <select className={inputClass} value={value || ''} onChange={event => onChange(event.target.value)}><option value="">Choose an option</option>{options.map(option => <option key={option}>{option}</option>)}</select>;
  if (question.type === 'multiple_choice') {
    const selected = Array.isArray(value) ? value : [];
    return <div role="group" aria-labelledby={`question-${question.id}`} className="grid gap-2 sm:grid-cols-2">{options.map(option => {
      const checked = selected.includes(option);
      return <button type="button" key={option} role="checkbox" aria-checked={checked} onClick={() => onChange(checked ? selected.filter(item => item !== option) : [...selected, option])} className={`min-h-14 rounded-xl border px-4 text-left transition-colors ${checked ? optionChecked : optionIdle}`}><span className="mr-3 inline-flex h-5 w-5 items-center justify-center rounded-md border border-current">{checked && <Check className="h-3 w-3" />}</span>{option}</button>;
    })}</div>;
  }
  if (['single_choice', 'yes_no'].includes(question.type)) {
    const compactConsent = question.type === 'single_choice' && options.length === 1;
    return <div role="radiogroup" aria-labelledby={`question-${question.id}`} className={`grid gap-2 ${compactConsent ? '' : 'sm:grid-cols-2'}`}>{options.map(option => {
      const checked = value === option;
      return <button type="button" role="radio" aria-checked={checked} key={option} onClick={() => onChange(option)} className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 text-left transition-colors ${checked ? optionChecked : optionIdle}`}><span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center border-2 rounded-full ${checked ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-pale/55 bg-transparent'}`}>{checked && <Check className="h-4 w-4" strokeWidth={3} />}</span><span className="min-w-0 flex-1">{option}</span></button>;
    })}</div>;
  }
  if (question.type === 'star_rating') return <div role="radiogroup" aria-labelledby={`question-${question.id}`} className="flex flex-wrap gap-2">{[1,2,3,4,5].map(star => <button type="button" role="radio" aria-checked={Number(value) === star} aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`} key={star} onClick={() => onChange(star)} className="min-h-12 min-w-12"><Star className={`h-9 w-9 ${star <= Number(value) ? 'fill-xert-steel text-xert-steel' : 'text-xert-steel/30'}`} /></button>)}</div>;
  if (['linear_scale', 'nps'].includes(question.type)) {
    const min = question.type === 'nps' ? 0 : Number(question.scale_min ?? 1); const max = question.type === 'nps' ? 10 : Number(question.scale_max ?? 10);
    return <div><div role="radiogroup" aria-labelledby={`question-${question.id}`} className="flex flex-wrap gap-2">{Array.from({ length: max - min + 1 }, (_, i) => min + i).map(number => <button type="button" role="radio" aria-checked={Number(value) === number} aria-label={`${number} of ${max}`} key={number} onClick={() => onChange(number)} className={`min-h-12 min-w-12 rounded-xl border transition-colors ${Number(value) === number ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-steel/25 bg-white/[0.03] text-xert-pale hover:border-xert-steel/50'}`}>{number}</button>)}</div><div className="mt-2 flex justify-between text-xs text-xert-pale/45"><span>{question.scale_min_label}</span><span>{question.scale_max_label}</span></div></div>;
  }
  if (question.type === 'address') {
    const current = value || {}; const update = (key, next) => onChange({ ...current, [key]: next });
    return <div className="grid gap-3 sm:grid-cols-2"><input className={`${inputClass} sm:col-span-2`} aria-label="Street address" autoComplete="street-address" placeholder="Street address" value={current.street || ''} onChange={event => update('street', event.target.value)} /><input className={inputClass} aria-label="Suburb" autoComplete="address-level2" placeholder="Suburb" value={current.suburb || ''} onChange={event => update('suburb', event.target.value)} /><input className={inputClass} aria-label="State" autoComplete="address-level1" placeholder="State" value={current.state || ''} onChange={event => update('state', event.target.value)} /><input className={inputClass} aria-label="Postcode" autoComplete="postal-code" inputMode="numeric" placeholder="Postcode" value={current.postcode || ''} onChange={event => update('postcode', event.target.value)} /><input className={inputClass} aria-label="Country" autoComplete="country-name" placeholder="Country" value={current.country || ''} onChange={event => update('country', event.target.value)} /></div>;
  }
  if (question.type === 'name_fields') {
    const current = value || {};
    return <div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} aria-label="First name" autoComplete="given-name" placeholder="First name" value={current.first || ''} onChange={event => onChange({ ...current, first: event.target.value })} /><input className={inputClass} aria-label="Last name" autoComplete="family-name" placeholder="Last name" value={current.last || ''} onChange={event => onChange({ ...current, last: event.target.value })} /></div>;
  }
  if (question.type === 'signature') return <SignatureInput value={value} onChange={onChange} />;
  if (question.type === 'file_upload') return <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-xert-steel/35 bg-white/[0.03] p-4 text-center text-xert-pale"><FileUp className="h-6 w-6 text-xert-steel" /><span>{value?.name || 'Choose a file'}</span><span className="text-xs text-xert-pale/45">The filename and file details are recorded; the file itself is not uploaded.</span><input type="file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; onChange(file ? { name: file.name.slice(0, 180), size: file.size, type: file.type.slice(0, 100) } : null); }} /></label>;
  return null;
}

// One question as a respondent sees it. The live form and the builder's
// preview both render through this, so the preview cannot drift from what
// people are actually shown. The preview sits inside the builder's own page,
// so it takes a lower heading level than the form's h1.
/** @param {{ question: any, value: any, onChange: (value: any) => void, audience?: string | null, Heading?: 'h1' | 'h3' }} props */
export function QuestionBody({ question, value, onChange, audience = null, Heading = 'h1' }) {
  return <>
    <Media type={question.media_type} url={question.media_url} caption={question.media_caption} />
    <Heading id={`question-${question.id}`} className="font-display text-3xl uppercase leading-tight tracking-wide text-white sm:text-4xl">{question.question}{question.required && <span className="ml-2 text-xert-steel">*</span>}</Heading>
    {question.minor_only && audience === 'minor' && (
      <p className="mt-3 rounded-xl border border-xert-steel/30 bg-xert-steel/10 p-3 text-sm text-xert-offwhite">
        The date of birth on the questionnaire makes this member under 18, so a parent or legal guardian must complete this.
      </p>
    )}
    {question.description && <p className="mt-3 text-xert-pale/60">{question.description}</p>}
    <div className="mt-7"><AnswerInput question={question} value={value} onChange={onChange} /></div>
  </>;
}

// The builder's preview: the live form's own card and renderer. It keeps its
// own answer so trying a question out saves nothing; the builder remounts it
// when the question type changes, since an answer of one type is meaningless
// to another.
export function QuestionPreview({ question }) {
  const [value, setValue] = useState(undefined);
  const layout = question.type === 'section_break' || question.type === 'statement';
  return (
    <div className="rounded-2xl bg-xert-navy p-3 text-xert-offwhite">
      <div className="xert-card p-5">
        {layout ? <InformationalBlocks items={[question]} /> : <QuestionBody question={question} value={value} onChange={setValue} Heading="h3" />}
      </div>
    </div>
  );
}

export default function PublicForm() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [form, setForm] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [step, setStep] = useState(0); const [answers, setAnswers] = useState({});
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false); const [submitted, setSubmitted] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  const [carried, setCarried] = useState(null);
  const startedAt = useRef(Date.now());
  // A different slug is a different form: nothing from the previous one may
  // survive, or a handover would carry stale answers into the next document.
  useEffect(() => {
    let active = true;
    setLoading(true); setForm(null); setError(''); setStep(0); setAnswers({});
    setName(''); setEmail(''); setPhone(''); setSubmitted(false); setHandingOver(false); setCarried(null);
    startedAt.current = Date.now();
    loadPublicForm(slug).then(data => {
      if (!active) return;
      setForm(data);
      document.title = data ? `${data.title} | XERT` : 'Form unavailable | XERT';
      // Carry across what they already typed on the form that led here.
      const details = data?.prerequisite_slug ? readFormCompletion(data.prerequisite_slug) : null;
      if (details) {
        setCarried(details);
        setName(details.name || ''); setEmail(details.email || ''); setPhone(details.phone || '');
        // A question can ask for something the previous form already recorded.
        // Seeding the answer saves typing it twice while leaving it editable.
        const seeded = Object.fromEntries((data.questions || [])
          .filter(item => item.prefill && details[item.prefill])
          .map(item => [item.id, details[item.prefill]]));
        if (Object.keys(seeded).length) setAnswers(seeded);
      }
    }).catch(err => active && setError(err.message)).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [slug]);
  // A prerequisite says what leads here, not what bars the door. Sharing the
  // agreement's own link used to bounce the reader to the questionnaire first,
  // so a link sent to somebody who only needed to sign the terms opened a
  // questionnaire instead. The questionnaire still hands over to the agreement
  // when it is finished; that is the direction this relationship is for.
  // Skip destinations are indexed against the complete builder sequence, so
  // layout blocks must stay in this calculation even though they do not hold
  // answers. Each statement/section is then displayed with the next question.
  // Some questions only apply to a member under 18. The date of birth given on
  // the prerequisite settles that, so an adult is never shown them and a minor
  // cannot skip them. Without a usable date of birth they stay askable and
  // optional rather than being silently dropped.
  // Age comes from the date of birth this form asks for, and otherwise from the
  // one given on the form that led here, so neither document asks it twice.
  const answeredBirthday = useMemo(() => {
    const birthday = (form?.questions || []).find(item => item.type === 'date' && /birth/i.test(String(item.question || '')));
    return birthday ? answers[birthday.id] : null;
  }, [answers, form]);
  const audience = useMemo(
    () => minorStatus({ date_of_birth: answeredBirthday || carried?.date_of_birth || '' }),
    [answeredBirthday, carried],
  );
  const formItems = useMemo(() => form?.questions || [], [form]);
  // Only ask for a parent or guardian once we actually know the member is
  // under 18. Treating "we have not asked yet" as a reason to show these put a
  // guardian question, captioned "asked because the member is under 18", in
  // front of every adult who opened the agreement on its own.
  const notApplicable = useMemo(
    () => (audience === 'minor' ? [] : formItems.filter(item => item.minor_only).map(item => item.id)),
    [audience, formItems],
  );
  const formFlow = useMemo(
    () => buildPublicFormSteps(formItems, answers, notApplicable),
    [answers, formItems, notApplicable],
  );
  const { skipped, steps } = formFlow;
  const currentStep = step > 0 ? steps[step - 1] : null;
  const question = currentStep?.question || null;
  const questionCount = steps.filter(item => item.question).length;
  const questionNumber = step > 0
    ? steps.slice(0, step).filter(item => item.question).length
    : 0;
  const introValid = (!form?.collect_name_required || name.trim()) && (!form?.collect_email_required || /^\S+@\S+\.\S+$/.test(email)) && (!form?.collect_phone_required || phone.trim());
  const mustAnswer = Boolean(question?.required || (question?.minor_only && audience === 'minor'));
  const currentValid = !mustAnswer || answerIsPresent(answers[question.id]);
  const next = async () => {
    setError('');
    if (step === 0 && !introValid) { setError('Complete the required contact details to continue.'); return; }
    if (question && !currentValid) {
      setError(question.minor_only
        ? 'A parent or guardian must complete this for a member under 18.'
        : 'This question is required.');
      return;
    }
    // Catch what the database would reject while the answer is still on screen.
    const answerProblem = question ? answerValidationMessage(question, answers[question.id]) : null;
    if (answerProblem) { setError(answerProblem); return; }
    if (step < steps.length) { setStep(value => value + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const kept = Object.fromEntries(Object.entries(answers).filter(([id]) => !skipped.has(id)));
    // A last sweep, so an answer edited earlier can never fail at the very end
    // with nothing to act on: send them back to the question that needs fixing.
    const offender = firstInvalidAnswer(steps.map(item => item.question).filter(Boolean), kept);
    if (offender) {
      const target = steps.findIndex(item => item.question?.id === offender.question.id);
      if (target >= 0) setStep(target + 1);
      setError(offender.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSubmitting(true);
    try {
      const responseID = await submitPublicForm({ slug, formUpdatedAt: form.updated_at, answers: kept, name, email, phone, elapsedSeconds: Math.round((Date.now() - startedAt.current) / 1000), sourceURL: window.location.href });
      writeFormCompletion(slug, formCompletionMarker(
        slug, formItems, kept, { name, email, phone }, responseID,
      ));
      // Either the form that sent them here, or the form that names this one as
      // its prerequisite: opening the questionnaire directly must still lead to
      // the agreement, and a questionnaire with nothing after it must not.
      const handoff = nextFormSlug(search) || form.follow_on_slug || null;
      if (handoff && handoff !== slug) { setHandingOver(true); navigate(formPath(handoff, null, returnKeyAfterForm(search)), { replace: true }); return; }
      // Someone sent here mid-way through paying goes back to finish paying.
      const returnPath = returnPathAfterForm(search);
      if (returnPath) { setHandingOver(true); navigate(returnPath, { replace: true }); return; }
      setSubmitted(true);
      if (safeURL(form.redirect_url)) window.setTimeout(() => window.location.assign(form.redirect_url), 1400);
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  };
  if (loading || handingOver) return <main className="min-h-screen bg-xert-navy grid place-items-center text-xert-pale" role="status"><LoaderCircle className="mr-3 inline h-6 w-6 animate-spin text-xert-steel" /> {handingOver ? 'Saved. Opening the next form…' : 'Loading form…'}</main>;
  if (!form) return <main className="min-h-screen bg-xert-navy grid place-items-center p-6 text-center"><div><img src="/assets/xert-logo-horizontal-light.png" alt="XERT" className="mx-auto mb-8 h-10" /><h1 className="font-display text-4xl text-white">Form unavailable</h1><p className="mt-3 text-xert-pale/60">This link may be paused, archived or incorrect.</p></div></main>;
  if (submitted) return <main className="min-h-screen bg-xert-navy xert-glow-top grid place-items-center p-6"><section className="xert-card w-full max-w-xl p-8 text-center"><span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-status-success-400/10 text-status-success-300"><Check /></span><h1 className="font-display text-4xl uppercase tracking-wide text-white">Response received</h1><p className="mt-4 text-xert-pale/70">{form.thank_you_message}</p></section></main>;
  const progress = steps.length ? Math.min(100, Math.max(0, step / steps.length * 100)) : 100;
  return (
    <main className="min-h-screen bg-xert-navy xert-glow-top px-4 py-6 text-xert-offwhite sm:px-6 sm:py-12">
      <section className="xert-card mx-auto w-full max-w-2xl overflow-hidden">
        <header className="border-b border-xert-steel/15 px-5 py-5 sm:px-8"><img src="/assets/xert-logo-horizontal-light.png" alt="XERT" className="h-8 w-auto" /></header>
        {form.show_progress_bar && step > 0 && <div className="h-1 bg-white/[0.06]" aria-label={`Form progress ${Math.round(progress)} percent`}><div className="h-full rounded-r-full bg-xert-steel transition-all" style={{ width: `${progress}%` }} /></div>}
        <div className="p-5 sm:p-8">
          {step === 0 ? <>
            <Media type={form.header_media_type} url={form.header_media_url} caption={form.header_media_caption} />
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-xert-steel">{FORM_LABELS[form.form_type] || 'XERT Form'}</p>
            <h1 className="font-display text-4xl uppercase tracking-wide text-white sm:text-5xl">{form.title}</h1>
            {form.description && <p className="mt-4 whitespace-pre-wrap text-xert-pale/70">{form.description}</p>}
            {(form.collect_name || form.collect_email || form.collect_phone) && <div className="mt-8 grid gap-4">
              {form.collect_name && <label><span className="xert-label">Name {form.collect_name_required && '*'}</span><input id="form-name" className={inputClass} autoComplete="name" autoCapitalize="words" value={name} onChange={event => setName(event.target.value)} /></label>}
              {form.collect_email && <label><span className="xert-label">Email {form.collect_email_required && '*'}</span><input id="form-email" type="email" className={inputClass} autoComplete="email" autoCapitalize="none" autoCorrect="off" value={email} onChange={event => setEmail(event.target.value)} /></label>}
              {form.collect_phone && <label><span className="xert-label">Phone {form.collect_phone_required && '*'}</span><input id="form-phone" type="tel" className={inputClass} autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} /></label>}
            </div>}
          </> : currentStep ? <>
            <InformationalBlocks items={currentStep.information} />
            {question ? <>
              <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-xert-steel">Question {questionNumber} of {questionCount}</p>
              <QuestionBody question={question} value={answers[question.id]} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} audience={audience} />
            </> : <><h1 className="font-display text-4xl uppercase text-white">Review and submit</h1><p className="mt-3 text-xert-pale/65">Confirm the information above, or go back before sending your response.</p></>}
          </> : <><h1 className="font-display text-4xl uppercase text-white">Ready to submit?</h1><p className="mt-3 text-xert-pale/65">Review your answers with Back, or send your response now.</p></>}
          {error && <p role="alert" className="mt-5 rounded-xl border p-3 text-sm" style={errorStyle}>{error}</p>}
          <div className="mt-8 flex gap-3">
            {step > 0 && <button type="button" onClick={() => { setError(''); setStep(value => Math.max(0, value - 1)); }} className="xert-btn-ghost inline-flex min-h-[52px] items-center gap-2 px-5 font-display text-sm uppercase tracking-wide"><ArrowLeft className="h-4 w-4" /> Back</button>}
            <button type="button" disabled={submitting} onClick={next} className="xert-btn-primary ml-auto inline-flex min-h-[52px] flex-1 items-center justify-center gap-2 px-6 font-display text-base uppercase tracking-wide sm:flex-none disabled:opacity-60">{submitting ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Sending</> : step >= steps.length ? <>Submit <Check className="h-4 w-4" /></> : <>Continue <ArrowRight className="h-4 w-4" /></>}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

const FORM_LABELS = Object.freeze({ contact: 'Contact form', registration: 'Registration', application: 'Application', feedback: 'Feedback', booking: 'Booking request', survey: 'Survey', quiz: 'Assessment', waiver: 'Consent', order: 'Request form', custom: 'XERT form' });
