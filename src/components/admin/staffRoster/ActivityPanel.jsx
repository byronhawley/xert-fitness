import React, { useEffect, useState } from 'react';
import { AdminSegmented, ADMIN_TEXT } from '@/components/admin/ui';
import { Tone } from './rosterBits';

// Honest delivery words: a queued email has not been sent, and an inbox
// notice is "delivered" to the app, never "read" until the coach opens it.
const EMAIL_STATUS = {
  not_requested: ['App only', 'neutral'], queued: ['Email queued, not sent yet', 'warning'], sent: ['Email sent', 'success'],
  failed: ['Email failed', 'danger'], skipped: ['Email skipped', 'neutral'], no_address: ['No email address', 'warning'],
  unknown: ['Email outcome unknown', 'warning'],
};

const ACTION_LABELS = {
  roster_published: 'Published roster', roster_acknowledged: 'Coach confirmed roster', session_confirmed: 'Coach confirmed a class', assignment_added: 'Assigned', assignment_removed: 'Removed from class', assignment_moved: 'Moved',
  draft_discarded: 'Discarded draft', availability_submitted: 'Availability submitted', submission_reopened: 'Availability reopened',
  absence_approved: 'Absence approved', absence_rejected: 'Absence declined', absence_recorded: 'Absence recorded', absence_reported: 'Urgent absence reported',
  absence_requested: 'Time off requested', cover_requested: 'Cover requested', cover_offered: 'Cover offered', cover_approved: 'Cover approved',
  cover_rejected: 'Cover declined', settings_updated: 'Settings changed', staff_created: 'Coach added', staff_updated: 'Coach updated',
  staff_active: 'Coach reactivated', staff_inactive: 'Coach deactivated', capabilities_set: 'Capabilities changed', staffing_set: 'Staffing changed',
  period_opened: 'Availability opened', period_updated: 'Due date changed', series_saved: 'Repeating class saved', series_generated: 'Classes generated',
  series_changed_from: 'Repeating class changed from a date', session_withdrawn: 'Request withdrawn',
  public_names_projected: 'Coach names shown on the timetable', public_names_withdrawn: 'Coach names removed from the timetable',
  invite_created: 'Invite link created', invite_revoked: 'Invite cancelled', invite_accepted: 'Coach joined from invite',
};

// Phone push: Apple accepting a push is not proof the phone showed it, and
// never means the coach read it (only "Opened in app" means that). Work that
// was closed without sending (too old, superseded, already read) is shown as
// "not sent", never as a failure or a success.
export function pushStatus(push) {
  if (!push) return null;
  const { accepted = 0, failed = 0, sending = 0, pending = 0, uncertain = 0, not_sent: notSent = 0 } = push;
  if (!(accepted || failed || sending || pending || uncertain || notSent)) return null;
  const extra = [failed && `${failed} failed`, uncertain && `${uncertain} unconfirmed`].filter(Boolean).join(', ');
  if (accepted) return [`Push accepted by Apple${extra ? `, ${extra}` : ''}`, extra ? 'warning' : 'neutral'];
  if (sending || pending) return [sending ? 'Push sending' : 'Push waiting to send', 'warning'];
  if (failed) return [`Push failed${uncertain ? `, ${uncertain} unconfirmed` : ''}`, 'danger'];
  if (uncertain) return ['Push sent, not confirmed by Apple', 'warning'];
  return ['Push not sent (out of date or already read)', 'neutral'];
}

function when(value) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function ActivityPanel({ month, data, onMutate }) {
  const [tab, setTab] = useState('changes');
  const [rows, setRows] = useState(null);
  const { snapshot } = data;
  useEffect(() => {
    let live = true;
    setRows(null);
    onMutate(client => (tab === 'changes' ? client.auditLog(month, 200) : client.notificationLog(month, 200)), null, { reload: false })
      .then(result => { if (live) setRows(result || []); });
    return () => { live = false; };
  }, [tab, month, onMutate, snapshot?.generated_at]);

  return (
    <div className="space-y-4">
      <AdminSegmented label="Activity" value={tab} onValueChange={setTab} options={[{ value: 'changes', label: 'Changes' }, { value: 'notices', label: 'Notices sent' }]} />
      {rows === null && <p className={ADMIN_TEXT.lede}>Loading…</p>}
      {rows?.length === 0 && <p className={ADMIN_TEXT.lede}>Nothing yet for this month.</p>}
      <ul className="staff-roster-list">
        {tab === 'changes' && rows?.map(row => (
          <li key={row.id} className="staff-roster-row">
            <div className="min-w-0">
              <p className="font-body text-sm text-xert-offwhite">{ACTION_LABELS[row.action] || row.action.replace(/_/g, ' ')}</p>
              <p className="font-body text-xs text-xert-pale/55">{when(row.at)} · {row.actor || 'System'}{row.reason ? ` · “${row.reason}”` : ''}</p>
            </div>
          </li>
        ))}
        {tab === 'notices' && rows?.map(row => {
          const [label, tone] = EMAIL_STATUS[row.email_status] || [row.email_status, 'neutral'];
          const push = pushStatus(row.push);
          return (
            <li key={row.id} className="staff-roster-row">
              <div className="min-w-0">
                <p className="font-body text-sm text-xert-offwhite">{row.title}</p>
                <p className="font-body text-xs text-xert-pale/55">To {row.recipient || 'unknown'} · {when(row.created_at)}{new Date(row.deliver_after) > new Date() ? ` · scheduled for ${when(row.deliver_after)}` : ''}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Tone tone={row.read_at ? 'success' : 'neutral'}>{row.read_at ? 'Opened in app' : 'In app inbox, not opened'}</Tone>
                <Tone tone={tone}>{label}</Tone>
                {push && <Tone tone={push[1]}>{push[0]}</Tone>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
