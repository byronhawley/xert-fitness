import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AdminButton } from '@/components/admin/ui';
import { rosterSmsSummary } from '@/lib/staffRoster/sms';
import { Notice } from './rosterBits';

/**
 * What happened to the texts for a month's current published version, in
 * plain words, with "Resend failed texts" when any can be tried again.
 * Presentational only; `RosterTexts` below loads and sends.
 */
export function RosterTextsSummary({ status, sending = false, result = null, busy = false, onRetry = null }) {
  if (!status) return sending ? <p className="font-body text-sm text-xert-pale/70" role="status">Sending texts…</p> : null;
  if (!status.enabled) {
    return <p className="font-body text-xs text-xert-pale/55">Texts are off. Turn on “Text coaches when you publish” in Settings to also text coaches their classes.</p>;
  }
  // Texts link to the coach screens, so none are queued while those are off.
  if (status.roster_enabled === false) {
    return <p className="font-body text-xs text-xert-pale/55">No texts were sent: they only go while coach screens are switched on (Settings), because each text links to them.</p>;
  }
  const messages = status.messages || [];
  const waiting = (status.counts?.pending || 0) > 0;
  const tone = (status.counts?.failed || 0) > 0 ? 'danger' : messages.some(row => row.status === 'skipped') || waiting ? 'warning' : 'success';
  return (
    <div className="space-y-2">
      <Notice tone={messages.length ? tone : 'info'} title={messages.length ? `Texts: ${rosterSmsSummary(messages)}` : 'No texts for this version'}
        action={onRetry && status.retryable > 0 ? <AdminButton variant="ghost" disabled={busy || sending} onClick={onRetry}>Resend failed texts</AdminButton> : null}>
        {sending && 'Sending texts…'}
        {!sending && result?.configured === false && 'Texts are waiting: SMS is not set up on the server yet (Twilio settings in Vercel).'}
        {!sending && result?.error && `${result.error} `}
        {!sending && waiting && result?.configured !== false && 'Some texts haven’t gone yet. They’re tried again the next time you open the roster.'}
        {!sending && !waiting && !messages.length && 'Nobody’s classes changed, so nobody was texted.'}
      </Notice>
      {status.retryable > 0 && <p className="font-body text-xs text-xert-pale/55">Fix missing mobile numbers in the coach’s XERT account (Account details), then resend.</p>}
    </div>
  );
}

/**
 * Loads the month's texting state and, when `autoSend` is set and texts are
 * due, asks the server to send them first. Used right after publishing.
 */
export default function RosterTexts({ client, month, autoSend = false }) {
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const load = useCallback(async () => {
    if (!client?.smsStatus) return null;
    try { const next = await client.smsStatus(month); setStatus(next); return next; } catch { return null; }
  }, [client, month]);

  const send = useCallback(async () => {
    setSending(true);
    try { setResult(await client.sendTexts()); } finally { setSending(false); }
    await load();
  }, [client, load]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const first = await load();
      if (autoSend && first?.enabled && first?.due) await send();
    })();
  }, [load, send, autoSend]);

  const retry = async () => {
    setBusy(true);
    try {
      await client.retryTexts(month);
      await send();
    } catch (failure) {
      setResult({ error: failure.message });
    } finally {
      setBusy(false);
    }
  };

  if (!client?.smsStatus) return null;
  return <RosterTextsSummary status={status} sending={sending} result={result} busy={busy} onRetry={retry} />;
}
