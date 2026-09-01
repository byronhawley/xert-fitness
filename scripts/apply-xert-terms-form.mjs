import { XERT_TERMS_FORM_DEFINITION, XERT_TERMS_FORM_ID, validateXertTermsFormDefinition } from '../src/lib/xertTermsForm.js';

const apply = process.argv.includes('--apply');
const supabaseURL = process.env.XERT_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.XERT_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseURL || !serviceRoleKey) {
  throw new Error('Set XERT_SUPABASE_URL and XERT_SUPABASE_SERVICE_ROLE_KEY before running this script.');
}

const definitionError = validateXertTermsFormDefinition();
if (definitionError) throw new Error(definitionError);

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json',
};
const endpoint = new URL('/rest/v1/xert_forms', supabaseURL);
endpoint.searchParams.set('id', `eq.${XERT_TERMS_FORM_ID}`);
endpoint.searchParams.set('slug', 'eq.terms-and-conditions');
endpoint.searchParams.set('archived_at', 'is.null');
endpoint.searchParams.set('select', 'id,title,slug,updated_at,response_count,is_active');

const currentResponse = await fetch(endpoint, { headers });
if (!currentResponse.ok) throw new Error(`Could not inspect the Terms form (${currentResponse.status}).`);
const matches = await currentResponse.json();
if (matches.length !== 1) throw new Error(`Expected one active Terms form record; found ${matches.length}.`);

const [current] = matches;
console.log(JSON.stringify({
  mode: apply ? 'apply' : 'check',
  id: current.id,
  currentTitle: current.title,
  nextTitle: XERT_TERMS_FORM_DEFINITION.title,
  responseCountPreserved: current.response_count,
  activeStatePreserved: current.is_active,
  nextFieldCount: XERT_TERMS_FORM_DEFINITION.questions.length,
}, null, 2));

if (!apply) {
  console.log('Dry run only. Re-run with --apply to update this exact record.');
  process.exit(0);
}

const patchEndpoint = new URL(endpoint);
patchEndpoint.searchParams.delete('select');
patchEndpoint.searchParams.set('updated_at', `eq.${current.updated_at}`);
patchEndpoint.searchParams.set('select', 'id,title,slug,updated_at,response_count,is_active');
const updateResponse = await fetch(patchEndpoint, {
  method: 'PATCH',
  headers: { ...headers, Prefer: 'return=representation' },
  body: JSON.stringify(XERT_TERMS_FORM_DEFINITION),
});
if (!updateResponse.ok) throw new Error(`Could not update the Terms form (${updateResponse.status}).`);
const updated = await updateResponse.json();
if (updated.length !== 1) {
  throw new Error('The Terms form changed during this update. Nothing was overwritten; inspect and retry.');
}
console.log(JSON.stringify({
  updated: true,
  id: updated[0].id,
  title: updated[0].title,
  responseCountPreserved: updated[0].response_count,
  activeStatePreserved: updated[0].is_active,
  updatedAt: updated[0].updated_at,
}, null, 2));
