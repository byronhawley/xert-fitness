import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Download, Printer, ExternalLink, RefreshCw, Search, Users } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { archiveFormResponse, listFormResponses } from '@/lib/xertForms';
import { PAIRS_EVENT_LABEL, PAIRS_FORM_SLUG, pairsEntriesOpen } from '@/lib/pairsCompetition';
import { pairsBoard } from '@/lib/pairsBoard';
import { PAIRS_WORKOUTS, pairsScoreCardsHtml, pairsScoreColumns, pairsRunSheet, pairsScoreSheetRows } from '@/lib/pairsRunSheet';
import { downloadCsv } from '@/lib/csv';
import { gymDateTimeLabel } from '@/lib/gymTime';
import AdminConfirmDialog from './AdminConfirmDialog';
import { ADMIN_BUTTON, ADMIN_INPUT_BARE, ADMIN_PAGE, ADMIN_PANEL, ADMIN_TEXT, AdminPageHeader } from './ui';

// The Pairs competition at a glance: every pair as a card, in its division,
// with counts. Entries are still the Pairs form's responses, so nothing about
// entering changes; this is the view of them built for running the comp.

function PairCard({ card, onArchive }) {
  return (
    <li className={`${ADMIN_PANEL} p-3`} data-pair-card={card.id}>
      <p className="font-display text-xl uppercase tracking-wide text-xert-offwhite break-words">
        {card.teamName || `${card.teammateOne || '?'} & ${card.teammateTwo || '?'}`}
      </p>
      {card.teamName && (
        <p className="mt-0.5 font-body text-sm text-xert-pale break-words">{card.teammateOne} &amp; {card.teammateTwo}</p>
      )}
      {card.extras.map(([label, value]) => (
        <p key={label} className="mt-1 font-body text-xs text-xert-pale/70 break-words">{label}: <span className="text-xert-offwhite">{value}</span></p>
      ))}
      <p className="mt-2 font-body text-xs text-xert-pale/50 break-words">
        Entered by {card.enteredBy || 'unknown'}{card.enteredAt ? ` · ${gymDateTimeLabel(card.enteredAt)}` : ''}
      </p>
      {(card.email || card.phone) && (
        <p className="font-body text-xs text-xert-pale/50 break-all">{[card.email, card.phone].filter(Boolean).join(' · ')}</p>
      )}
      <button type="button" onClick={() => onArchive(card)} className="mt-2 min-h-11 font-body text-xs uppercase tracking-wider text-xert-pale/60 hover:text-status-danger-200">
        Remove entry
      </button>
    </li>
  );
}

function Column({ column }) {
  return (
    <section aria-label={column.label} className="min-w-0">
      <header className="mb-2 flex items-baseline justify-between gap-2 border-b border-white/10 pb-1">
        <h4 className={`font-body text-xs font-semibold uppercase tracking-[0.14em] ${column.unset ? 'text-status-warning-200' : 'text-xert-steel'}`}>{column.label}</h4>
        <span className="font-body text-xs text-xert-pale/60">{column.entries.length} {column.entries.length === 1 ? 'pair' : 'pairs'}</span>
      </header>
      {column.entries.length === 0
        ? <p className="font-body text-xs text-xert-pale/40">No pairs yet.</p>
        : <ul className="space-y-2">{column.entries.map(card => <PairCard key={card.id} card={card} onArchive={column.onArchive} />)}</ul>}
    </section>
  );
}

// The day at a glance: each workout's slots with how many pairs are on the
// floor, and the breaks between.
function RunSheet({ rows }) {
  const workouts = PAIRS_WORKOUTS.map(workout => rows.filter(row => row.workout === workout));
  const breaks = rows.filter(row => row.kind === 'break');
  return (
    <section aria-label="Run sheet" className={`${ADMIN_PANEL} mb-6 p-4`}>
      <h3 className="mb-3 flex items-center gap-2 font-display text-2xl uppercase tracking-wide text-xert-offwhite">
        <Clock className="h-5 w-5 text-xert-steel" aria-hidden="true" /> Run sheet · Sat 19 Dec
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {workouts.map((slots, index) => (
          <div key={PAIRS_WORKOUTS[index]} className="min-w-0 border border-white/10 p-3">
            <p className="mb-2 font-body text-xs font-semibold uppercase tracking-[0.14em] text-xert-steel">Workout {PAIRS_WORKOUTS[index]}</p>
            <ul className="space-y-1.5">
              {slots.map(row => (
                <li key={row.division} className="font-body text-sm">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-xert-offwhite"><span className="tabular-nums text-xert-pale/70">{row.start}</span> {row.division}</span>
                    <span className="shrink-0 text-xs text-xert-pale/60">{row.pairs} {row.pairs === 1 ? 'pair' : 'pairs'}</span>
                  </span>
                  <span className="block text-xs text-xert-pale/50">Judged by {row.judgedBy} · {row.resting} resting</span>
                </li>
              ))}
            </ul>
            {breaks[index] && (
              <p className="mt-2 border-t border-white/10 pt-2 font-body text-xs text-xert-pale/60">
                {breaks[index].start}{breaks[index].end ? `–${breaks[index].end}` : ''} · {breaks[index].label}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const LIVE_SOURCE = Object.freeze({
  async form() {
    const { data, error } = await supabase.from('xert_forms').select('*')
      .eq('slug', PAIRS_FORM_SLUG).is('archived_at', null).maybeSingle();
    if (error) throw error;
    return data || null;
  },
  responses: formId => listFormResponses(formId),
  archive: responseId => archiveFormResponse(responseId),
});

// `source` is only replaced in the browser fixture; the admin uses the live one.
export default function PairsCompBoard({ onNavigate, source = LIVE_SOURCE }) {
  const [form, setForm] = useState(undefined);
  const [responses, setResponses] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [archiving, setArchiving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await source.form();
      setForm(data);
      setResponses(data ? await source.responses(data.id) : []);
      setError('');
    } catch (failure) {
      setError(failure.message || 'The Pairs entries could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [source]);
  useEffect(() => { load(); }, [load]);

  const board = useMemo(() => (form ? pairsBoard(form, responses, search) : null), [form, responses, search]);
  // The run sheet and the spreadsheet always cover every pair, whatever is searched.
  const everyone = useMemo(() => (form ? pairsBoard(form, responses) : null), [form, responses]);
  // A card per pair per workout, opened as its own page to print.
  const printScoreCards = () => {
    const page = window.open('', '_blank');
    if (!page) { setError('Allow pop-ups for this site to print the score cards.'); return; }
    page.document.open();
    page.document.write(pairsScoreCardsHtml(everyone, `Pairs comp ${PAIRS_EVENT_LABEL} score cards`));
    page.document.close();
    page.focus();
    setTimeout(() => page.print(), 300);
  };
  const downloadScoreSheet = () => {
    downloadCsv(`pairs-comp-${PAIRS_EVENT_LABEL.replace(/\./g, '-')}-scores.csv`, pairsScoreSheetRows(everyone), pairsScoreColumns(everyone));
  };

  const archive = async () => {
    setBusy(true);
    try {
      await source.archive(archiving.id);
      setArchiving(null);
      await load();
    } catch (failure) {
      setError(failure.message || 'That entry could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const open = pairsEntriesOpen();
  return (
    <div className={ADMIN_PAGE}>
      <AdminPageHeader eyebrow="Classes" title="Pairs comp" description={`Every pair entered for ${PAIRS_EVENT_LABEL}, sorted into its division. People enter at xertfitness.com.au/pairs.`}>
        <button type="button" className={ADMIN_BUTTON.ghost} onClick={load} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
        <button type="button" className={ADMIN_BUTTON.ghost} onClick={printScoreCards} disabled={!everyone?.total}><Printer className="h-4 w-4" /> Score cards</button>
        <button type="button" className={ADMIN_BUTTON.ghost} onClick={downloadScoreSheet} disabled={!everyone?.total}><Download className="h-4 w-4" /> Score spreadsheet</button>
        <a className={ADMIN_BUTTON.ghost} href="/pairs" target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Entry page</a>
      </AdminPageHeader>

      {error && <p role="alert" className="mb-4 border border-status-warning-300/30 bg-status-warning-300/10 p-3 font-body text-sm text-status-warning-100">{error}</p>}

      {form === undefined && <p role="status" className={ADMIN_TEXT.lede}>Loading entries…</p>}
      {form === null && (
        <p className={ADMIN_TEXT.lede}>There's no Pairs entry form yet. Open xertfitness.com.au/pairs while signed in as an admin to create it.</p>
      )}

      {board && (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <p className="font-display text-3xl text-xert-offwhite" aria-live="polite">
              <Users className="mr-2 inline h-6 w-6 text-xert-steel" aria-hidden="true" />
              {board.total} {board.total === 1 ? 'pair' : 'pairs'}
            </p>
            <span className={`rounded-full border px-3 py-1 font-body text-xs ${open && form.is_active ? 'border-status-success-300/40 text-status-success-200' : 'border-status-warning-300/40 text-status-warning-200'}`}>
              {!form.is_active ? 'Entries switched off' : open ? 'Entries open' : 'Entries closed'}
            </span>
            {board.divisions.filter(item => item.total).map(item => (
              <span key={item.category} className="font-body text-xs text-xert-pale/70">{item.category}: <strong className="text-xert-offwhite">{item.total}</strong></span>
            ))}
            <label className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto sm:min-w-[18rem] sm:max-w-xs">
              <Search className="h-4 w-4 shrink-0 text-xert-pale/50" aria-hidden="true" />
              <input className={`${ADMIN_INPUT_BARE} w-full`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a pair or person" aria-label="Find a pair or person" />
            </label>
          </div>
          {search && <p className="mb-4 font-body text-xs text-xert-pale/60">Showing {board.shown} of {board.total}.</p>}

          <RunSheet rows={pairsRunSheet(everyone)} />

          <div className="space-y-6">
            {board.divisions.map(division => (
              <section key={division.category} aria-label={division.category} className={`${ADMIN_PANEL} p-4`}>
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-2xl uppercase tracking-wide text-xert-offwhite">
                    {division.category}
                    {!division.known && <span className="ml-2 font-body text-xs normal-case text-status-warning-200">(no longer on the form)</span>}
                  </h3>
                  <span className="font-body text-sm text-xert-pale/70">{division.total} {division.total === 1 ? 'pair' : 'pairs'}</span>
                </header>
                <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 16rem), 1fr))` }}>
                  {division.columns.map(column => <Column key={column.key} column={{ ...column, onArchive: setArchiving }} />)}
                </div>
              </section>
            ))}
            {board.uncategorised.length > 0 && (
              <section aria-label="No category" className={`${ADMIN_PANEL} p-4`}>
                <Column column={{ key: 'none', label: 'No category chosen', unset: true, entries: board.uncategorised, onArchive: setArchiving }} />
              </section>
            )}
          </div>

          <p className="mt-6 font-body text-xs text-xert-pale/50">
            To change the questions, open the Pairs form in{' '}
            <button type="button" className="underline hover:text-xert-offwhite" onClick={() => onNavigate?.('forms')}>Forms &amp; surveys</button>.
            New questions show up on the entry page and here automatically.
          </p>
        </>
      )}

      <AdminConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={value => { if (!value) setArchiving(null); }}
        title="Remove this entry?"
        description={archiving ? `${archiving.teamName || `${archiving.teammateOne} & ${archiving.teammateTwo}`} will come off the board, and whoever entered can enter again. The entry is archived, not deleted, so it can be restored from Forms & surveys.` : ''}
        cancelLabel="Keep it"
        confirmLabel="Remove entry"
        busy={busy}
        onConfirm={archive}
      />
    </div>
  );
}
