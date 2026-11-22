// @ts-nocheck -- cmdk's polymorphic JavaScript wrappers are isolated here.
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'lucide-react';
import { CommandDialog, CommandInput, CommandList, CommandGroup, CommandItem } from '@/components/ui/command';
import { adminSearchMembers } from '@/lib/adminData';
import { ADMIN_QUICK_ACTIONS, ADMIN_WORKSPACES } from '@/lib/adminWorkspaces';
import { rankCommands, readPreferences, recordCommand, savePreferences } from '@/lib/adminCommandSystem';
import { AdminWorkspaceBoundary, retryableLazy as lazy } from './AdminWorkspaceBoundary';

const AdminCommandActions = lazy(() => import('./AdminCommandActions'));
const ACTIONS = [
  { id: 'confirm-booking', label: 'Confirm booking' },
  { id: 'text-class', label: "Text tomorrow’s 6:15am" },
  { id: 'add-attendee', label: 'Add attendee' },
  { id: 'mark-attendance', label: 'Mark attendance' },
  { id: 'publish-form', label: 'Publish form' },
];
const COMMANDS = [...ACTIONS,
  ...ADMIN_QUICK_ACTIONS.map(item => ({ ...item, id: `quick-${item.key}` })),
  ...ADMIN_WORKSPACES.map(item => ({ ...item, id: `go-${item.key}` })),
];

function Highlight({ label, indices }) {
  return <span>{[...label].map((letter, index) => indices.includes(index) ? <mark key={index}>{letter}</mark> : <React.Fragment key={index}>{letter}</React.Fragment>)}</span>;
}

export default function CommandPalette({ open, onOpenChange, onNavigate, onReload }) {
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchError, setMemberSearchError] = useState('');
  const [retry, setRetry] = useState(0);
  const [action, setAction] = useState(null);
  const busy = useRef(false);
  const [history, setHistory] = useState(() => readPreferences().history || []);
  const remember = id => {
    setHistory(current => {
      const next = recordCommand(current, id);
      savePreferences(null, { history: next });
      return next;
    });
  };
  useEffect(() => {
    if (!open) { setQuery(''); setAction(null); setMembers([]); setMemberSearchError(''); setMemberSearchLoading(false); return undefined; }
    const isMemberSearch = /^member\s+/i.test(query);
    const memberQuery = query.replace(/^member\s+/i, '').trim();
    if (!isMemberSearch || memberQuery.length < 2) { setMembers([]); setMemberSearchLoading(false); setMemberSearchError(''); return undefined; }
    if (action) return undefined;
    let active = true;
    setMembers([]); setMemberSearchLoading(true); setMemberSearchError('');
    const timeoutId = window.setTimeout(() => {
      adminSearchMembers(memberQuery, 12)
        .then(results => { if (active) setMembers(results); })
        .catch(error => { if (active) setMemberSearchError(error.message || 'Member search is unavailable.'); })
        .finally(() => { if (active) setMemberSearchLoading(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timeoutId); };
  }, [open, query, action, retry]);
  const run = (sectionKey, params) => {
    const navigated = onNavigate(sectionKey, params);
    if (navigated !== false) onOpenChange(false);
    return navigated;
  };
  const memberSearchRequested = /^member\s+/i.test(query);
  const memberSearchTerm = query.replace(/^member\s+/i, '').trim();
  const commands = useMemo(
    () => open && !memberSearchRequested ? rankCommands(COMMANDS, query, history) : [],
    [open, memberSearchRequested, query, history],
  );
  return <CommandDialog open={open} onOpenChange={value => { if (!busy.current) onOpenChange(value); }} title="Find an owner task" commandProps={{ shouldFilter: false }} plain={Boolean(action)}>
    {action ? <AdminWorkspaceBoundary key={action.id} onReload={onReload}><Suspense fallback={<div className="admin-command-stage" role="status">Loading command options…</div>}><AdminCommandActions command={action} onBack={() => setAction(null)} onComplete={remember} onBusyChange={value => { busy.current = value; }} /></Suspense></AdminWorkspaceBoundary> : <>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Find a task, or type member + name…" inputMode="search" enterKeyHint="search" />
      <CommandList className="admin-command-list overscroll-contain">
        {commands.length > 0 && <CommandGroup heading={query ? 'Matching tasks' : 'Owner tasks'}>{commands.map(command => <CommandItem key={command.id} value={command.id} onSelect={() => {
          if (ACTIONS.some(item => item.id === command.id)) setAction(command);
          else if (run(command.key, command.params) !== false) remember(command.id);
        }}><Highlight label={command.label} indices={command.indices} /></CommandItem>)}</CommandGroup>}
        {members.length > 0 && <CommandGroup heading="Members">{members.map(member => <CommandItem key={member.id} value={member.id} onSelect={() => run('gym-members', { member: member.id })}><User /><span>{member.full_name || member.email}</span></CommandItem>)}</CommandGroup>}
        {commands.length === 0 && members.length === 0 && <div className="admin-command-stage text-sm" role={memberSearchError ? 'alert' : 'status'}>{memberSearchLoading ? 'Searching members...' : memberSearchError || (memberSearchRequested ? memberSearchTerm.length < 2 ? 'Type at least two letters after member.' : 'No matching member.' : 'No matching admin task.')}{memberSearchError && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry member search</button>}</div>}
      </CommandList>
    </>}
  </CommandDialog>;
}
