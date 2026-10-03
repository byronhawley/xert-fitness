import React, { useState } from 'react';
import { AdminButton, AdminFormField } from '@/components/admin/ui';
import { ROLE_LABELS, STAFF_ROLES } from '@/lib/staffRoster/duty';

function nextKey(slots, role) {
  for (let index = 1; index < 20; index++) {
    const key = index === 1 ? role : `${role}-${index}`;
    if (!slots.some(slot => slot.key === key)) return key;
  }
  return `${role}-${Date.now() % 1000}`;
}

/**
 * Positions for a class or class type. Nothing here assumes one coach per
 * class: a class can need a lead, an assistant, an optional shadow, or more.
 */
export default function StaffingEditor({ staffing, onSave, busy, allowReset = false, resetLabel = 'Reset to default' }) {
  const [slots, setSlots] = useState(staffing.slots.map(slot => ({ ...slot, capabilities: slot.capabilities.map(item => item.replace(/_/g, ' ')).join(', ') })));
  const [prep, setPrep] = useState(String(staffing.prepMinutes || 0));
  const [wrap, setWrap] = useState(String(staffing.wrapMinutes || 0));
  const [allowBlock, setAllowBlock] = useState(staffing.allowBlock !== false);
  const update = (index, patch) => setSlots(list => list.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  const payload = () => ({
    slots: slots.map(slot => ({
      key: slot.key, role: slot.role, required: slot.role === 'shadow' ? false : slot.required,
      capabilities: String(slot.capabilities || '').split(',').map(item => item.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean),
    })),
    prep_minutes: Number(prep) || 0,
    wrap_minutes: Number(wrap) || 0,
    allow_block: allowBlock,
  });

  return (
    <div className="space-y-3 mt-2">
      <ul className="staff-roster-list" aria-label="Coaches needed">
        {slots.map((slot, index) => (
          <li key={slot.key} className="staff-roster-row">
            <div className="min-w-0 grid gap-2 sm:grid-cols-3">
              <AdminFormField label={`Coach ${index + 1}`}>
                <select value={slot.role} onChange={event => update(index, { role: event.target.value })}>
                  {STAFF_ROLES.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                </select>
              </AdminFormField>
              <AdminFormField label="Needs qualification" helper="Optional, e.g. first aid">
                <input value={slot.capabilities} onChange={event => update(index, { capabilities: event.target.value })} />
              </AdminFormField>
              <label className="flex items-center gap-2 font-body text-sm text-xert-pale self-end min-h-11">
                <input type="checkbox" checked={slot.role !== 'shadow' && slot.required} disabled={slot.role === 'shadow'}
                  onChange={event => update(index, { required: event.target.checked })} />
                {slot.role === 'shadow' ? 'Shadows are never required' : 'Required'}
              </label>
            </div>
            <AdminButton variant="ghost" disabled={slots.length === 1} onClick={() => setSlots(list => list.filter((_, i) => i !== index))} aria-label={`Remove coach ${index + 1}`}>Remove</AdminButton>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {STAFF_ROLES.map(role => <AdminButton key={role} variant="ghost" disabled={slots.length >= 8} onClick={() => setSlots(list => [...list, { key: nextKey(list, role), role, required: role !== 'shadow', capabilities: '' }])}>Add {ROLE_LABELS[role].toLowerCase()}</AdminButton>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminFormField label="Minutes before class" helper="Setting up">
          <input type="number" min="0" max="240" inputMode="numeric" value={prep} onChange={event => setPrep(event.target.value)} />
        </AdminFormField>
        <AdminFormField label="Minutes after class" helper="Packing down">
          <input type="number" min="0" max="240" inputMode="numeric" value={wrap} onChange={event => setWrap(event.target.value)} />
        </AdminFormField>
        <label className="flex items-center gap-2 font-body text-sm text-xert-pale self-end min-h-11">
          <input type="checkbox" checked={allowBlock} onChange={event => setAllowBlock(event.target.checked)} />
          Back-to-back classes may share setup time
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <AdminButton disabled={busy} onClick={() => onSave(payload())}>Save coaches needed</AdminButton>
        {allowReset && <AdminButton variant="ghost" disabled={busy} onClick={() => onSave(null)}>{resetLabel}</AdminButton>}
      </div>
    </div>
  );
}
