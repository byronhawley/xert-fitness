-- A 10 Session Pack bought on the visitor's own phone at /10pack, the same way
-- /3daypass works: a payment record and an owner alert, nothing else. No
-- account, no order, no member credits; the team arranges the sessions from
-- the receipt. Like the Three Day Pass it needs the casual pre-exercise
-- questionnaire, signed as part of the purchase or declared already signed and
-- looked up by email, so both existing proof lookups are reused unchanged.
--
-- Purely additive and safe to run twice. The checkout refuses a 10 Session
-- Pack until the capability row at the bottom exists, and that row is written
-- only after the pass kind, the price and the owner alert are in place, so a
-- paid pack always has somewhere to be recorded.

-- Refuse to run on a database missing what this builds on, rather than
-- publishing a pack the webhook could not record or the alert could not word.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'casual_visit_payments' and column_name = 'pass_kind'
  ) then
    raise exception 'Apply supabase/migrations/20260908010000_three_day_visitor_pass.sql before the 10 Session Pack.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'casual_visit_payments' and column_name = 'paperwork_verified'
  ) then
    raise exception 'Apply supabase/migrations/20260908060000_three_month_membership.sql before the 10 Session Pack.';
  end if;
  if to_regprocedure('public.xert_visitor_questionnaire_completed(uuid,text,text,text)') is null
    or to_regprocedure('public.xert_visitor_questionnaire_signed(text)') is null then
    raise exception 'Apply supabase/migrations/20260914020000_visitor_pass_already_signed.sql before the 10 Session Pack.';
  end if;
  if to_regprocedure('public.email_owner_alert(text,text,text,text,text)') is null
    or to_regprocedure('public.email_escape(text)') is null then
    raise exception 'The owner alert helpers (email_owner_alert, email_escape) are missing.';
  end if;
end;
$$;

-- The new pass kind. Replaces the list from
-- 20260908060000_three_month_membership.sql and keeps every kind it allowed,
-- so every existing row and every other pass still records.
alter table public.casual_visit_payments drop constraint if exists casual_visit_pass_kind_check;
alter table public.casual_visit_payments add constraint casual_visit_pass_kind_check
  check (pass_kind in ('casual', 'three_day_pass', 'three_month_membership', 'ten_session_pack'));

comment on column public.casual_visit_payments.paperwork_verified is
  'For a Three Day Pass, 10 Session Pack or membership purchase where the buyer declared they had already signed: true when the matching signed paperwork was found, false when it was not. Null when they signed as part of the purchase.';

-- Price and optional discount, editable in admin Settings. $122.40 is $120
-- plus Stripe's card fee. As with the other visitor passes the discount is the
-- price actually charged while it runs, not a percentage.
alter table public.admin_settings
  add column if not exists ten_session_pack_price_cents integer not null default 12240,
  add column if not exists ten_session_pack_discount_cents integer,
  add column if not exists ten_session_pack_discount_enabled boolean not null default false;

-- The same $1 to $1,000 bounds and the same "a running discount must exist and
-- be cheaper" rule as visitor_pass_price_bounds and
-- visitor_pass_discount_is_a_discount. Kept as separate constraints so the
-- ones the casual visit, Three Day Pass and three month membership rely on are
-- never dropped or rewritten here.
alter table public.admin_settings drop constraint if exists ten_session_pack_price_bounds;
alter table public.admin_settings add constraint ten_session_pack_price_bounds check (
  ten_session_pack_price_cents between 100 and 100000
  and (ten_session_pack_discount_cents is null or ten_session_pack_discount_cents between 100 and 100000)
);

alter table public.admin_settings drop constraint if exists ten_session_pack_discount_is_a_discount;
alter table public.admin_settings add constraint ten_session_pack_discount_is_a_discount check (
  ten_session_pack_discount_enabled is not true
  or (ten_session_pack_discount_cents is not null
    and ten_session_pack_discount_cents < ten_session_pack_price_cents)
);

comment on column public.admin_settings.ten_session_pack_price_cents is
  'Full price of the 10 Session Pack, in cents. The server reads this; the browser never sets it.';
comment on column public.admin_settings.ten_session_pack_discount_cents is
  'What a 10 Session Pack costs while its discount is switched on. Null means no discount is set up.';

-- The owner alert. Replaces the version in
-- 20260914020000_visitor_pass_already_signed.sql with every existing branch
-- kept word for word; the 10 Session Pack gets its own label and the same
-- three notes the Three Day Pass has. Without this a paid pack would arrive as
-- "Casual visit paid ... Check them in as usual." The trigger from
-- 20260905010000_casual_visit_payments.sql stays bound to this function.
create or replace function public.email_on_casual_visit_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := case new.pass_kind
    when 'three_day_pass' then 'Three Day Pass'
    when 'three_month_membership' then 'Three month membership'
    when 'ten_session_pack' then '10 Session Pack'
    else 'Casual visit' end;
  v_purchase text := case new.pass_kind
    when 'three_day_pass' then 'a Three Day Pass'
    when 'three_month_membership' then 'a three month membership'
    when 'ten_session_pack' then 'a 10 Session Pack'
    else 'a casual visit' end;
  v_note text := case
    when new.pass_kind = 'three_day_pass' and new.paperwork_verified is false
      then '<p>Three Day Pass. <strong>They said they had already completed the pre-exercise questionnaire, but no signed questionnaire was found under this email.</strong> Check with them before their first session. This payment does not create member credits.</p>'
    when new.pass_kind = 'three_day_pass' and new.paperwork_verified is true
      then '<p>Three Day Pass. Their signed pre-exercise questionnaire is on file. Confirm the receipt and arrange their visits; this payment does not create member credits.</p>'
    when new.pass_kind = 'three_day_pass'
      then '<p>Three Day Pass. Confirm the receipt and arrange their visits; this payment does not create member credits.</p>'
    when new.pass_kind = 'three_month_membership' and new.paperwork_verified is false
      then '<p><strong>They said they had already signed, but no matching questionnaire and agreement were found under this email.</strong> Check with them before their first session.</p>'
    when new.pass_kind = 'three_month_membership' and new.paperwork_verified is true
      then '<p>Their signed questionnaire and agreement are both on file. Set the membership up in FitBox.</p>'
    when new.pass_kind = 'three_month_membership'
      then '<p>They signed the questionnaire and agreement as part of this purchase. Set the membership up in FitBox.</p>'
    when new.pass_kind = 'ten_session_pack' and new.paperwork_verified is false
      then '<p>10 Session Pack. <strong>They said they had already completed the pre-exercise questionnaire, but no signed questionnaire was found under this email.</strong> Check with them before their first session. This payment does not create member credits.</p>'
    when new.pass_kind = 'ten_session_pack' and new.paperwork_verified is true
      then '<p>10 Session Pack. Their signed pre-exercise questionnaire is on file. Confirm the receipt and arrange their sessions; this payment does not create member credits.</p>'
    when new.pass_kind = 'ten_session_pack'
      then '<p>10 Session Pack. Confirm the receipt and arrange their sessions; this payment does not create member credits.</p>'
    else '<p>They completed the payment on their own phone. Check them in as usual.</p>' end;
begin
  begin
    perform public.email_owner_alert(
      'owner_alerts', v_label || ' paid: ' || new.full_name,
      '<p>' || public.email_escape(new.full_name) || ' (' || public.email_escape(new.email)
        || coalesce(', ' || public.email_escape(nullif(new.phone, '')), '')
        || ') paid ' || to_char(new.amount_cents / 100.0, 'FM$999990.00') || ' for ' || v_purchase || '.</p>'
        || v_note,
      'casual_visit_payments', new.id::text
    );
  exception when others then
    raise notice 'visitor payment owner alert skipped: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Fail this migration itself, before the capability is published, if the pass
-- kinds lost one of the existing passes or the alert is no longer wired up.
do $$
declare
  v_kinds text;
begin
  select pg_catalog.pg_get_constraintdef(c.oid) into v_kinds
  from pg_catalog.pg_constraint c
  where c.conrelid = 'public.casual_visit_payments'::regclass
    and c.conname = 'casual_visit_pass_kind_check';
  if v_kinds is null
    or v_kinds not like '%''casual''%'
    or v_kinds not like '%''three_day_pass''%'
    or v_kinds not like '%''three_month_membership''%'
    or v_kinds not like '%''ten_session_pack''%' then
    raise exception 'The visitor pass kinds must keep every existing pass and add the 10 Session Pack.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.casual_visit_payments'::regclass
      and t.tgname = 'email_on_casual_visit_payment'
      and t.tgfoid = 'public.email_on_casual_visit_payment()'::regprocedure
      and not t.tgisinternal
  ) then
    raise exception 'The visitor payment owner alert trigger is missing; reapply 20260905010000_casual_visit_payments.sql.';
  end if;
end;
$$;

-- Publish readiness last: the checkout gates the 10 Session Pack on this row.
insert into public.xert_schema_capabilities (capability)
values ('ten_session_pack') on conflict (capability) do nothing;

-- The live API once kept serving a stale schema for a week. Reload it now so
-- the new settings columns can be read and saved straight away.
notify pgrst, 'reload schema';
