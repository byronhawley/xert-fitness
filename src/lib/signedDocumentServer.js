// ─── Sending the signed PDF ─────────────────────────────────────────────────
// When somebody submits a form that sends a signed PDF, the database calls
// this (POST /api/push-subscription?action=signed_document) with the response
// id. It reads that response with the service key, lays it out as the PDF the
// person signed, and hands the PDF back to the database to send in the copy
// email.
//
// It shares push-subscription's function, the way the staff roster dispatcher
// does, because the Hobby plan stops at twelve.
//
// There is no secret on this, deliberately: the database decides everything.
// xert_signed_document_source returns a response only while it is fresh, on a
// form with PDF copies switched on, and not yet emailed, and the email only
// ever goes to that response's own respondent, once. So the most a stranger
// holding a valid response id could do is send that person their copy early.
// The id itself is a random UUID that only the database and the submitter know.
//
// If anything here fails, nothing is lost: the database sends the copy without
// the PDF a few minutes later (send_overdue_signed_document_copies).

import { createClient } from '@supabase/supabase-js';
import { requestJson, sendJson } from './serverHttp.js';

export const SIGNED_DOCUMENT_ACTION = 'signed_document';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export async function signedDocumentHandler(request, response, {
  createAdmin = createClient,
  render = null,
  env = process.env,
} = {}) {
  const json = (body, status = 200) => sendJson(response, body, status);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await requestJson(request); } catch { return json({ error: 'Invalid request.' }, 400); }
  const responseId = String(body?.response_id || '').trim();
  if (!UUID.test(responseId)) return json({ error: 'Invalid request.' }, 400);

  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Not configured.' }, 503);

  try {
    const admin = createAdmin(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: source, error: sourceError } = await admin.rpc('xert_signed_document_source', { p_response_id: responseId });
    if (sourceError) throw sourceError;
    // Already sent, too old, or not a form that sends a PDF: nothing to do.
    if (!source) return json({ status: 'skipped' });

    // Loaded only on this path, so registering a phone for push is not slowed
    // by a PDF library it never uses.
    const { renderSignedDocumentPdf, signedDocumentFileName } = render || await import('./signedDocumentPdf.js');
    const pdf = await renderSignedDocumentPdf(source);
    const { data: sent, error: sendError } = await admin.rpc('send_signed_document_copy', {
      p_response_id: responseId,
      p_pdf_base64: base64(pdf),
      p_pdf_filename: signedDocumentFileName(source),
    });
    if (sendError) throw sendError;
    return json({ status: sent ? 'sent' : 'skipped' });
  } catch {
    // The database's own fallback still sends the copy, without the PDF.
    return json({ error: 'The signed copy could not be prepared.' }, 500);
  }
}
