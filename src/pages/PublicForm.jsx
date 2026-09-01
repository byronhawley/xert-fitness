import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FileUp, LoaderCircle, Star } from 'lucide-react';
import { answerIsPresent, loadPublicForm, submitPublicForm } from '@/lib/xertForms';
import { buildPublicFormSteps } from '@/lib/formBranching';

const inputClass = 'w-full min-h-12 bg-xert-deep border border-xert-steel/25 px-4 text-xert-offwhite placeholder:text-xert-pale/35 outline-none focus:border-xert-steel focus:ring-2 focus:ring-xert-steel/20 rounded-sm';

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
    <figure className="mb-6 overflow-hidden border border-xert-steel/20 bg-xert-deep">
      {type === 'image' && <img src={safe.toString()} alt={caption || ''} loading="lazy" decoding="async" className="max-h-[26rem] w-full object-contain" />}
      {embedURL && (
        <div className="aspect-video">
          <iframe title={caption || 'Form video'} src={embedURL} className="h-full w-full" allowFullScreen loading="lazy" referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      )}
      {(type === 'link' || (type === 'video' && !embedURL)) && (
        <a href={safe.toString()} target="_blank" rel="noopener noreferrer" className="flex min-h-14 items-center gap-3 p-4 text-xert-steel hover:bg-xert-steel/10">
          <ExternalLink className="h-5 w-5" /> <span>{caption || 'Open attached link'}</span>
        </a>
      )}
      {caption && type !== 'link' && (type !== 'video' || embedURL) && <figcaption className="px-4 py-3 text-center text-sm text-xert-pale/60">{caption}</figcaption>}
    </figure>
  );
}

function InformationalBlocks({ items }) {
  if (!items.length) return null;
  return (
    <div className="mb-8 space-y-4" aria-label="Form information">
      {items.map(item => {
        const title = String(item.content || item.question || '').trim();
        if (item.type === 'section_break') {
          return (
            <section key={item.id} className="border-b border-xert-steel/25 pb-3">
              <h2 className="font-display text-2xl uppercase tracking-wide text-white">{title || 'Section'}</h2>
              {item.description && <p className="mt-2 whitespace-pre-wrap text-sm text-xert-pale/65">{item.description}</p>}
            </section>
          );
        }
        return (
          <section key={item.id} className="border border-xert-steel/25 bg-xert-deep/60 p-4">
            {title && <p className="whitespace-pre-wrap text-sm leading-relaxed text-xert-offwhite">{title}</p>}
            {item.description && <p className="mt-2 whitespace-pre-wrap text-sm text-xert-pale/60">{item.description}</p>}
          </section>
        );
      })}
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
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#000000'; ctx.lineTo(p.x, p.y); ctx.stroke();
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
      <canvas ref={canvasRef} width="720" height="220" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Signature pad" className="h-44 w-full touch-none rounded-sm border border-xert-steel/30 bg-white" />
      <div className="mt-2 flex items-center justify-between text-xs text-xert-pale/55"><span>Sign with your finger, mouse or Apple Pencil</span><button type="button" onClick={clear} className="min-h-11 px-3 text-xert-steel">Clear</button></div>
      {value && <p className="text-xs text-emerald-300">Signature captured</p>}
    </div>
  );
}

function AnswerInput({ question, value, onChange }) {
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
      return <button type="button" key={option} role="checkbox" aria-checked={checked} onClick={() => onChange(checked ? selected.filter(item => item !== option) : [...selected, option])} className={`min-h-14 border px-4 text-left ${checked ? 'border-xert-steel bg-xert-steel/15 text-white' : 'border-xert-steel/20 bg-xert-deep text-xert-pale'}`}><span className="mr-3 inline-flex h-5 w-5 items-center justify-center border border-current">{checked && <Check className="h-3 w-3" />}</span>{option}</button>;
    })}</div>;
  }
  if (['single_choice', 'yes_no'].includes(question.type)) {
    const compactConsent = question.type === 'single_choice' && options.length === 1;
    return <div role="radiogroup" aria-labelledby={`question-${question.id}`} className={`grid gap-2 ${compactConsent ? '' : 'sm:grid-cols-2'}`}>{options.map(option => {
      const checked = value === option;
      return <button type="button" role="radio" aria-checked={checked} key={option} onClick={() => onChange(option)} className={`flex min-h-14 items-center gap-3 border px-4 text-left ${checked ? 'border-xert-steel bg-xert-steel/15 text-white' : 'border-xert-steel/20 bg-xert-deep text-xert-pale'}`}><span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center border-2 ${checked ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-pale/55 bg-transparent'}`}>{checked && <Check className="h-4 w-4" strokeWidth={3} />}</span><span className="min-w-0 flex-1">{option}</span></button>;
    })}</div>;
  }
  if (question.type === 'star_rating') return <div role="radiogroup" aria-labelledby={`question-${question.id}`} className="flex flex-wrap gap-2">{[1,2,3,4,5].map(star => <button type="button" role="radio" aria-checked={Number(value) === star} aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`} key={star} onClick={() => onChange(star)} className="min-h-12 min-w-12"><Star className={`h-9 w-9 ${star <= Number(value) ? 'fill-xert-steel text-xert-steel' : 'text-xert-steel/30'}`} /></button>)}</div>;
  if (['linear_scale', 'nps'].includes(question.type)) {
    const min = question.type === 'nps' ? 0 : Number(question.scale_min ?? 1); const max = question.type === 'nps' ? 10 : Number(question.scale_max ?? 10);
    return <div><div role="radiogroup" aria-labelledby={`question-${question.id}`} className="flex flex-wrap gap-2">{Array.from({ length: max - min + 1 }, (_, i) => min + i).map(number => <button type="button" role="radio" aria-checked={Number(value) === number} aria-label={`${number} of ${max}`} key={number} onClick={() => onChange(number)} className={`min-h-12 min-w-12 border ${Number(value) === number ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-steel/25 text-xert-pale'}`}>{number}</button>)}</div><div className="mt-2 flex justify-between text-xs text-xert-pale/45"><span>{question.scale_min_label}</span><span>{question.scale_max_label}</span></div></div>;
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
  if (question.type === 'file_upload') return <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-xert-steel/35 bg-xert-deep p-4 text-center text-xert-pale"><FileUp className="h-6 w-6 text-xert-steel" /><span>{value?.name || 'Choose a file'}</span><span className="text-xs text-xert-pale/45">The filename and file details are recorded; the file itself is not uploaded.</span><input type="file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; onChange(file ? { name: file.name.slice(0, 180), size: file.size, type: file.type.slice(0, 100) } : null); }} /></label>;
  return null;
}

export default function PublicForm() {
  const { slug } = useParams();
  const [form, setForm] = useState(null); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [step, setStep] = useState(0); const [answers, setAnswers] = useState({});
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false); const [submitted, setSubmitted] = useState(false);
  const startedAt = useRef(Date.now());
  useEffect(() => { let active = true; setLoading(true); loadPublicForm(slug).then(data => { if (active) { setForm(data); document.title = data ? `${data.title} | XERT` : 'Form unavailable | XERT'; } }).catch(err => active && setError(err.message)).finally(() => active && setLoading(false)); return () => { active = false; }; }, [slug]);
  // Skip destinations are indexed against the complete builder sequence, so
  // layout blocks must stay in this calculation even though they do not hold
  // answers. Each statement/section is then displayed with the next question.
  const formItems = useMemo(() => form?.questions || [], [form]);
  const formFlow = useMemo(() => buildPublicFormSteps(formItems, answers), [answers, formItems]);
  const { skipped, steps } = formFlow;
  const currentStep = step > 0 ? steps[step - 1] : null;
  const question = currentStep?.question || null;
  const questionCount = steps.filter(item => item.question).length;
  const questionNumber = step > 0
    ? steps.slice(0, step).filter(item => item.question).length
    : 0;
  const introValid = (!form?.collect_name_required || name.trim()) && (!form?.collect_email_required || /^\S+@\S+\.\S+$/.test(email)) && (!form?.collect_phone_required || phone.trim());
  const currentValid = !question?.required || answerIsPresent(answers[question.id]);
  const next = async () => {
    setError('');
    if (step === 0 && !introValid) { setError('Complete the required contact details to continue.'); return; }
    if (question && !currentValid) { setError('This question is required.'); return; }
    if (step < steps.length) { setStep(value => value + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    setSubmitting(true);
    try {
      await submitPublicForm({ slug, formUpdatedAt: form.updated_at, answers: Object.fromEntries(Object.entries(answers).filter(([id]) => !skipped.has(id))), name, email, phone, elapsedSeconds: Math.round((Date.now() - startedAt.current) / 1000), sourceURL: window.location.href });
      setSubmitted(true);
      if (safeURL(form.redirect_url)) window.setTimeout(() => window.location.assign(form.redirect_url), 1400);
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  };
  if (loading) return <main className="min-h-screen bg-xert-navy grid place-items-center text-xert-pale" role="status"><LoaderCircle className="mr-3 inline h-6 w-6 animate-spin text-xert-steel" /> Loading form…</main>;
  if (!form) return <main className="min-h-screen bg-xert-navy grid place-items-center p-6 text-center"><div><img src="/assets/xert-logo-horizontal-light.png" alt="XERT" className="mx-auto mb-8 h-10" /><h1 className="font-display text-4xl text-white">Form unavailable</h1><p className="mt-3 text-xert-pale/60">This link may be paused, archived or incorrect.</p></div></main>;
  if (submitted) return <main className="min-h-screen bg-xert-navy grid place-items-center p-6"><section className="w-full max-w-xl border border-xert-steel/25 bg-xert-ink p-8 text-center shadow-2xl"><span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-emerald-400/10 text-emerald-300"><Check /></span><h1 className="font-display text-4xl uppercase tracking-wide text-white">Response received</h1><p className="mt-4 text-xert-pale/70">{form.thank_you_message}</p></section></main>;
  const progress = steps.length ? Math.min(100, Math.max(0, step / steps.length * 100)) : 100;
  return (
    <main className="min-h-screen bg-xert-navy px-4 py-6 text-xert-offwhite sm:px-6 sm:py-12">
      <section className="mx-auto w-full max-w-2xl overflow-hidden border border-xert-steel/25 bg-xert-ink shadow-2xl">
        <header className="border-b border-xert-steel/20 px-5 py-5 sm:px-8"><img src="/assets/xert-logo-horizontal-light.png" alt="XERT" className="h-8 w-auto" /></header>
        {form.show_progress_bar && step > 0 && <div className="h-1 bg-xert-deep" aria-label={`Form progress ${Math.round(progress)} percent`}><div className="h-full bg-xert-steel transition-all" style={{ width: `${progress}%` }} /></div>}
        <div className="p-5 sm:p-8">
          {step === 0 ? <>
            <Media type={form.header_media_type} url={form.header_media_url} caption={form.header_media_caption} />
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.22em] text-xert-steel">{FORM_LABELS[form.form_type] || 'XERT Form'}</p>
            <h1 className="font-display text-4xl uppercase tracking-wide text-white sm:text-5xl">{form.title}</h1>
            {form.description && <p className="mt-4 whitespace-pre-wrap text-xert-pale/70">{form.description}</p>}
            {(form.collect_name || form.collect_email || form.collect_phone) && <div className="mt-8 grid gap-4">
              {form.collect_name && <label><span className="mb-1.5 block text-sm text-xert-pale">Name {form.collect_name_required && '*'}</span><input id="form-name" className={inputClass} autoComplete="name" autoCapitalize="words" value={name} onChange={event => setName(event.target.value)} /></label>}
              {form.collect_email && <label><span className="mb-1.5 block text-sm text-xert-pale">Email {form.collect_email_required && '*'}</span><input id="form-email" type="email" className={inputClass} autoComplete="email" autoCapitalize="none" autoCorrect="off" value={email} onChange={event => setEmail(event.target.value)} /></label>}
              {form.collect_phone && <label><span className="mb-1.5 block text-sm text-xert-pale">Phone {form.collect_phone_required && '*'}</span><input id="form-phone" type="tel" className={inputClass} autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} /></label>}
            </div>}
          </> : currentStep ? <>
            <InformationalBlocks items={currentStep.information} />
            {question ? <>
              <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-xert-steel">Question {questionNumber} of {questionCount}</p>
              <Media type={question.media_type} url={question.media_url} caption={question.media_caption} />
              <h1 id={`question-${question.id}`} className="font-display text-3xl uppercase leading-tight tracking-wide text-white sm:text-4xl">{question.question}{question.required && <span className="ml-2 text-xert-steel">*</span>}</h1>
              {question.description && <p className="mt-3 text-xert-pale/60">{question.description}</p>}
              <div className="mt-7"><AnswerInput question={question} value={answers[question.id]} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} /></div>
            </> : <><h1 className="font-display text-4xl uppercase text-white">Review and submit</h1><p className="mt-3 text-xert-pale/65">Confirm the information above, or go back before sending your response.</p></>}
          </> : <><h1 className="font-display text-4xl uppercase text-white">Ready to submit?</h1><p className="mt-3 text-xert-pale/65">Review your answers with Back, or send your response now.</p></>}
          {error && <p role="alert" className="mt-5 border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">{error}</p>}
          <div className="mt-8 flex gap-3">
            {step > 0 && <button type="button" onClick={() => { setError(''); setStep(value => Math.max(0, value - 1)); }} className="inline-flex min-h-12 items-center gap-2 border border-xert-steel/30 px-5 text-xert-pale"><ArrowLeft className="h-4 w-4" /> Back</button>}
            <button type="button" disabled={submitting} onClick={next} className="ml-auto inline-flex min-h-12 items-center justify-center gap-2 bg-xert-steel px-6 font-bold uppercase tracking-wider text-xert-navy disabled:opacity-60">{submitting ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Sending</> : step >= steps.length ? <>Submit <Check className="h-4 w-4" /></> : <>Continue <ArrowRight className="h-4 w-4" /></>}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

const FORM_LABELS = Object.freeze({ contact: 'Contact form', registration: 'Registration', application: 'Application', feedback: 'Feedback', booking: 'Booking request', survey: 'Survey', quiz: 'Assessment', waiver: 'Consent', order: 'Request form', custom: 'XERT form' });
