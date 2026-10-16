import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CreditCard, LoaderCircle } from 'lucide-react';
import PublicNav from '@/components/public/PublicNav';
import PublicFooter from '@/components/public/PublicFooter';
import { supabase } from '@/lib/supabase';
import {
  CASUAL_VISIT_ACTION, casualVisitValidationError, formatCasualVisitPrice,
  recallCasualVisitor, rememberCasualVisitor,
  TEN_SESSION_PACK_ACTION, TEN_SESSION_PACK_PRICE_CENTS,
  THREE_DAY_PASS_ACTION, THREE_DAY_PASS_PRICE_CENTS, THREE_MONTH_MEMBERSHIP_ACTION,
  THREE_MONTH_MEMBERSHIP_PRICE_CENTS, validQuestionnaireResponseId, visitorPassPricing,
} from '@/lib/casualVisit';
import { formPath, membershipPaperworkStatus, readFormCompletion } from '@/lib/formPrerequisites';

const CASUAL_PEQ_SLUG = 'peq-casual';
const MEMBER_PEQ_SLUG = 'peq';
const MEMBERSHIP_TERMS_SLUG = 'terms-and-conditions';

// A membership is not a drop-in, so it takes the member questionnaire, which
// hands off to the membership agreement before returning here to pay.
const MEMBERSHIP_COPY = Object.freeze({
  eyebrow: 'Three month membership',
  title: 'Three months, paid up front',
  lede: 'Full access to the class timetable for three months, paid in one go on your own phone',
  paidTitle: 'Check your payment receipt',
  paidBody: 'If your payment completed, Stripe will email your receipt. The XERT team has been told, and will set your membership up and be in touch.',
});

// Pay for a single visit on your own phone. The club never handles anyone's
// card: the visitor fills this in, and Stripe takes the payment with their
// name, email and phone already carried across.
//
// Every choice below falls through to the casual visit, so each pass needs its
// own branch everywhere: a missing 10 Session Pack branch would quietly sell
// somebody a single casual visit instead.
export default function CasualVisit({ threeDayPass = false, tenSessionPack = false, threeMonth = false }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [visitor, setVisitor] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [questionnaire, setQuestionnaire] = useState('');
  const passKind = threeMonth ? THREE_MONTH_MEMBERSHIP_ACTION : threeDayPass ? THREE_DAY_PASS_ACTION
    : tenSessionPack ? TEN_SESSION_PACK_ACTION : CASUAL_VISIT_ACTION;
  const [pricing, setPricing] = useState(() => (
    threeMonth ? { full: THREE_MONTH_MEMBERSHIP_PRICE_CENTS, charge: THREE_MONTH_MEMBERSHIP_PRICE_CENTS, discounted: false }
      : threeDayPass ? { full: THREE_DAY_PASS_PRICE_CENTS, charge: THREE_DAY_PASS_PRICE_CENTS, discounted: false }
        : tenSessionPack ? { full: TEN_SESSION_PACK_PRICE_CENTS, charge: TEN_SESSION_PACK_PRICE_CENTS, discounted: false }
          : null
  ));
  const priceCents = pricing?.charge ?? null;
  // A member who signed when they joined should not sign again to pay. The
  // server checks whether they really did and tells staff either way.
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [questionnaireResponseId, setQuestionnaireResponseId] = useState('');
  const [membershipQuestionnaire, setMembershipQuestionnaire] = useState(null);
  const [membershipAgreement, setMembershipAgreement] = useState(null);
  const [paperworkRecoveryPath, setPaperworkRecoveryPath] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const paid = params.get('paid') === '1';
  const cancelled = params.get('cancelled') === '1';

  // Coming back from the questionnaire, or from a half-finished attempt: their
  // details are waiting, and the questionnaire answer is already known.
  useEffect(() => {
    const completed = readFormCompletion(threeMonth ? MEMBER_PEQ_SLUG : CASUAL_PEQ_SLUG);
    const agreement = threeMonth ? readFormCompletion(MEMBERSHIP_TERMS_SLUG) : null;
    const remembered = recallCasualVisitor();
    const carried = { ...(remembered || {}) };
    if (completed) {
      const [first, ...rest] = String(completed.name || '').trim().split(' ');
      if (first) carried.first_name = first;
      if (rest.length) carried.last_name = rest.join(' ');
      if (completed.email) carried.email = completed.email;
      if (completed.phone) carried.phone = completed.phone;
    }
    setVisitor(current => ({
      first_name: carried.first_name || current.first_name,
      last_name: carried.last_name || current.last_name,
      email: carried.email || current.email,
      phone: carried.phone || current.phone,
    }));
    if (completed) setQuestionnaire('done');
    if (completed?.response_id) setQuestionnaireResponseId(completed.response_id);
    setMembershipQuestionnaire(threeMonth ? completed : null);
    setMembershipAgreement(agreement);
  }, [threeMonth]);

  useEffect(() => {
    document.title = threeMonth ? 'Three month membership | XERT Fitness'
      : threeDayPass ? 'Three Day Pass | XERT Fitness'
        : tenSessionPack ? '10 Session Pack | XERT Fitness'
          : 'Casual visit | XERT Fitness';
    let active = true;
    // PostgREST's builder is a thenable, not a Promise, so it has no .catch.
    // The price shown here is a courtesy — the server reads it again before
    // charging anyone — so a failure just leaves the default in place.
    void (async () => {
      try {
        const { data } = await supabase.from('admin_settings').select('*').limit(1).maybeSingle();
        if (active && data) setPricing(visitorPassPricing(passKind, data));
      } catch {
        // Leave the default price showing.
      }
    })();
    return () => { active = false; };
  }, [passKind, threeDayPass, tenSessionPack, threeMonth]);

  const update = (field, value) => setVisitor(current => ({ ...current, [field]: value }));
  const validation = casualVisitValidationError(visitor);
  // Saying "I have already completed it" is an answer, not a detour. A repeat
  // visitor signed weeks ago on a browser that has forgotten the response id,
  // so requiring one sent them back through the same form every visit. The
  // server checks the claim against the club's records instead.
  const threeDayAlreadySigned = threeDayPass && questionnaire === 'done'
    && !validQuestionnaireResponseId(questionnaireResponseId);
  const needsThreeDayQuestionnaire = threeDayPass && questionnaire !== 'done';
  // The 10 Session Pack is screened exactly like the Three Day Pass.
  const tenPackAlreadySigned = tenSessionPack && questionnaire === 'done'
    && !validQuestionnaireResponseId(questionnaireResponseId);
  const needsTenPackQuestionnaire = tenSessionPack && questionnaire !== 'done';
  const membershipPaperwork = membershipPaperworkStatus(
    visitor, membershipQuestionnaire, membershipAgreement,
  );
  // Signing here means signing on this device now; saying you already signed
  // sends nothing to verify, so the server looks the records up instead.
  const needsMembershipPaperwork = threeMonth && !alreadySigned && Boolean(membershipPaperwork.nextPath);

  const pay = async event => {
    event.preventDefault();
    setError('');
    setPaperworkRecoveryPath('');
    if (validation) { setError(validation); return; }
    if (!threeMonth && !questionnaire) { setError('Tell us whether you have completed the pre-exercise questionnaire.'); return; }
    if (threeMonth && !alreadySigned && !questionnaire) {
      setError('Tell us whether you have already signed the questionnaire and membership agreement.');
      return;
    }
    if (needsMembershipPaperwork) {
      rememberCasualVisitor(visitor);
      navigate(membershipPaperwork.nextPath);
      return;
    }
    if (needsThreeDayQuestionnaire) {
      rememberCasualVisitor(visitor);
      navigate(`/forms/${CASUAL_PEQ_SLUG}?return=3daypass`);
      return;
    }
    if (needsTenPackQuestionnaire) {
      rememberCasualVisitor(visitor);
      navigate(`/forms/${CASUAL_PEQ_SLUG}?return=10pack`);
      return;
    }
    // Nobody trains without being screened, so the questionnaire comes before
    // the payment rather than being an afterthought on the receipt page.
    if (!threeMonth && !threeDayPass && !tenSessionPack && questionnaire === 'not-done') {
      rememberCasualVisitor(visitor);
      navigate(`/forms/${CASUAL_PEQ_SLUG}?return=casual`);
      return;
    }
    setSending(true);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(threeMonth
          ? {
            action: THREE_MONTH_MEMBERSHIP_ACTION, ...visitor,
            already_signed: alreadySigned,
            ...(alreadySigned ? {} : {
              questionnaire_response_id: membershipPaperwork.questionnaireResponseId,
              agreement_response_id: membershipPaperwork.agreementResponseId,
            }),
          }
          : threeDayPass
            ? {
              action: THREE_DAY_PASS_ACTION, ...visitor,
              ...(threeDayAlreadySigned
                ? { already_signed: true }
                : { questionnaire_response_id: questionnaireResponseId }),
            }
            : tenSessionPack
              ? {
                action: TEN_SESSION_PACK_ACTION, ...visitor,
                ...(tenPackAlreadySigned
                  ? { already_signed: true }
                  : { questionnaire_response_id: questionnaireResponseId }),
              }
              : { action: CASUAL_VISIT_ACTION, ...visitor }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.url) {
        if (threeMonth && !alreadySigned && response.status === 400) {
          setMembershipQuestionnaire(null);
          setMembershipAgreement(null);
          setPaperworkRecoveryPath(formPath(MEMBER_PEQ_SLUG, null, '3months'));
        }
        throw new Error(body.error || 'The payment page could not be opened. Please try again.');
      }
      window.location.assign(body.url);
    } catch (paymentError) {
      setError(paymentError.message);
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-xert-navy">
      <PublicNav />
      <main id="main" className="relative flex-1 px-6 py-24 sm:py-28">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-96 pointer-events-none xert-glow-top" />
        <div className="relative mx-auto w-full max-w-lg">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-px w-6 bg-xert-steel" aria-hidden="true" />
            <span className="font-body text-xs uppercase tracking-[0.2em] text-xert-steel">{threeMonth ? MEMBERSHIP_COPY.eyebrow : threeDayPass ? 'Three Day Pass' : tenSessionPack ? '10 Session Pack' : 'Casual visit'}</span>
          </div>

          {paid ? (
            <div className="xert-card p-6 sm:p-8">
              <CheckCircle2 className="mb-4 h-9 w-9 text-status-success-300" aria-hidden="true" />
              <h1 className="font-display text-4xl uppercase leading-tight text-xert-offwhite">{threeMonth ? MEMBERSHIP_COPY.paidTitle : threeDayPass || tenSessionPack ? 'Check your payment receipt' : 'Payment received'}</h1>
              <p className="mt-4 font-body text-sm leading-relaxed text-xert-pale/75">
                {threeMonth ? MEMBERSHIP_COPY.paidBody : threeDayPass
                  ? 'If your payment completed, Stripe will email your Three Day Pass receipt. Show it to the XERT team before training; the team will arrange your visits.'
                  : tenSessionPack
                    ? 'If your payment completed, Stripe will email your 10 Session Pack receipt. Show it to the XERT team before training; the team will arrange your sessions.'
                    : 'Thanks — your receipt is on its way by email, and the team has been told you are here. If you have not filled in the pre-exercise questionnaire yet, do that before you train.'}
              </p>
              {!threeMonth && <Link to="/forms/peq-casual" className="mt-6 inline-flex min-h-12 items-center justify-center bg-xert-steel px-5 font-display text-sm uppercase tracking-wide text-xert-navy transition-colors hover:bg-xert-pale">
                Fill in the questionnaire
              </Link>}
            </div>
          ) : (
            <>
              <h1 className="font-display text-[clamp(2.25rem,7vw,3.25rem)] uppercase leading-tight text-xert-offwhite">
                {threeMonth ? MEMBERSHIP_COPY.title : threeDayPass ? 'Get your Three Day Pass' : tenSessionPack ? 'Get your 10 Session Pack' : <>Pay for today&apos;s visit</>}
              </h1>
              <p className="mt-4 max-w-prose font-body text-sm leading-relaxed text-xert-pale/75">
                {threeMonth ? MEMBERSHIP_COPY.lede : threeDayPass
                  ? 'Three Day Pass — show your receipt to the XERT team. Enter your details and pay on your own phone, no account needed'
                  : tenSessionPack
                    ? '10 Session Pack — show your receipt to the XERT team. Enter your details and pay on your own phone, no account needed'
                    : 'One visit, one class, no membership. Enter your details and pay on your own phone'}
                {priceCents ? <> — {pricing?.discounted && (
                  <s className="text-xert-pale/40">{formatCasualVisitPrice(pricing.full)}</s>
                )} <strong className="text-xert-offwhite">{formatCasualVisitPrice(priceCents)}</strong>
                {pricing?.discounted && <span className="text-xert-steel"> (discount on now)</span>}</> : null}.
              </p>

              {cancelled && (
                <p role="status" className="mt-6 border border-status-warning-300/30 bg-status-warning-300/10 p-3 font-body text-sm text-status-warning-100">
                  That payment was cancelled. Nothing has been charged — you can try again below.
                </p>
              )}

              <form onSubmit={pay} className="mt-8 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="xert-label">First name</span>
                    <input required autoComplete="given-name" className="xert-input mt-1" value={visitor.first_name}
                      onChange={event => update('first_name', event.target.value)} />
                  </label>
                  <label className="block">
                    <span className="xert-label">Last name</span>
                    <input required autoComplete="family-name" className="xert-input mt-1" value={visitor.last_name}
                      onChange={event => update('last_name', event.target.value)} />
                  </label>
                </div>
                <label className="block">
                  <span className="xert-label">Email</span>
                  <input required type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off"
                    className="xert-input mt-1" value={visitor.email} onChange={event => update('email', event.target.value)} />
                  <span className="mt-1 block font-body text-xs text-xert-pale/45">Your receipt goes here.</span>
                </label>
                <label className="block">
                  <span className="xert-label">Phone</span>
                  <input required type="tel" autoComplete="tel" inputMode="tel" className="xert-input mt-1"
                    value={visitor.phone} onChange={event => update('phone', event.target.value)} placeholder="0400 000 000" />
                </label>

                {threeMonth ? (
                  <fieldset className="min-w-0 border border-xert-steel/20 p-4">
                    <legend className="px-2 font-body text-xs uppercase tracking-wider text-xert-pale/60">Questionnaire &amp; membership agreement</legend>
                    <p className="mb-3 font-body text-xs leading-relaxed text-xert-pale/60">
                      Everyone training at XERT signs the pre-exercise questionnaire and the membership terms and conditions. If you signed them when you joined, say so and we will find them.
                    </p>
                    <div className="space-y-2" role="radiogroup" aria-label="Questionnaire and membership agreement">
                      {[
                        ['signed', 'I have already signed both'],
                        ['not-done', 'I need to sign them now'],
                      ].map(([value, label]) => {
                        const chosen = value === 'signed' ? alreadySigned : questionnaire === 'not-done' && !alreadySigned;
                        return (
                          <label key={value} className={`flex min-h-12 cursor-pointer items-center gap-3 border p-3 transition-colors ${chosen ? 'border-xert-steel bg-xert-steel/10' : 'border-xert-steel/20 hover:border-xert-steel/50'}`}>
                            <input type="radio" name="membership-paperwork" value={value} checked={chosen}
                              onChange={() => {
                                setAlreadySigned(value === 'signed');
                                setQuestionnaire(value === 'signed' ? 'done' : 'not-done');
                                if (value === 'not-done') {
                                  setMembershipQuestionnaire(null);
                                  setMembershipAgreement(null);
                                }
                                setPaperworkRecoveryPath('');
                                setError('');
                              }} className="peer sr-only" />
                            <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center border-2 ${chosen ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-steel/40'} peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-xert-offwhite`}>
                              {chosen && <span className="text-xs">&#10003;</span>}
                            </span>
                            <span className="font-body text-sm text-xert-offwhite">{label}</span>
                          </label>
                        );
                      })}
                    </div>
                    {alreadySigned && (
                      <p className="mt-3 font-body text-xs leading-relaxed text-xert-pale/60">
                        We will look for them under the email above. If we cannot find them the payment still goes through, and the team will check with you before your first session.
                      </p>
                    )}
                    {needsMembershipPaperwork && questionnaire === 'not-done' && (
                      <p className="mt-3 font-body text-xs leading-relaxed text-xert-pale/60">
                        The next button opens the questionnaire, then the agreement. It takes a few minutes, and you come straight back here to pay.
                      </p>
                    )}
                  </fieldset>
                ) : (
                <fieldset className="min-w-0 border border-xert-steel/20 p-4">
                  <legend className="px-2 font-body text-xs uppercase tracking-wider text-xert-pale/60">Pre-exercise questionnaire</legend>
                  {(threeDayPass || tenSessionPack) && <p className="mb-3 font-body text-xs leading-relaxed text-xert-pale/60">
                    Signed it on an earlier visit? Say so below and pay — we check our records against your email. Otherwise the next button opens it, and your details carry back here afterwards.
                  </p>}
                  <div className="space-y-2" role="radiogroup" aria-label="Pre-exercise questionnaire">
                    {[
                      ['done', 'I have already completed the pre-exercise questionnaire'],
                      ['not-done', 'I have not completed it yet'],
                    ].map(([value, label]) => (
                      <label key={value} className={`flex min-h-12 cursor-pointer items-center gap-3 border p-3 transition-colors ${questionnaire === value ? 'border-xert-steel bg-xert-steel/10' : 'border-xert-steel/20 hover:border-xert-steel/50'}`}>
                        <input type="radio" name="questionnaire" value={value} checked={questionnaire === value}
                          onChange={() => { setQuestionnaire(value); setError(''); }} className="peer sr-only" />
                        <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center border-2 ${questionnaire === value ? 'border-xert-steel bg-xert-steel text-xert-navy' : 'border-xert-steel/40'} peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-xert-offwhite`}>
                          {questionnaire === value && <span className="text-xs">&#10003;</span>}
                        </span>
                        <span className="font-body text-sm text-xert-offwhite">{label}</span>
                      </label>
                    ))}
                  </div>
                  {questionnaire === 'not-done' && (
                    <p className="mt-3 font-body text-xs leading-relaxed text-xert-pale/60">
                      No problem — the next button opens it. It takes a couple of minutes, and you come straight back here to pay.
                    </p>
                  )}
                </fieldset>
                )}

                {error && <div role="alert" className="border border-status-danger-300/30 bg-status-danger-300/10 p-3 font-body text-sm text-status-danger-100">
                  <p>{error}</p>
                  {paperworkRecoveryPath && <Link to={paperworkRecoveryPath}
                    onClick={() => rememberCasualVisitor(visitor)} className="mt-2 inline-block font-semibold underline">
                    Re-complete the questionnaire and agreement
                  </Link>}
                </div>}

                <button type="submit" disabled={sending}
                  className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 bg-xert-steel px-5 font-display text-sm uppercase tracking-wide text-xert-navy transition-colors hover:bg-xert-pale disabled:opacity-50">
                  {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                  {sending ? 'Opening secure payment…'
                    : needsMembershipPaperwork ? 'Sign the questionnaire and agreement first'
                    : (!threeMonth && questionnaire === 'not-done') || needsThreeDayQuestionnaire || needsTenPackQuestionnaire ? 'Fill in the questionnaire first'
                    : priceCents ? `Pay ${formatCasualVisitPrice(priceCents)}` : 'Continue to payment'}
                </button>
                <p className="font-body text-xs leading-relaxed text-xert-pale/45">
                  Payment is taken by Stripe on their secure page. XERT never sees or stores your card details.
                  {threeMonth ? <> Your membership starts once the XERT team sets it up, and they will be in touch.</> : <>
                  {' '}New here? Please also complete the <Link to={threeDayPass ? '/forms/peq-casual?return=3daypass' : tenSessionPack ? '/forms/peq-casual?return=10pack' : '/forms/peq-casual'}
                    onClick={threeDayPass || tenSessionPack ? () => { rememberCasualVisitor(visitor); } : undefined}
                    className="text-xert-steel underline">pre-exercise questionnaire</Link> before you train.</>}
                </p>
              </form>
            </>
          )}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
