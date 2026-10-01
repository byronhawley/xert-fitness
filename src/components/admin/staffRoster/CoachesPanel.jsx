import React, { useEffect, useState } from 'react';
import { AdminButton, AdminDrawer, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { getAllCoaches } from '@/lib/adminData';
import { ROLE_LABELS, STAFF_ROLES } from '@/lib/staffRoster/duty';
import { Notice, Tone } from './rosterBits';

const EMPTY = { display_name: '', legacy_label: '', roles: ['lead'], profile_id: '', coach_id: '', target_classes_per_month: '', min_classes_per_month: '',
  max_classes_per_week: '', max_duty_minutes_per_day: '', min_rest_minutes: '', manager_note: '' };
const NUMBER_FIELDS = [
  ['target_classes_per_month', 'Target classes a month', 'Used to spread work fairly. Not a promise.'],
  ['min_classes_per_month', 'Minimum classes a month', null],
  ['max_classes_per_week', 'Most classes a week', 'A hard limit when set'],
  ['max_duty_minutes_per_day', 'Most duty minutes a day', 'A hard limit when set'],
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
      }))), 'Capabilities saved');
    }
    onClose();
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
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminFormField label="Name on the roster" required><input value={form.display_name} onChange={event => set('display_name', event.target.value)} /></AdminFormField>
          <AdminFormField label="Name in the class calendar" helper="If the timetable shows a different name for them"><input value={form.legacy_label} onChange={event => set('legacy_label', event.target.value)} /></AdminFormField>
        </div>
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
          <p className="font-body text-sm text-xert-pale/70">{form.profile_id ? `Linked to ${linkedLabel || 'an account'}.` : 'Not linked. Link their XERT account so they can give availability and see their roster. No membership is needed.'}</p>
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
          <h3 className={ADMIN_TEXT.sectionHeading}>Capabilities</h3>
          <p className="font-body text-xs text-xert-pale/55">E.g. first_aid or a class type they’re trained for. A class position can require one; an expired capability blocks assignment.</p>
          {capabilities.map((item, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-4 items-end">
              <AdminFormField label="Capability"><input value={item.capability} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, capability: event.target.value } : entry)))} /></AdminFormField>
              <AdminFormField label="Valid from"><input type="date" value={item.valid_from} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, valid_from: event.target.value } : entry)))} /></AdminFormField>
              <AdminFormField label="Valid until"><input type="date" value={item.valid_until} onChange={event => setCapabilities(list => list.map((entry, i) => (i === index ? { ...entry, valid_until: event.target.value } : entry)))} /></AdminFormField>
              <AdminButton variant="ghost" onClick={() => setCapabilities(list => list.filter((_, i) => i !== index))}>Remove</AdminButton>
            </div>
          ))}
          <AdminButton variant="ghost" onClick={() => setCapabilities(list => [...list, { capability: '', valid_from: '', valid_until: '' }])}>Add capability</AdminButton>
        </section>

        <AdminFormField label="Manager note" helper="Private to managers. Don’t record medical details."><textarea rows={2} value={form.manager_note || ''} onChange={event => set('manager_note', event.target.value)} /></AdminFormField>

        {row && (
          <section className="space-y-2">
            <h3 className={ADMIN_TEXT.sectionHeading}>{row.status === 'active' ? 'Deactivate' : 'Reactivate'}</h3>
            <p className="font-body text-xs text-xert-pale/55">{row.status === 'active' ? 'They stop appearing as a choice and can’t be published on future classes. Past rosters and history stay.' : 'They can be assigned again.'}</p>
            <div className="flex flex-wrap items-end gap-2">
              <AdminFormField label="Reason (activity log)"><input value={statusReason} onChange={event => setStatusReason(event.target.value)} /></AdminFormField>
              <AdminButton variant={row.status === 'active' ? 'danger' : 'ghost'} disabled={busy} onClick={() => setStatus(row.status === 'active' ? 'inactive' : 'active')}>{row.status === 'active' ? 'Deactivate' : 'Reactivate'}</AdminButton>
            </div>
          </section>
        )}
      </div>
    </AdminDrawer>
  );
}

export default function CoachesPanel({ data, onMutate, focusStaffId }) {
  const { snapshot, busy } = data;
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const staff = snapshot.staff || [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={ADMIN_TEXT.lede}>Everyone who can be rostered. Linking a sign-in gives them the coach screens in the app and on the website.</p>
        <AdminButton onClick={() => setEditing('new')}>Add a coach</AdminButton>
      </div>
      {notice}
      {staff.length === 0 && <p className="font-body text-sm text-xert-pale/60">No coaches yet.</p>}
      <ul className="staff-roster-list">
        {staff.map(row => (
          <li key={row.id} className="staff-roster-row" data-focused={focusStaffId === row.id}>
            <div className="min-w-0">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{row.display_name} {row.status !== 'active' && <Tone>Inactive</Tone>}</p>
              <p className="font-body text-xs text-xert-pale/60">{row.roles.map(role => ROLE_LABELS[role]).join(', ')} · {row.account_email ? `Signs in as ${row.account_email}` : 'No sign-in linked'}{row.capabilities?.length ? ` · ${row.capabilities.map(item => item.capability).join(', ')}` : ''}</p>
            </div>
            <AdminButton variant="ghost" onClick={() => setEditing(row)}>Edit</AdminButton>
          </li>
        ))}
      </ul>
      {editing && <CoachEditor row={editing === 'new' ? null : editing} busy={busy} onMutate={onMutate}
        onClose={review => { setEditing(null); setNotice(review ? <Notice tone="warning" title={`${review} future ${review === 1 ? 'class needs' : 'classes need'} another coach`}>They stay on those classes until you change them, and the roster can’t be published while they’re there.</Notice> : null); }} />}
    </div>
  );
}
