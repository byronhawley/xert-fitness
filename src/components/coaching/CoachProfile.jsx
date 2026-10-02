import React, { useCallback, useEffect, useState } from 'react';
import { staffFiles } from '@/lib/staffFiles';
import { Banner, BUTTON, dateName, GHOST, INPUT, LABEL, Pill, Sheet } from './coachingUi';

/** @type {Array<[string, string, string, number]>} */
const PROFILE_FIELDS = [
  ['name', 'Name on the Coaches page', 'input', 80],
  ['role', 'Role or title', 'input', 80],
  ['bio', 'About you', 'textarea', 2000],
  ['experience', 'Experience and qualifications', 'textarea', 1000],
  ['currently_training_for', 'Currently training for', 'input', 200],
  ['social_url', 'Instagram or website link', 'input', 300],
];
const PROFILE_STATUS = {
  draft: ['Draft — not sent yet', 'neutral'],
  submitted: ['Waiting for the manager', 'info'],
  approved: ['Approved', 'success'],
  rejected: ['Sent back by the manager', 'warning'],
};
export const CERTIFICATE_KINDS = [
  ['first_aid', 'First aid'], ['cpr', 'CPR'], ['coaching', 'Coaching qualification'], ['working_with_children', 'Working with children'], ['other', 'Other'],
];
const KIND_LABEL = Object.fromEntries(CERTIFICATE_KINDS);
const CERT_STATE = { expired: ['Expired', 'danger'], expiring: ['Expires soon', 'warning'], current: ['Current', 'success'], no_expiry: ['No expiry', 'neutral'] };
const EMPTY_CERT = { id: null, kind: 'first_aid', title: '', number: '', issued_on: '', expires_on: '', file_path: '' };

function useFiles(injected) {
  const [files, setFiles] = useState(injected);
  useEffect(() => { if (!injected) staffFiles().then(setFiles).catch(() => setFiles(null)); }, [injected]);
  return files;
}

function ProfileSection({ client, files, uid, notify }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await client.myProfile();
      setData(result);
      const source = result.draft || result.public || {};
      setForm(Object.fromEntries([...PROFILE_FIELDS.map(([key]) => [key, source[key] || '']), ['photo_url', source.photo_url || '']]));
      setError(null);
    } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);

  const save = async submit => {
    setBusy(true);
    try {
      const result = await client.saveProfile(form, submit, data?.draft?.version ?? null);
      setData(result);
      notify(submit ? 'Sent to the manager for approval.' : 'Draft saved. It isn’t on the website until the manager approves it.');
    } catch (failure) {
      notify(failure.message, 'error');
      if (failure.code === 'STALE_VERSION') await load();
    } finally { setBusy(false); }
  };
  const upload = async file => {
    if (!file || !files) return;
    setBusy(true);
    try { const url = await files.uploadProfilePhoto(uid, file); setForm(current => ({ ...current, photo_url: url })); notify('Photo uploaded. Save or send your profile to keep it.'); }
    catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };

  if (error) return <Banner tone="danger" title="Couldn’t load your profile" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  if (!form) return <p className="font-body text-sm text-xert-pale/60" role="status">Loading your profile…</p>;
  const status = data?.draft?.status;
  return (
    <section aria-labelledby="coach-profile-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="coach-profile-heading" className="font-display text-2xl uppercase text-xert-offwhite">Coach profile</h2>
        {status && <Pill tone={PROFILE_STATUS[status][1]}>{PROFILE_STATUS[status][0]}</Pill>}
      </div>
      <p className="font-body text-sm text-xert-pale/70">This is what members see on the Coaches page. The manager approves changes before they go live.</p>
      {status === 'rejected' && data.draft.review_note && <Banner tone="warning" title="Note from the manager">{data.draft.review_note}</Banner>}
      {data?.public && data.public.published === false && <Banner tone="info" title="Your profile is hidden on the website">The manager can show it on the Coaches page.</Banner>}
      <div className="coaching-card space-y-3">
        <div className="flex items-center gap-3">
          <div className="coaching-photo" aria-hidden="true">{form.photo_url ? <img src={form.photo_url} alt="" /> : <span>No photo</span>}</div>
          <div className="space-y-1">
            <label className={GHOST} htmlFor="coach-photo-upload">{form.photo_url ? 'Replace photo' : 'Upload photo'}</label>
            <input id="coach-photo-upload" type="file" accept="image/*" className="sr-only" disabled={busy || !files} onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} />
            {form.photo_url && <button type="button" className={GHOST} onClick={() => setForm(current => ({ ...current, photo_url: '' }))}>Remove photo</button>}
            <p className="font-body text-xs text-xert-pale/50">JPG or PNG under 5 MB. Portrait works best.</p>
          </div>
        </div>
        {PROFILE_FIELDS.map(([key, label, kind, max]) => (
          <div key={key}>
            <label htmlFor={`coach-profile-${key}`} className={LABEL}>{label}</label>
            {kind === 'textarea'
              ? <textarea id={`coach-profile-${key}`} className={`${INPUT} py-2`} rows={4} maxLength={max} value={form[key]} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />
              : <input id={`coach-profile-${key}`} className={INPUT} maxLength={max} value={form[key]} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} />}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BUTTON} disabled={busy || !form.name.trim()} onClick={() => save(true)}>Send for approval</button>
          <button type="button" className={GHOST} disabled={busy} onClick={() => save(false)}>Save draft</button>
        </div>
      </div>
    </section>
  );
}

function CertificatesSection({ client, files, uid, notify }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await client.myCertificates()); setError(null); } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try { await client.saveCertificate(editing); setEditing(null); notify('Certificate saved.'); await load(); }
    catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };
  const remove = async item => {
    setBusy(true);
    try {
      const removed = await client.removeCertificate(item.id);
      if (removed?.file_path && files) await files.removeCertificateFile(removed.file_path).catch(() => {});
      notify('Certificate removed.'); await load();
    } catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };
  const attach = async file => {
    if (!file || !files) return;
    setBusy(true);
    try { const path = await files.uploadCertificateFile(uid, file); setEditing(current => ({ ...current, file_path: path })); }
    catch (failure) { notify(failure.message, 'error'); } finally { setBusy(false); }
  };
  const open = async path => {
    try { window.open(await files.certificateFileUrl(path), '_blank', 'noopener'); } catch (failure) { notify(failure.message, 'error'); }
  };

  return (
    <section aria-labelledby="coach-certificates-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="coach-certificates-heading" className="font-display text-2xl uppercase text-xert-offwhite">Certificates</h2>
        <button type="button" className={GHOST} onClick={() => setEditing({ ...EMPTY_CERT })}>Add certificate</button>
      </div>
      <p className="font-body text-sm text-xert-pale/70">First aid, CPR and the like. Only you and the managers can see these. You’ll get a notice 60, 30 and 7 days before one expires.</p>
      {error && <Banner tone="danger" title="Couldn’t load certificates" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>}
      {!error && !items && <p className="font-body text-sm text-xert-pale/60" role="status">Loading…</p>}
      {items?.length === 0 && <div className="coaching-card"><p className="font-body text-sm text-xert-pale/70">No certificates yet. Add your first aid and CPR so the manager knows they’re current.</p></div>}
      <ul className="space-y-2">
        {items?.map(item => (
          <li key={item.id} className="coaching-card space-y-1" data-changed={item.state === 'expired' || item.state === 'expiring'}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{item.title || KIND_LABEL[item.kind]}{item.title ? <span className="text-xert-pale/60 font-normal"> · {KIND_LABEL[item.kind]}</span> : null}</p>
              <Pill tone={CERT_STATE[item.state][1]}>{CERT_STATE[item.state][0]}</Pill>
            </div>
            <p className="font-body text-xs text-xert-pale/65">
              {item.expires_on ? `Expires ${dateName(item.expires_on)} ${item.expires_on.slice(0, 4)}` : 'No expiry date'}{item.number ? ` · No. ${item.number}` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {item.file_path && files && <button type="button" className={GHOST} onClick={() => open(item.file_path)}>View file</button>}
              <button type="button" className={GHOST} onClick={() => setEditing({ ...EMPTY_CERT, ...item, title: item.title || '', number: item.number || '', issued_on: item.issued_on || '', expires_on: item.expires_on || '', file_path: item.file_path || '' })}>Edit</button>
              <button type="button" className={GHOST} disabled={busy} onClick={() => remove(item)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <Sheet open={Boolean(editing)} title={editing?.id ? 'Edit certificate' : 'Add certificate'} onClose={() => setEditing(null)}
        footer={<><button type="button" className={BUTTON} disabled={busy} onClick={save}>Save certificate</button><button type="button" className={GHOST} onClick={() => setEditing(null)}>Cancel</button></>}>
        {editing && <>
          <div>
            <label htmlFor="cert-kind" className={LABEL}>Type</label>
            <select id="cert-kind" className={INPUT} value={editing.kind} onChange={event => setEditing(current => ({ ...current, kind: event.target.value }))}>
              {CERTIFICATE_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div><label htmlFor="cert-title" className={LABEL}>Name (optional)</label><input id="cert-title" className={INPUT} maxLength={120} placeholder="e.g. HLTAID011 Provide First Aid" value={editing.title} onChange={event => setEditing(current => ({ ...current, title: event.target.value }))} /></div>
          <div><label htmlFor="cert-number" className={LABEL}>Certificate number (optional)</label><input id="cert-number" className={INPUT} maxLength={80} value={editing.number} onChange={event => setEditing(current => ({ ...current, number: event.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="cert-issued" className={LABEL}>Issued</label><input id="cert-issued" type="date" className={INPUT} value={editing.issued_on} onChange={event => setEditing(current => ({ ...current, issued_on: event.target.value }))} /></div>
            <div><label htmlFor="cert-expires" className={LABEL}>Expires</label><input id="cert-expires" type="date" className={INPUT} value={editing.expires_on} onChange={event => setEditing(current => ({ ...current, expires_on: event.target.value }))} /></div>
          </div>
          <div className="space-y-1">
            <label className={GHOST} htmlFor="cert-file">{editing.file_path ? 'Replace file' : 'Attach a copy (optional)'}</label>
            <input id="cert-file" type="file" accept="application/pdf,image/*" className="sr-only" disabled={busy || !files} onChange={event => { attach(event.target.files?.[0]); event.target.value = ''; }} />
            <p className="font-body text-xs text-xert-pale/50">{editing.file_path ? 'File attached. ' : ''}PDF or photo, under 10 MB. Private to you and the managers.</p>
          </div>
        </>}
      </Sheet>
    </section>
  );
}

function NoticesSection({ client, notify }) {
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setPrefs(await client.myNoticePreferences()); setError(null); } catch (failure) { setError(failure); }
  }, [client]);
  useEffect(() => { load(); }, [load]);
  const change = async patch => {
    const before = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try { setPrefs(await client.setNoticePreferences(next.email, next.push)); notify('Notice settings saved.'); }
    catch (failure) { setPrefs(before); notify(failure.message, 'error'); }
  };
  if (error) return <Banner tone="danger" title="Couldn’t load notice settings" action={<button type="button" className={GHOST} onClick={load}>Try again</button>}>{error.message}</Banner>;
  if (!prefs) return null;
  return (
    <section aria-labelledby="coach-notices-heading" className="space-y-3">
      <h2 id="coach-notices-heading" className="font-display text-2xl uppercase text-xert-offwhite">How you get notices</h2>
      <div className="coaching-card space-y-3">
        <label className="flex items-start gap-3 font-body text-sm text-xert-offwhite min-h-11">
          <input type="checkbox" checked disabled className="mt-1" />
          <span>In the Inbox here <span className="block text-xs text-xert-pale/60">Always on, so nothing about your classes is ever missed.</span></span>
        </label>
        <label className="flex items-start gap-3 font-body text-sm text-xert-offwhite min-h-11">
          <input type="checkbox" className="mt-1" checked={prefs.email} onChange={event => change({ email: event.target.checked })} />
          <span>Email{prefs.account_email ? ` to ${prefs.account_email}` : ''}
            <span className="block text-xs text-xert-pale/60">{prefs.email_available ? 'A copy of each notice.' : 'The gym hasn’t switched roster emails on yet. Your choice is kept for when it does.'}</span></span>
        </label>
        <label className="flex items-start gap-3 font-body text-sm text-xert-offwhite min-h-11">
          <input type="checkbox" className="mt-1" checked={prefs.push} onChange={event => change({ push: event.target.checked })} />
          <span>Phone notifications<span className="block text-xs text-xert-pale/60">Only if you use the XERT iPhone app with notifications allowed.</span></span>
        </label>
      </div>
    </section>
  );
}

/** Profile tab: website profile (manager-approved), certificates, notice settings. */
export default function CoachProfile({ client, uid, notify, files: injectedFiles = null }) {
  const files = useFiles(injectedFiles);
  return (
    <div className="space-y-8">
      <ProfileSection client={client} files={files} uid={uid} notify={notify} />
      <CertificatesSection client={client} files={files} uid={uid} notify={notify} />
      <NoticesSection client={client} notify={notify} />
    </div>
  );
}
