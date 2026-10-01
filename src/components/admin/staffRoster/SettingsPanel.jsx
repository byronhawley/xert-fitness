import React, { useState } from 'react';
import { AdminButton, AdminFormField, ADMIN_TEXT } from '@/components/admin/ui';
import { DEFAULT_REMINDERS, defaultPeriodDates, normalizeCycle, normalizeReminders } from '@/lib/staffRoster/cycle';
import { normalizeStaffing } from '@/lib/staffRoster/duty';
import { rosterSwitchState } from '@/lib/staffRoster/switchOrder';
import { addMonths, clockLabel, dateInMonth, daysInMonth, minuteLabel, parseClock } from '@/lib/staffRoster/time';
import { dayLabel, monthLabel } from './rosterFormat';
import { Notice, Tone } from './rosterBits';
import StaffingEditor from './StaffingEditor';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function GeneralSettings({ settings, month, busy, onMutate }) {
  const [presets, setPresets] = useState(() => (settings.class_time_presets || []).map(item => clockLabel(item.minute)));
  const [cycle, setCycle] = useState(() => normalizeCycle(settings.cycle));
  const [reminders, setReminders] = useState(() => normalizeReminders(settings.reminders || DEFAULT_REMINDERS));
  const [newPreset, setNewPreset] = useState('');
  const parsed = presets.map(parseClock);
  const presetError = parsed.some(value => value === null || value >= 1440) ? 'Use 24-hour times like 05:15 or 17:30.'
    : new Set(parsed).size !== parsed.length ? 'Each preset must be a different time.' : null;
  let example = null;
  try { const dates = defaultPeriodDates(month, cycle); example = `${monthLabel(month)}: opens ${dayLabel(dates.opensOn)}, due ${dayLabel(dates.dueOn)}, aim to publish by ${dayLabel(dates.publishTargetOn)}.`; } catch (error) { example = error.message; }
  const save = (patch, message) => onMutate(client => client.updateSettings(patch, settings.version), message);
  const switchState = rosterSwitchState(settings);
  const cycleField = (key, label) => (
    <AdminFormField label={label}><input type="number" min="0" max={key.endsWith('Day') ? 31 : 12} inputMode="numeric" value={cycle[key]} onChange={event => setCycle(current => ({ ...current, [key]: Number(event.target.value) }))} /></AdminFormField>
  );

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="roster-switch">
        <h3 id="roster-switch" className={ADMIN_TEXT.sectionHeading}>Coach roster</h3>
        <Notice tone={settings.enabled ? 'success' : 'warning'} title={settings.enabled ? 'On — coaches can see their screens' : 'Off — only managers can see the roster'}
          action={<AdminButton variant={settings.enabled ? 'danger' : 'primary'} disabled={busy || (settings.enabled && !switchState.canSwitchOff)} aria-describedby={switchState.blockReason ? 'roster-switch-order' : undefined} onClick={() => save({ enabled: !settings.enabled }, settings.enabled ? 'Coach roster switched off' : 'Coach roster switched on')}>{settings.enabled ? 'Switch off' : 'Switch on'}</AdminButton>}>
          While it’s off, coaches can’t open availability or roster screens and class changes send no roster notices or phone pushes. Turning it off never deletes anything, and on its own it does not remove coach names from the public timetable.
        </Notice>
        {switchState.blockReason && <p id="roster-switch-order" className="font-body text-sm text-xert-pale/80">{switchState.blockReason}</p>}
        {switchState.namesStillShowing && (
          <Notice tone="warning" title="Coach names are still on the public timetable">
            The roster is off, but the names it put on upcoming classes are still showing. Turn off “Show the lead coach on the public timetable” below to remove them; names typed by hand stay.
          </Notice>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="roster-presets">
        <h3 id="roster-presets" className={ADMIN_TEXT.sectionHeading}>Class-time shortcuts</h3>
        <p className={ADMIN_TEXT.lede}>Shown to coaches as quick picks when they give availability. Each covers the real duty time of the classes at that time, so coaches can’t tick a time that falls short. Changing these never moves a class.</p>
        <div className="flex flex-wrap gap-2">
          {presets.map((value, index) => (
            <span key={`${value}-${index}`} className="inline-flex items-center gap-1">
              <input aria-label={`Shortcut ${index + 1}`} className="admin-kit-input w-24" value={value} onChange={event => setPresets(list => list.map((item, i) => (i === index ? event.target.value : item)))} />
              <AdminButton variant="ghost" aria-label={`Remove ${value}`} onClick={() => setPresets(list => list.filter((_, i) => i !== index))}>×</AdminButton>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input aria-label="New shortcut time" placeholder="e.g. 19:00" className="admin-kit-input w-28" value={newPreset} onChange={event => setNewPreset(event.target.value)} />
            <AdminButton variant="ghost" disabled={parseClock(newPreset) === null} onClick={() => { setPresets(list => [...list, newPreset]); setNewPreset(''); }}>Add</AdminButton>
          </span>
        </div>
        {presetError && <p className="admin-field-error">{presetError}</p>}
        {!presetError && <p className="font-body text-xs text-xert-pale/55">{parsed.slice().sort((a, b) => a - b).map(minuteLabel).join(' · ')}</p>}
        <AdminButton disabled={busy || Boolean(presetError)} onClick={() => save({ class_time_presets: parsed.map(minute => ({ minute })) }, 'Shortcuts saved')}>Save shortcuts</AdminButton>
      </section>

      <section className="space-y-3" aria-labelledby="roster-cycle">
        <h3 id="roster-cycle" className={ADMIN_TEXT.sectionHeading}>Planning cycle</h3>
        <p className={ADMIN_TEXT.lede}>Months before the roster month, and the day of that month.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {cycleField('openMonthsBefore', 'Open: months before')}{cycleField('dueMonthsBefore', 'Due: months before')}{cycleField('publishMonthsBefore', 'Publish target: months before')}
          {cycleField('openDay', 'Open: day')}{cycleField('dueDay', 'Due: day')}{cycleField('publishDay', 'Publish target: day')}
        </div>
        <p className="font-body text-sm text-xert-pale/70">{example}</p>
        <AdminButton disabled={busy} onClick={() => save({ cycle }, 'Planning cycle saved')}>Save cycle</AdminButton>
      </section>

      <section className="space-y-3" aria-labelledby="roster-reminders">
        <h3 id="roster-reminders" className={ADMIN_TEXT.sectionHeading}>Reminders</h3>
        <div className="grid gap-2">
          {[['onOpen', 'When availability opens'], ['onDue', 'On the due date'], ['overdueSummary', 'Tell managers who is overdue']].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
              <input type="checkbox" checked={Boolean(reminders[key])} onChange={event => setReminders(current => ({ ...current, [key]: event.target.checked }))} /> {label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminFormField label="Days before due" helper="Comma separated, e.g. 3, 1"><input value={reminders.daysBeforeDue.join(', ')} onChange={event => setReminders(current => ({ ...current, daysBeforeDue: event.target.value.split(',').map(item => Number(item.trim())).filter(Number.isInteger) }))} /></AdminFormField>
          <AdminFormField label="Send at" helper="Gym time, between 06:00 and 20:00"><input value={clockLabel(reminders.sendMinute)} onChange={event => { const minute = parseClock(event.target.value); if (minute !== null) setReminders(current => ({ ...current, sendMinute: minute })); }} /></AdminFormField>
        </div>
        <AdminButton disabled={busy} onClick={() => save({ reminders: normalizeReminders(reminders) }, 'Reminders saved')}>Save reminders</AdminButton>
      </section>

      <section className="space-y-3" aria-labelledby="roster-rules">
        <h3 id="roster-rules" className={ADMIN_TEXT.sectionHeading}>Rules and notices</h3>
        <label className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
          <input type="checkbox" checked={settings.allow_if_needed_fallback !== false} disabled={busy} onChange={event => save({ allow_if_needed_fallback: event.target.checked }, 'Saved')} />
          Allow “if needed” coaches to be assigned
        </label>
        <label className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
          <input type="checkbox" checked={Boolean(settings.email_notices_enabled)} disabled={busy} onChange={event => save({ email_notices_enabled: event.target.checked }, 'Saved')} />
          Also email roster notices (uses the site’s existing email sending)
        </label>
        <p className="font-body text-xs text-xert-pale/55">Every notice goes to the coach’s inbox in the app. Emails are queued and the activity log shows whether each was actually sent.</p>
        <label className="flex items-center gap-2 font-body text-sm text-xert-pale min-h-11">
          <input type="checkbox" checked={Boolean(settings.public_coach_names_enabled)} disabled={busy} onChange={event => save({ public_coach_names_enabled: event.target.checked }, event.target.checked
            ? 'Saved. Upcoming classes now show the lead coach from the published roster.'
            : 'Saved. Names the roster put on upcoming classes are removed; names typed or edited by hand stay.')} />
          Show the lead coach on the public timetable
        </label>
        <p className="font-body text-xs text-xert-pale/55">Only coaches linked to a published Coaches page profile are named, using that profile’s name, from the published roster. A coach name typed or edited on a class by hand is never replaced or removed. Turning this off removes only the names the roster put on upcoming classes; past classes keep theirs.</p>
      </section>
    </div>
  );
}

function ClassTypeStaffing({ snapshot, busy, onSaveStaffing }) {
  const rows = snapshot.class_type_staffing || [];
  const types = [...new Set([...rows.map(row => row.class_type), ...(snapshot.sessions || []).map(session => session.class_type)])].filter(Boolean).sort();
  const [editing, setEditing] = useState(null);
  return (
    <section className="space-y-3" aria-labelledby="roster-type-staffing">
      <h3 id="roster-type-staffing" className={ADMIN_TEXT.sectionHeading}>Staffing by class type</h3>
      <p className={ADMIN_TEXT.lede}>Applies to every class of that type unless a class has its own. Without a setting, a class needs one lead coach.</p>
      <ul className="staff-roster-list">
        {types.map(type => {
          const row = rows.find(item => item.class_type === type);
          const staffing = normalizeStaffing(row ? { slots: row.slots, prepMinutes: row.prep_minutes, wrapMinutes: row.wrap_minutes, allowBlock: row.allow_block } : null);
          return (
            <li key={type} className="staff-roster-row">
              <div className="min-w-0 w-full">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-body text-sm font-semibold text-xert-offwhite">{type} {!row && <Tone>Default</Tone>}</p>
                  <AdminButton variant="ghost" onClick={() => setEditing(editing === type ? null : type)}>{editing === type ? 'Close' : 'Change'}</AdminButton>
                </div>
                <p className="font-body text-xs text-xert-pale/60">{staffing.slots.map(slot => `${slot.required ? '' : 'optional '}${slot.role}`).join(', ')}{staffing.prepMinutes || staffing.wrapMinutes ? ` · ${staffing.prepMinutes}/${staffing.wrapMinutes} min before/after` : ''}</p>
                {editing === type && <StaffingEditor staffing={staffing} busy={busy} allowReset={Boolean(row)} resetLabel="Back to one lead coach"
                  onSave={async value => { await onSaveStaffing('class_type', type, value, row?.version ?? 0); setEditing(null); }} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SeriesPanel({ snapshot, month, today, busy, onMutate }) {
  const series = snapshot.series || [];
  const [change, setChange] = useState(null);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState(null);
  const first = dateInMonth(month, 1);
  const last = dateInMonth(month, daysInMonth(month));
  const blank = { title: '', class_type: '', weekdays: [], start: '', duration_minutes: '', capacity: '', effective_from: today > first ? today : first, effective_until: '', publish_generated: false };

  const saveNew = async () => {
    const payload = { ...form, start_minute: parseClock(form.start), duration_minutes: Number(form.duration_minutes), capacity: Number(form.capacity), effective_until: form.effective_until || null };
    delete payload.start;
    if (await onMutate(client => client.saveSeries(payload, null), 'Repeating class saved. Nothing is created until you generate it.')) setForm(null);
  };
  const runPreview = async () => {
    const result = await onMutate(client => client.changeSeriesFrom(change.series.id, change.from, { start_minute: parseClock(change.start), duration_minutes: Number(change.duration) || undefined }, false, change.series.version), null, { reload: false });
    if (result) setPreview(result.preview);
  };
  const apply = async () => {
    const result = await onMutate(client => client.changeSeriesFrom(change.series.id, change.from, { start_minute: parseClock(change.start), duration_minutes: Number(change.duration) || undefined }, true, change.series.version),
      'Future classes moved. Affected coaches are told, and those classes need re-checking.');
    if (result) { setChange(null); setPreview(null); }
  };

  return (
    <section className="space-y-3" aria-labelledby="roster-series">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="roster-series" className={ADMIN_TEXT.sectionHeading}>Repeating classes</h3>
        <AdminButton variant="ghost" onClick={() => setForm(form ? null : blank)}>{form ? 'Cancel' : 'Add repeating class'}</AdminButton>
      </div>
      <p className={ADMIN_TEXT.lede}>Optional. Generating creates normal classes in the class calendar, the same as adding them by hand. Existing one-off classes are never touched.</p>
      {form && (
        <div className="staff-roster-row">
          <div className="min-w-0 w-full grid gap-3 sm:grid-cols-3">
            <AdminFormField label="Title" required><input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></AdminFormField>
            <AdminFormField label="Class type" required><input value={form.class_type} onChange={event => setForm({ ...form, class_type: event.target.value })} /></AdminFormField>
            <AdminFormField label="Start time" required helper="24-hour, e.g. 05:15"><input value={form.start} onChange={event => setForm({ ...form, start: event.target.value })} /></AdminFormField>
            <AdminFormField label="Minutes" required><input type="number" min="1" value={form.duration_minutes} onChange={event => setForm({ ...form, duration_minutes: event.target.value })} /></AdminFormField>
            <AdminFormField label="Capacity" required><input type="number" min="1" value={form.capacity} onChange={event => setForm({ ...form, capacity: event.target.value })} /></AdminFormField>
            <AdminFormField label="From" required><input type="date" value={form.effective_from} onChange={event => setForm({ ...form, effective_from: event.target.value })} /></AdminFormField>
            <fieldset className="sm:col-span-3">
              <legend className="admin-kit-label">Days</legend>
              <div className="flex flex-wrap gap-3">{WEEKDAYS.map((name, index) => (
                <label key={name} className="flex items-center gap-1 font-body text-sm min-h-11"><input type="checkbox" checked={form.weekdays.includes(index)} onChange={event => setForm({ ...form, weekdays: event.target.checked ? [...form.weekdays, index] : form.weekdays.filter(item => item !== index) })} />{name}</label>
              ))}</div>
            </fieldset>
            <label className="flex items-center gap-2 font-body text-sm min-h-11"><input type="checkbox" checked={form.publish_generated} onChange={event => setForm({ ...form, publish_generated: event.target.checked })} />Publish generated classes straight away</label>
            <div className="sm:col-span-3"><AdminButton disabled={busy || !form.title.trim() || !form.class_type.trim() || parseClock(form.start) === null || !form.weekdays.length || !Number(form.duration_minutes) || !Number(form.capacity)} onClick={saveNew}>Save repeating class</AdminButton></div>
          </div>
        </div>
      )}
      {series.length === 0 && !form && <p className="font-body text-sm text-xert-pale/60">None set up. The class calendar works as before without them.</p>}
      <ul className="staff-roster-list">
        {series.map(item => (
          <li key={item.id} className="staff-roster-row">
            <div className="min-w-0">
              <p className="font-body text-sm font-semibold text-xert-offwhite">{item.title} · {minuteLabel(item.start_minute)} · {item.duration_minutes} min</p>
              <p className="font-body text-xs text-xert-pale/60">{item.weekdays.map(day => WEEKDAYS[day]).join(', ')} · from {dayLabel(item.effective_from)}{item.effective_until ? ` until ${dayLabel(item.effective_until)}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <AdminButton variant="ghost" disabled={busy} onClick={() => onMutate(client => client.generateSeries(item.id, today > first ? today : first, last), `Classes generated for ${monthLabel(month)}. Re-running never duplicates.`)}>Generate {monthLabel(month)}</AdminButton>
              <AdminButton variant="ghost" onClick={() => { setChange({ series: item, from: today < first ? first : dateInMonth(addMonths(today.slice(0, 7), 1), 1), start: clockLabel(item.start_minute), duration: String(item.duration_minutes) }); setPreview(null); }}>Change this and future</AdminButton>
            </div>
          </li>
        ))}
      </ul>
      {change && (
        <Notice tone="info" title={`Change ${change.series.title} from a date`}
          action={<div className="flex flex-wrap gap-2">
            <AdminButton variant="ghost" disabled={busy || parseClock(change.start) === null} onClick={runPreview}>Preview</AdminButton>
            <AdminButton disabled={busy || !preview} onClick={apply}>Apply to {preview ? preview.length : 'future'} classes</AdminButton>
            <AdminButton variant="ghost" onClick={() => { setChange(null); setPreview(null); }}>Cancel</AdminButton>
          </div>}>
          <div className="grid gap-3 sm:grid-cols-3 mt-2">
            <AdminFormField label="From date"><input type="date" value={change.from} min={today} onChange={event => { setChange({ ...change, from: event.target.value }); setPreview(null); }} /></AdminFormField>
            <AdminFormField label="New start time"><input value={change.start} onChange={event => { setChange({ ...change, start: event.target.value }); setPreview(null); }} /></AdminFormField>
            <AdminFormField label="Minutes"><input type="number" min="1" value={change.duration} onChange={event => { setChange({ ...change, duration: event.target.value }); setPreview(null); }} /></AdminFormField>
          </div>
          {preview && <p className="mt-2">{preview.length} future classes would move. {preview.filter(item => item.staff_assignments > 0).length} have coaches rostered, who will be told. Past classes keep their history.</p>}
        </Notice>
      )}
    </section>
  );
}

export default function SettingsPanel({ data, month, today, onMutate, onSaveStaffing }) {
  const { snapshot, busy } = data;
  return (
    <div className="space-y-10">
      <GeneralSettings key={snapshot.settings.version} settings={snapshot.settings} month={month} busy={busy} onMutate={onMutate} />
      <ClassTypeStaffing snapshot={snapshot} busy={busy} onSaveStaffing={onSaveStaffing} />
      <SeriesPanel snapshot={snapshot} month={month} today={today} busy={busy} onMutate={onMutate} />
    </div>
  );
}
