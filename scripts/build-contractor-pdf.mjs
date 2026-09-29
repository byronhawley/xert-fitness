#!/usr/bin/env node
// Produce the contractor agreement as a PDF.
//
//   node scripts/build-contractor-pdf.mjs --blank  out.pdf
//   node scripts/build-contractor-pdf.mjs --signed out.pdf --response <uuid>
//
// The blank one is the fillable version, and needs nothing but this repo. The
// signed one reads a response, so it needs SUPABASE_URL and a service key, or
// SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF to go via the Management API.

import { readFile, writeFile } from 'node:fs/promises';
import { renderContractorPdf } from '../src/lib/contractorPdf.js';
import { XERT_CONTRACTOR_QUALIFICATIONS, XERT_CONTRACTOR_SERVICES } from '../src/lib/xertContractorAgreement.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : args[at + 1];
};
// Only --response takes a value, so everything else bare is the output path.
const VALUE_FLAGS = new Set(['--response']);
const positional = args.filter((arg, index) =>
  !arg.startsWith('--') && !VALUE_FLAGS.has(args[index - 1]));

// Byron signs every copy for XERT Fitness: the blank one to print, and the
// signed one even if the response predates his signature being stored on it.
const PRESIGNED = {
  'ic-98-owner-signature': await readFile(new URL('../public/assets/signatures/byron-hawley.png', import.meta.url)),
};

const QUALIFICATION_ID = 'ic-08-qualifications';
const SERVICE_ID = 'ic-09-service';
const ACCEPT_ID = 'ic-91-accept';
const MARKETING_ID = 'ic-95-marketing';

async function queryManagementApi(sql) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) return null;
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!response.ok) throw new Error(`Management API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadResponse(id) {
  const rows = await queryManagementApi(`
    select r.answers, r.form_snapshot, r.respondent_name, r.respondent_email
    from public.xert_form_responses r
    where r.id = '${id.replace(/'/g, "''")}'
  `);
  if (!rows?.length) throw new Error(`No response ${id}`);
  return rows[0];
}

/** Pull the answers out of a response into what the renderer expects. */
export function shapeResponse(row) {
  const answers = row.answers || {};
  const read = id => {
    const raw = answers[id];
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.join(', ');
    if (typeof raw === 'object') {
      // Name and address fields arrive as parts; join them the way they read.
      const parts = ['first', 'last', 'line1', 'line2', 'suburb', 'city', 'state', 'postcode', 'country']
        .map(key => raw[key]).filter(Boolean);
      return parts.length ? parts.join(' ') : Object.values(raw).filter(Boolean).join(' ');
    }
    return String(raw);
  };

  const signatures = {};
  for (const id of ['ic-93-contractor-signature', 'ic-98-owner-signature']) {
    const raw = answers[id];
    if (typeof raw === 'string' && raw.startsWith('data:image/png;base64,')) {
      signatures[id] = Buffer.from(raw.slice('data:image/png;base64,'.length), 'base64');
    }
  }

  const ticked = answers[QUALIFICATION_ID];
  return {
    values: Object.fromEntries(
      ['ic-01-name', 'ic-02-address', 'ic-03-abn', 'ic-04-business-name', 'ic-05-phone',
        'ic-06-email', 'ic-92-contractor-name', 'ic-94-commencement'].map(id => [id, read(id)])),
    qualifications: Array.isArray(ticked) ? ticked : [ticked].filter(Boolean),
    service: read(SERVICE_ID) || null,
    businessType: read('ic-04b-business-type') || null,
    accepted: read(ACCEPT_ID) || null,
    marketing: read(MARKETING_ID) || null,
    signatures: Object.keys(signatures).length ? signatures : null,
  };
}

const out = positional[0] || (flag('signed') ? 'contractor-signed.pdf' : 'contractor-blank.pdf');

if (flag('signed')) {
  const id = value('response');
  if (!id) {
    console.error('--signed needs --response <uuid>');
    process.exit(1);
  }
  const bytes = await renderContractorPdf({ mode: 'signed', presigned: PRESIGNED, ...shapeResponse(await loadResponse(id)) });
  await writeFile(out, bytes);
  console.log(`Signed agreement: ${out} (${bytes.length} bytes)`);
} else if (flag('demo')) {
  // A filled-in example, for checking the layout without touching the database.
  const bytes = await renderContractorPdf({
    mode: 'signed',
    values: {
      'ic-01-name': 'Jordan Avery', 'ic-02-address': '12 Pound St, Kingaroy QLD 4610',
      'ic-03-abn': '12 345 678 901', 'ic-04-business-name': 'Avery Strength',
      'ic-05-phone': '0400 000 000', 'ic-06-email': 'jordan@example.com',
      'ic-92-contractor-name': 'Jordan Avery', 'ic-94-commencement': '25 September 2026',
    },
    qualifications: [XERT_CONTRACTOR_QUALIFICATIONS[0], XERT_CONTRACTOR_QUALIFICATIONS[3],
      XERT_CONTRACTOR_QUALIFICATIONS[4]],
    service: XERT_CONTRACTOR_SERVICES[0], businessType: 'Pty Ltd',
    accepted: 'I accept this agreement', marketing: 'Yes, I consent',
    presigned: PRESIGNED,
  });
  await writeFile(out, bytes);
  console.log(`Demo agreement: ${out} (${bytes.length} bytes)`);
} else {
  const bytes = await renderContractorPdf({ mode: 'interactive', presigned: PRESIGNED });
  await writeFile(out, bytes);
  console.log(`Fillable agreement: ${out} (${bytes.length} bytes)`);
}
