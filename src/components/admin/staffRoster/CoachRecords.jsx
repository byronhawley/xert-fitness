import React, { useCallback, useEffect, useState } from 'react';
import { AdminButton, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { Notice, Tone } from './rosterBits';

const KIND_LABEL = { first_aid: 'First aid', cpr: 'CPR', coaching: 'Coaching qualification', working_with_children: 'Working with children', other: 'Other' };
const PROFILE_FIELDS = [['name', 'Name'], ['role', 'Role'], ['bio', 'About'], ['experience', 'Experience'], ['currently_training_for', 'Training for'], ['social_url', 'Link']];

/** Coach profile drafts waiting for approval before they reach the Coaches page. */
export function ProfileReviews({ onMutate }) {
  const [items, setItems] = useState([]);
  const [notes, setNotes] = useState({});
  const load = useCallback(async () => {
    const rows = await onMutate(client => client.profileReviews(), null, { reload: false });
    if (Array.isArray(rows)) setItems(rows);
  }, [onMutate]);
  useEffect(() => { load(); }, [load]);
  const decide = async (item, decision) => {
    const done = await onMutate(client => client.reviewProfile(item.staff_id, decision, notes[item.staff_id] || null, item.draft.version),
      decision === 'approve' ? `${item.display_name}’s profile is approved` : `${item.display_name}’s profile was sent back`, { reload: false });
    if (done) await load();
  };
  if (!items.length) return null;
  return (
    <section aria-labelledby="roster-profile-reviews" className="space-y-2">
      <h3 id="roster-profile-reviews" className={ADMIN_TEXT.sectionHeading}>Profiles waiting for approval ({items.length})</h3>
      <ul className="staff-roster-list">
        {items.map(item => (
          <li key={item.staff_id} className="staff-roster-row items-start">
            <div className="min-w-0 space-y-1">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{item.display_name}</p>
              {item.draft.photo_url && <img src={item.draft.photo_url} alt={`Proposed photo for ${item.display_name}`} className="w-16 h-20 object-cover rounded" />}
              {PROFILE_FIELDS.filter(([key]) => item.draft[key]).map(([key, label]) => (
                <p key={key} className="font-body text-xs text-xert-pale/70"><span className="text-xert-pale/50">{label}:</span> {item.draft[key]}
                  {item.public && item.public[key] !== item.draft[key] ? <Tone tone="info" className="ml-1">changed</Tone> : null}</p>
              ))}
              {item.public?.published === false && <p className="font-body text-xs text-status-warning-200">Their website profile is hidden; approving keeps it hidden.</p>}
              {!item.public && <p className="font-body text-xs text-xert-pale/55">No website profile yet: approving creates one on the Coaches page.</p>}
            </div>
            <div className="space-y-2 min-w-[12rem]">
              <AdminFormField label="Note if sending back"><input value={notes[item.staff_id] || ''} onChange={event => setNotes(current => ({ ...current, [item.staff_id]: event.target.value }))} /></AdminFormField>
              <div className="flex flex-wrap gap-2">
                <AdminButton onClick={() => decide(item, 'approve')} aria-label={`Approve ${item.display_name}’s profile`}>Approve</AdminButton>
                <AdminButton variant="ghost" onClick={() => decide(item, 'reject')}>Send back</AdminButton>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Expired and soon-expiring certificates, and active coaches with no first aid or CPR. */
export function CertificateWatch({ onMutate }) {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    onMutate(client => client.certificatesOverview(), null, { reload: false }).then(result => { if (result && result !== true) setData(result); });
  }, [onMutate]);
  if (!data) return null;
  const urgent = data.certificates.filter(item => item.state === 'expired' || item.state === 'expiring');
  const shown = showAll ? data.certificates : urgent;
  return (
    <section aria-labelledby="roster-certificates" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="roster-certificates" className={ADMIN_TEXT.sectionHeading}>Certificates</h3>
        {data.certificates.length > 0 && <AdminButton variant="ghost" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Only expiring' : `Show all (${data.certificates.length})`}</AdminButton>}
      </div>
      {urgent.length === 0 && data.missing_first_aid.length === 0 && <p className="font-body text-sm text-xert-pale/60">Everyone has current first aid or CPR on file, and nothing expires in the next 30 days.</p>}
      {data.missing_first_aid.length > 0 && (
        <Notice tone="warning" title={`${data.missing_first_aid.length} active ${data.missing_first_aid.length === 1 ? 'coach has' : 'coaches have'} no current first aid or CPR on file`}>
          {data.missing_first_aid.map(item => item.display_name).join(', ')}
        </Notice>
      )}
      {shown.length > 0 && (
        <ul className="staff-roster-list">
          {shown.map(item => (
            <li key={item.id} className="staff-roster-row">
              <div className="min-w-0">
                <p className="font-body text-sm font-semibold text-xert-offwhite">{item.display_name} · {item.title || KIND_LABEL[item.kind] || item.kind}</p>
                <p className="font-body text-xs text-xert-pale/60">{item.expires_on ? `Expires ${item.expires_on}` : 'No expiry'}{item.number ? ` · No. ${item.number}` : ''}{item.file_path ? ' · copy on file' : ''}</p>
              </div>
              <Tone tone={item.state === 'expired' ? 'danger' : item.state === 'expiring' ? 'warning' : 'success'}>
                {item.state === 'expired' ? 'Expired' : item.state === 'expiring' ? `${item.days_left} days left` : 'Current'}
              </Tone>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Read-only peek at a class's headcount and the coaches' session plan. */
export function SessionPlanPeek({ client, sessionId }) {
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setDetail(null); setFailed(false);
    if (client?.classDetail && sessionId) client.classDetail(sessionId).then(result => { if (live) setDetail(result); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [client, sessionId]);
  if (failed || !detail) return null;
  return (
    <section aria-labelledby="roster-session-plan" className="space-y-1">
      <h3 id="roster-session-plan" className={ADMIN_TEXT.sectionHeading}>Bookings and session plan</h3>
      <p className="font-body text-sm text-xert-pale/70">{detail.booked}{detail.capacity ? ` of ${detail.capacity}` : ''} booked{detail.pending ? ` · ${detail.pending} requests` : ''}{detail.waitlist ? ` · ${detail.waitlist} waiting` : ''}</p>
      {detail.note?.body
        ? <p className="font-body text-sm text-xert-pale/80 whitespace-pre-wrap">{detail.note.body}<span className="block text-xs text-xert-pale/50">— {detail.note.by || 'a coach'}</span></p>
        : <p className="font-body text-sm text-xert-pale/55">No session plan written yet.</p>}
    </section>
  );
}
