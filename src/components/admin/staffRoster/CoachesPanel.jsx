import React, { useCallback, useEffect, useState } from 'react';
import { AdminButton, AdminDrawer, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { getAllCoaches } from '@/lib/adminData';
import { ROLE_LABELS, STAFF_ROLES } from '@/lib/staffRoster/duty';
import { INVITE_STATUS_LABELS, inviteLink } from '@/lib/staffRoster/invite';
import { gymDateOf, toMs } from '@/lib/staffRoster/time';
import { Notice, Tone } from './rosterBits';
import { CertificateWatch, ProfileReviews } from './CoachRecords';

const EMPTY = { display_name: '', legacy_label: '', roles: ['lead'], profile_id: '', coach_id: '', target_classes_per_month: '', min_classes_per_month: '',
  max_classes_per_week: '', max_duty_minutes_per_day: '', min_rest_minutes: '', manager_note: '' };
const NUMBER_FIELDS = [
  ['target_classes_per_month', 'Target classes a month', 'Used to spread work fairly. Not a promise.'],
  ['min_classes_per_month', 'Minimum classes a month', null],
  ['max_classes_per_week', 'Most classes a week', 'A hard limit when set'],
  ['max_duty_minutes_per_day', 'Most minutes on the floor a day', 'Counts setup and pack-down. A hard limit when set'],
  ['min_rest_minutes', 'Minimum rest between days (minutes)', 'A hard limit when set'],
];

function toForm(row) {
  if (!row) return EMPTY;
  const form = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) form[key] = row[key] ?? EMPTY[key];
  form.roles = row.roles || ['lead'];
  for (const [key] of NUMBER_FIELDS) form[key] = row[key] == null ? '' : String(row[key]);
  return form;
}

function capabilityRows(row) {
  return (row?.capabilities || []).map(item => ({ capability: item.capability, valid_from: item.valid_from?.slice(0, 10) || '', valid_until: item.valid_until?.slice(0, 10) || '' }));
}

function CoachEditor({ row, busy, onClose, onMutate }) {
  const [form, setForm] = useState(() => toForm(row));
  const [capabilities, setCapabilities] = useState(() => capabilityRows(row));
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [publicCoaches, setPublicCoaches] = useState([]);
  const [linkedLabel, setLinkedLabel] = useState(row?.account_email || '');
  const [statusReason, setStatusReason] = useState('');
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  useEffect(() => { getAllCoaches().then(setPublicCoaches).catch(() => setPublicCoaches([])); }, []);

  const search = async () => {
    const result = await onMutate(client => client.linkCandidates(query), null, { reload: false });
    if (result) setCandidates(result);
  };
  const save = async () => {
    const payload = { ...form, id: row?.id || null, profile_id: form.profile_id || null, coach_id: form.coach_id || null };
    for (const [key] of NUMBER_FIELDS) payload[key] = form[key] === '' ? null : Number(form[key]);
    const saved = await onMutate(client => client.upsertStaff(payload, row?.version ?? null), row ? 'Coach saved' : 'Coach added');
    if (!saved) return;
    const before = JSON.stringify(capabilityRows(row));
    const next = capabilities.filter(item => item.capability.trim());
    if (JSON.stringify(next) !== before) {
      await onMutate(client => client.setCapabilities(saved.id, next.map(item => ({
        capability: item.capability.trim().toLowerCase().replace(/\s+/g, '_'),
        valid_from: item.valid_from ? `${item.valid_from}T00:00:00+10:00` : null,
        valid_until: item.valid_until ? `${item.valid_until}T00:00:00+10:00` : null,
      }))), 'Qualifications saved');
    }
    onClose(undefined, row ? null : saved);
  };
  const setStatus = async status => {
    const result = await onMutate(client => client.setStaffStatus(row.id, status, row.version, statusReason), status === 'inactive' ? 'Coach deactivated. Their history is kept.' : 'Coach reactivated');
    if (result) onClose(result.future_assignments_to_review);
  };

  return (
    <AdminDrawer open onOpenChange={value => { if (!value) onClose(); }} title={row ? row.display_name : 'Add a coach'} closeLabel="Close coach editor"
      description="Only managers see these details. Coaches see their own roster, never each other’s notes or limits."
      footer={<><AdminButton disabled={busy || !form.display_name.trim() || form.roles.length === 0} onClick={save}>Save</AdminButton><AdminButton variant="ghost" onClick={() => onClose()}>Cancel</AdminButton></>}>
      <div className="space-y-5">
        <AdminFormField label="Name on the roster" required><input value={form.display_name} onChange={event => set('display_name', event.target.value)} /></AdminFormField>
        <fieldset>
          <legend className="admin-kit-label">Can work as</legend>
          <div className="flex flex-wrap gap-4 mt-1">
            {STAFF_ROLES.map(role => (
              <label key={role} className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
                <input type="checkbox" checked={form.roles.includes(role)} onChange={event => set('roles', event.target.checked ? [...form.roles, role] : form.roles.filter(item => item !== role))} />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </fieldset>

        <section className="space-y-2">
          <h3 className={ADMIN_TEXT.sectionHeading}>Sign-in</h3>
          <p className="font-body text-sm text-xert-pale/70">{form.profile_id ? `Linked to ${linkedLabel || 'an account'}. They can give availability and see their classes.`
            : row ? 'Not linked yet. Easiest: close this and press “Invite” to send them a link. Or, if they already have a XERT account, find it here.'
              : 'After you save, you can send them an invite link to sign in. Or, if they already have a XERT account, find it here. No membership is needed.'}</p>
          <div className="flex flex-wrap items-end gap-2">
            <AdminFormField label="Find account by name or email"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') search(); }} /></AdminFormField>
            <AdminButton variant="ghost" disabled={query.trim().length < 2} onClick={search}>Search</AdminButton>
            {form.profile_id && <AdminButton variant="ghost" onClick={() => { set('profile_id', ''); setLinkedLabel(''); }}>Unlink</AdminButton>}
          </div>
          {candidates.length > 0 && (
            <ul className="staff-roster-list">
              {candidates.map(item => (
                <li key={item.id} className="staff-roster-row">
                  <span className="font-body text-sm">{item.full_name || 'No name'} · {item.email}</span>
                  {item.linked && item.id !== row?.profile_id ? <Tone>Already linked</Tone>
                    : <AdminButton variant="ghost" onClick={() => { set('profile_id', item.id); setLinkedLabel(item.email); setCandidates([]); }}>Link</AdminButton>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="staff-roster-more">
          <summary><span className="font-body text-sm font-semibold text-xert-offwhite">More settings</span><span className="font-body text-xs text-xert-pale/60">Timetable name, website profile, limits, qualifications, private note. All optional.</span></summary>
          <div className="space-y-5">
        <AdminFormField label="Name in the class calendar" helper="Only if the timetable shows a different name for them"><input value={form.legacy_label} onChange={event => set('legacy_label', event.target.value)} /></AdminFormField>
        <AdminFormField label="Website coach profile" helper="Optional. Lets the public timetable show who is coaching, from the published roster.">
          <select value={form.coach_id || ''} onChange={event => set('coach_id', event.target.value)}>
            <option value="">Not linked</option>
            {publicCoaches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </AdminFormField>

        <div className="grid gap-3 sm:grid-cols-2">
          {NUMBER_FIELDS.map(([key, label, helper]) => (
            <AdminFormField key={key} label={label} helper={helper}><input type="number" min="0" inputMode="numeric" value={form[key]} onChange={event => set(key, event.target.value)} /></AdminFormField>
          ))}
        </div>

        <section className="space-y-2">
          <h3 className={ADMIN_TEXT.sectionHeading}>Qualifications</h3>
          <p className="font-body text-xs text-xert-pale/55">E.g. first_aid, or a class type they’re trained for. A class can require one; once it expires they can’t be put on that class.</p>
          {capabilities.map((item, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-4 items-end">
              <AdminFormField label="Qualification"><input value={item.capability} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, capability: event.target.value } : entry)))} /></AdminFormField>
              <AdminFormField label="Valid from"><input type="date" value={item.valid_from} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, valid_from: event.target.value } : entry)))} /></AdminFormField>
              <AdminFormField label="Valid until"><input type="date" value={item.valid_until} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, valid_until: event.target.value } : entry)))} /></AdminFormField>
              <AdminButton variant="ghost" onClick={() => setCapabilities(list => list.filter((_, i) => i !== index))}>Remove</AdminButton>
            </div>
          ))}
          <AdminButton variant="ghost" onClick={() => setCapabilities(list => [...list, { capability: '', valid_from: '', valid_until: '' }])}>Add qualification</AdminButton>
        </section>

        <AdminFormField label="Manager note" helper="Private to managers. Don’t record medical details."><textarea rows={2} value={form.manager_note || ''} onChange={event => set('manager_note', event.target.value)} /></AdminFormField>
          </div>
        </details>

        {row && (
          <section className="space-y-2">
            <h3 className={ADMIN_TEXT.sectionHeading}>{row.status === 'active' ? 'Deactivate' : 'Reactivate'}</h3>
            <p className="font-body text-xs text-xert-pale/55">{row.status === 'active' ? 'They stop appearing as a choice and can’t be published on future classes. Past rosters and history stay.' : 'They can be assigned again.'}</p>
            <div className="flex flex-wrap items-end gap-2">
              <AdminFormField label="Reason (kept in the Activity tab)"><input value={statusReason} onChange={event => setStatusReason(event.target.value)} /></AdminFormField>
              <AdminButton variant={row.status === 'active' ? 'danger' : 'ghost'} disabled={busy} onClick={() => setStatus(row.status === 'active' ? 'inactive' : 'active')}>{row.status === 'active' ? 'Deactivate' : 'Reactivate'}</AdminButton>
            </div>
          </section>
        )}
      </div>
    </AdminDrawer>
  );
}

const INVITE_TONE = { pending: 'info', expired: 'warning', accepted: 'success', revoked: 'neutral' };
const EMAIL_OUTCOME = {
  queued: email => `Emailed to ${email}.`,
  sent: email => `Emailed to ${email}.`,
  skipped: () => 'Email is switched off in Email settings, so nothing was sent. Copy the link and send it yourself.',
  failed: () => 'The email could not be queued. Copy the link and send it yourself.',
  no_address: () => 'That address can’t receive email. Copy the link and send it yourself.',
};
const shortDate = value => gymDateOf(toMs(value));

/** Invite link for a coach who has no sign-in yet. The link is shown once. */
function InviteDrawer({ row, invite, busy, onClose, onMutate, onChanged }) {
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const link = created ? inviteLink(window.location.origin, created.token) : '';
  const live = invite && (invite.status === 'pending' || invite.status === 'expired');

  const create = async () => {
    const result = await onMutate(client => client.createInvite(row.id, email.trim() || null), null, { reload: false });
    if (!result) return;
    setCreated(result);
    setCopied(false);
    onChanged();
  };
  const revoke = async () => {
    const result = await onMutate(client => client.revokeInvite(invite.id), 'Invite cancelled. The link no longer works.', { reload: false });
    if (result) { setCreated(null); onChanged(); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /** @type {HTMLInputElement | null} */ (document.getElementById('coach-invite-link'))?.select(); }
  };

  return (
    <AdminDrawer open onOpenChange={value => { if (!value) onClose(); }} title={`Invite ${row.display_name}`} closeLabel="Close invite"
      description="They open the link, sign in or create an account, and it connects to this coach. No membership needed."
      footer={<AdminButton variant="ghost" onClick={onClose}>Done</AdminButton>}>
      <div className="space-y-5">
        <p className="font-body text-sm text-xert-pale/70">The link works once and expires after 14 days. Making a new link cancels the previous one.</p>
        {invite && !created && (
          <section className="space-y-2" aria-label="Current invite">
            <h3 className={ADMIN_TEXT.sectionHeading}>Current invite</h3>
            <p className="font-body text-sm text-xert-pale/80">
              <Tone tone={INVITE_TONE[invite.status]}>{INVITE_STATUS_LABELS[invite.status]}</Tone>{' '}
              Created {shortDate(invite.created_at)}{invite.created_by ? ` by ${invite.created_by}` : ''}
              {invite.status === 'pending' ? ` · expires ${shortDate(invite.expires_at)}` : ''}
              {invite.email ? ` · emailed to ${invite.email}` : ''}
            </p>
            {live && <AdminButton variant="danger" disabled={busy} onClick={revoke}>Cancel invite</AdminButton>}
          </section>
        )}
        {created ? (
          <section className="space-y-2" aria-label="Link created">
            <h3 className={ADMIN_TEXT.sectionHeading}>Invite link</h3>
            <AdminFormField label="Invite link" helper="Shown once. XERT keeps only a fingerprint of it, so copy it now.">
              <input id="coach-invite-link" readOnly value={link} onFocus={event => event.target.select()} />
            </AdminFormField>
            <div className="flex flex-wrap gap-2">
              <AdminButton onClick={copy}>{copied ? 'Copied' : 'Copy link'}</AdminButton>
              <AdminButton variant="ghost" disabled={busy} onClick={() => setCreated(null)}>Make another</AdminButton>
            </div>
            {created.invite.email && <Notice tone={created.invite.email_status === 'queued' || created.invite.email_status === 'sent' ? 'success' : 'warning'}>
              {(EMAIL_OUTCOME[created.invite.email_status] || EMAIL_OUTCOME.failed)(created.invite.email)}
            </Notice>}
          </section>
        ) : (
          <section className="space-y-2" aria-label="Create invite">
            <AdminFormField label="Also email the link to (optional)" helper="Sent through the site’s email, if email is switched on.">
              <input type="email" autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} />
            </AdminFormField>
            <AdminButton disabled={busy} onClick={create}>{invite ? 'Create a new invite link' : 'Create invite link'}</AdminButton>
          </section>
        )}
      </div>
    </AdminDrawer>
  );
}

/** One plain status per coach, in words: what they can do now, and what's next. */
export function coachRowState(row, invite) {
  if (row.status !== 'active') return { key: 'inactive', label: 'Inactive', tone: 'neutral', detail: 'Not offered for classes. History is kept.' };
  if (row.profile_id) return { key: 'ready', label: 'Ready', tone: 'success', detail: `Signs in as ${row.account_email || 'their XERT account'}.` };
  if (invite?.status === 'pending') return { key: 'invited', label: 'Invite sent', tone: 'info', detail: 'Waiting for them to open the link and sign in.' };
  if (invite?.status === 'expired') return { key: 'expired', label: 'Invite expired', tone: 'warning', detail: 'Send a new invite link.' };
  return { key: 'needs_invite', label: 'Needs to sign in', tone: 'warning', detail: 'Send an invite link so they can give availability and see their classes.' };
}

export default function CoachesPanel({ data, onMutate, focusStaffId, intent = null, onIntentDone = () => {} }) {
  const { snapshot, busy } = data;
  const [editing, setEditing] = useState(null);
  const [inviting, setInviting] = useState(null);
  const [invites, setInvites] = useState({});
  const [notice, setNotice] = useState(null);
  const staff = snapshot.staff || [];
  const loadInvites = useCallback(async () => {
    const rows = await onMutate(client => client.listInvites(), null, { reload: false });
    if (Array.isArray(rows)) setInvites(Object.fromEntries(rows.map(item => [item.staff_id, item])));
  }, [onMutate]);
  useEffect(() => { loadInvites(); }, [loadInvites]);
  useEffect(() => {
    if (intent === 'add-coach') { setEditing('new'); onIntentDone(); }
  }, [intent, onIntentDone]);
  const states = staff.map(row => ({ row, state: coachRowState(row, invites[row.id]) }));
  const ready = states.filter(item => item.state.key === 'ready').length;
  const waiting = states.filter(item => ['needs_invite', 'invited', 'expired'].includes(item.state.key)).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className={ADMIN_TEXT.lede}>Everyone you can put on a class. Add a coach, then send them an invite link: they sign in on the website (no membership needed) and can then give availability and see their classes.</p>
          {staff.length > 0 && <p className="font-body text-sm text-xert-offwhite" role="status">{ready} ready{waiting ? ` · ${waiting} still to sign in` : ''}</p>}
        </div>
        <AdminButton onClick={() => setEditing('new')}>Add a coach</AdminButton>
      </div>
      {notice}
      <ProfileReviews onMutate={onMutate} />
      <CertificateWatch onMutate={onMutate} />
      {staff.length === 0 && (
        <Notice tone="info" title="No coaches yet" action={<AdminButton onClick={() => setEditing('new')}>Add your first coach</AdminButton>}>
          1. Add their name and what they can coach. 2. Send them the invite link. 3. Once they sign in, ask them for availability.
        </Notice>
      )}
      <ul className="staff-roster-list">
        {states.map(({ row, state }) => {
          const invite = invites[row.id];
          const canInvite = !row.profile_id && row.status === 'active';
          return (
            <li key={row.id} id={`roster-staff-${row.id}`} className="staff-roster-row" data-focused={focusStaffId === row.id}>
              <div className="min-w-0">
                <p className="font-body text-sm font-semibold text-xert-offwhite">{row.display_name} <Tone tone={state.tone}>{state.label}</Tone></p>
                <p className="font-body text-xs text-xert-pale/60">{row.roles.map(role => ROLE_LABELS[role]).join(', ')} · {state.detail}{row.capabilities?.length ? ` · ${row.capabilities.map(item => item.capability).join(', ')}` : ''}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canInvite && <AdminButton variant={invite?.status === 'pending' ? 'ghost' : 'primary'} onClick={() => setInviting(row)}>{invite?.status === 'pending' ? 'Invite again' : 'Invite'}<span className="visually-hidden"> {row.display_name}</span></AdminButton>}
                <AdminButton variant="ghost" onClick={() => setEditing(row)}>Edit<span className="visually-hidden"> {row.display_name}</span></AdminButton>
              </div>
            </li>
          );
        })}
      </ul>
      {inviting && <InviteDrawer row={inviting} invite={invites[inviting.id]} busy={busy} onMutate={onMutate} onChanged={loadInvites} onClose={() => { setInviting(null); data.reload?.(); }} />}
      {editing && <CoachEditor row={editing === 'new' ? null : editing} busy={busy} onMutate={onMutate}
        onClose={(review, created) => {
          setEditing(null);
          setNotice(review ? <Notice tone="warning" title={`${review} future ${review === 1 ? 'class needs' : 'classes need'} another coach`}>They stay on those classes until you change them, and the roster can’t be published while they’re there.</Notice> : null);
          // A new coach with no sign-in goes straight to the invite link: the next step.
          if (created?.id && !created.profile_id) setInviting({ ...created, display_name: created.display_name, status: created.status || 'active' });
        }} />}
    </div>
  );
}
