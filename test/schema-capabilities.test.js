import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeSchemaCapabilities } from '../src/lib/schemaCapabilities.js';

test('reports the exact missing production database capabilities', () => {
  assert.deepEqual(summarizeSchemaCapabilities([{ capability: 'admin_role_safety' }]), {
    installed: ['admin_role_safety'],
    missing: ['audited_credit_grants', 'booking_waitlist_withdrawal', 'member_cancellation_receipt', 'member_booking_switch_guard', 'member_onboarding_foundation', 'member_activation_cockpit', 'member_waitlist_join', 'waitlist_fifo_promotion', 'attendance_roll_call', 'attendance_request_resolution_guard', 'class_session_update_guard', 'product_update_guard', 'stripe_refund_reconciliation', 'checkout_reconciliation', 'stripe_payment_fulfillment', 'guarded_payment_activation', 'payment_activation_drift_guard', 'admin_settings_singleton', 'stripe_pending_order_guard', 'stripe_order_terms_snapshot', 'stripe_webhook_ledger', 'member_announcements', 'announcement_receipts', 'announcement_actions', 'announcement_archival', 'booking_time_conflict_guard', 'admin_member_notes', 'schedule_blackout_guard', 'database_security_hardening', 'rls_policy_performance', 'request_status_audit', 'member_push_notifications', 'credit_expiry_follow_up', 'member_pt_request_tracking', 'public_form_integrity', 'lead_pipeline_audit', 'schedule_change_audit', 'content_change_audit', 'booking_lifecycle_audit', 'class_cancellation_notifications', 'admin_daily_operations', 'schedule_optimistic_locking', 'shared_admin_optimistic_locking', 'catalog_optimistic_locking', 'product_commercial_terms_guard', 'targeted_member_notices', 'waitlist_promotion_notifications', 'booking_decision_notifications', 'staff_assisted_booking', 'owner_stripe_price_provisioning', 'forms_surveys_builder', 'form_response_snapshots', 'fitbox_zapier_bridge', 'fitbox_get_user_refresh', 'fitbox_live_mirror', 'email_notifications', 'form_prerequisites', 'casual_visit_payments', 'booking_integrity_overhaul', 'booking_overhaul_repair', 'booking_repair_followups'],
    ready: false,
    actions: [
      'Apply supabase/migrations/20260714005500_credit_grant_audit.sql in Supabase.',
      'Reapply src/supabase/booking_modes_upgrade.sql in Supabase, then reapply supabase/migrations/20260906020000_booking_overhaul_repair.sql.',
      'Apply supabase/migrations/20260727030000_member_cancellation_receipt.sql in Supabase.',
      'Apply supabase/migrations/20260721000000_member_booking_switch_guard.sql in Supabase.',
      'Apply supabase/migrations/20260721010000_member_onboarding_foundation.sql in Supabase.',
      'Apply supabase/migrations/20260721020000_member_activation_cockpit.sql in Supabase.',
      'Apply src/supabase/member_waitlist_upgrade.sql in Supabase.',
      'Apply supabase/migrations/20260714004100_waitlist_fifo_promotion.sql in Supabase.',
      'Apply src/supabase/attendance_roll_call_upgrade.sql in Supabase.',
      'Apply supabase/migrations/20260727020000_attendance_request_resolution_guard.sql in Supabase.',
      'Apply supabase/migrations/20260713000000_class_session_update_guard.sql in Supabase.',
      'Apply supabase/migrations/20260713010000_product_update_guard.sql in Supabase.',
      'Apply supabase/migrations/20260713020000_stripe_refund_reconciliation.sql in Supabase.',
      'Apply supabase/migrations/20260713030000_checkout_reconciliation.sql in Supabase.',
      'Apply supabase/migrations/20260715010000_stripe_payment_fulfillment.sql in Supabase.',
      'Apply supabase/migrations/20260716010000_guarded_payment_activation.sql in Supabase.',
      'Apply supabase/migrations/20260716060000_payment_activation_drift_guard.sql in Supabase.',
      'Apply supabase/migrations/20260716020000_admin_settings_singleton.sql in Supabase.',
      'Apply supabase/migrations/20260716030000_stripe_pending_order_guard.sql in Supabase.',
      'Apply supabase/migrations/20260716040000_stripe_order_terms_snapshot.sql in Supabase.',
      'Apply supabase/migrations/20260716050000_stripe_webhook_ledger.sql in Supabase.',
      'Apply supabase/migrations/20260713040000_member_announcements.sql in Supabase.',
      'Apply supabase/migrations/20260713050000_announcement_receipts.sql in Supabase.',
      'Apply supabase/migrations/20260714000000_announcement_actions.sql in Supabase.',
      'Apply supabase/migrations/20260714010000_announcement_archival.sql in Supabase.',
      'Apply supabase/migrations/20260714002000_booking_time_conflicts.sql in Supabase.',
      'Apply supabase/migrations/20260714003000_admin_member_notes.sql in Supabase.',
      'Apply supabase/migrations/20260714004000_schedule_blackout_guard.sql in Supabase.',
      'Apply supabase/migrations/20260714006000_database_security_hardening.sql in Supabase.',
      'Apply supabase/migrations/20260714007000_rls_policy_performance.sql in Supabase.',
      'Apply supabase/migrations/20260714008000_admin_request_status_audit.sql in Supabase.',
      'Apply supabase/migrations/20260714009000_member_push_notifications.sql in Supabase.',
      'Apply supabase/migrations/20260713060000_credit_expiry_follow_up.sql in Supabase.',
      'Apply supabase/migrations/20260714004200_member_pt_request_tracking.sql in Supabase.',
      'Apply supabase/migrations/20260714004300_public_form_integrity.sql in Supabase.',
      'Apply supabase/migrations/20260714011000_lead_pipeline_audit.sql in Supabase.',
      'Apply supabase/migrations/20260714012000_schedule_change_audit.sql in Supabase.',
      'Apply supabase/migrations/20260714013000_content_change_audit.sql in Supabase.',
      'Apply supabase/migrations/20260714014000_booking_lifecycle_audit.sql in Supabase.',
      'Apply supabase/migrations/20260714015000_class_cancellation_notifications.sql in Supabase.',
      'Apply supabase/migrations/20260714016000_admin_daily_operations.sql in Supabase.',
      'Apply supabase/migrations/20260714018000_schedule_optimistic_locking.sql in Supabase.',
      'Apply supabase/migrations/20260714019000_shared_admin_optimistic_locking.sql in Supabase.',
      'Apply supabase/migrations/20260714020000_catalog_optimistic_locking.sql in Supabase.',
      'Apply supabase/migrations/20260720000000_product_commercial_terms_guard.sql in Supabase.',
      'Apply supabase/migrations/20260714021000_targeted_member_notices.sql in Supabase.',
      'Apply supabase/migrations/20260721030000_waitlist_promotion_notifications.sql in Supabase.',
      'Apply supabase/migrations/20260722000000_booking_decision_notifications.sql in Supabase.',
      'Apply supabase/migrations/20260727010000_staff_assisted_booking.sql in Supabase.',
      'Apply supabase/migrations/20260722010000_owner_stripe_price_provisioning.sql in Supabase.',
      'Apply supabase/migrations/20260811010000_xert_forms_surveys.sql in Supabase.',
      'Apply the 20260813010000 and 20260813020000 form response migrations in Supabase.',
      'Apply supabase/migrations/20260902010000_fitbox_zapier_bridge.sql in Supabase.',
      'Apply supabase/migrations/20260902020000_fitbox_get_user_refresh.sql in Supabase.',
      'Apply supabase/migrations/20260903000000_fitbox_live_mirror.sql in Supabase.',
      'Apply supabase/migrations/20260903010000_email_notifications.sql in Supabase.',
      'Apply supabase/migrations/20260904010000_form_prerequisites.sql in Supabase.',
      'Apply supabase/migrations/20260905010000_casual_visit_payments.sql in Supabase.',
      'Apply supabase/migrations/20260906010000_booking_integrity_overhaul.sql in Supabase.',
      'Apply supabase/migrations/20260906020000_booking_overhaul_repair.sql in Supabase.',
      'Apply supabase/migrations/20260906030000_booking_repair_followups.sql in Supabase.',
    ],
  });
  assert.equal(summarizeSchemaCapabilities([
    { capability: 'audited_credit_grants' },
    { capability: 'attendance_roll_call' },
    { capability: 'attendance_request_resolution_guard' },
    { capability: 'class_session_update_guard' },
    { capability: 'product_update_guard' },
    { capability: 'stripe_refund_reconciliation' },
    { capability: 'checkout_reconciliation' },
    { capability: 'stripe_payment_fulfillment' },
    { capability: 'guarded_payment_activation' },
    { capability: 'payment_activation_drift_guard' },
    { capability: 'admin_settings_singleton' },
    { capability: 'stripe_pending_order_guard' },
    { capability: 'stripe_order_terms_snapshot' },
    { capability: 'stripe_webhook_ledger' },
    { capability: 'member_announcements' },
    { capability: 'announcement_receipts' },
    { capability: 'announcement_actions' },
    { capability: 'announcement_archival' },
    { capability: 'booking_time_conflict_guard' },
    { capability: 'admin_member_notes' },
    { capability: 'schedule_blackout_guard' },
    { capability: 'database_security_hardening' },
    { capability: 'rls_policy_performance' },
    { capability: 'request_status_audit' },
    { capability: 'member_push_notifications' },
    { capability: 'credit_expiry_follow_up' },
    { capability: 'booking_waitlist_withdrawal' },
    { capability: 'member_cancellation_receipt' },
    { capability: 'member_booking_switch_guard' },
    { capability: 'member_onboarding_foundation' },
    { capability: 'member_activation_cockpit' },
    { capability: 'member_waitlist_join' },
    { capability: 'waitlist_fifo_promotion' },
    { capability: 'member_pt_request_tracking' },
    { capability: 'public_form_integrity' },
    { capability: 'lead_pipeline_audit' },
    { capability: 'schedule_change_audit' },
    { capability: 'content_change_audit' },
    { capability: 'booking_lifecycle_audit' },
    { capability: 'class_cancellation_notifications' },
    { capability: 'admin_daily_operations' },
    { capability: 'schedule_optimistic_locking' },
    { capability: 'shared_admin_optimistic_locking' },
    { capability: 'catalog_optimistic_locking' },
    { capability: 'product_commercial_terms_guard' },
    { capability: 'targeted_member_notices' },
    { capability: 'waitlist_promotion_notifications' },
    { capability: 'booking_decision_notifications' },
    { capability: 'staff_assisted_booking' },
    { capability: 'owner_stripe_price_provisioning' },
    { capability: 'forms_surveys_builder' },
    { capability: 'form_response_snapshots' },
    { capability: 'fitbox_zapier_bridge' },
    { capability: 'fitbox_get_user_refresh' },
    { capability: 'fitbox_live_mirror' },
    { capability: 'email_notifications' },
    { capability: 'form_prerequisites' },
    { capability: 'casual_visit_payments' },
    { capability: 'booking_integrity_overhaul' },
    { capability: 'booking_overhaul_repair' },
    { capability: 'booking_repair_followups' },
    { capability: 'admin_role_safety' },
  ]).ready, true);
});

test('fresh and upgrade SQL paths register the same capability contract', () => {
  const pairs = [
    ['../src/supabase/credit_grant_audit_upgrade.sql', 'audited_credit_grants'],
    ['../supabase/migrations/20260714005500_credit_grant_audit.sql', 'audited_credit_grants'],
    ['../src/supabase/booking_schema.sql', 'booking_waitlist_withdrawal'],
    ['../src/supabase/booking_modes_upgrade.sql', 'booking_waitlist_withdrawal'],
    ['../src/supabase/booking_schema.sql', 'member_cancellation_receipt'],
    ['../src/supabase/booking_modes_upgrade.sql', 'member_cancellation_receipt'],
    ['../supabase/migrations/20260727030000_member_cancellation_receipt.sql', 'member_cancellation_receipt'],
    ['../src/supabase/member_booking_switch_guard_upgrade.sql', 'member_booking_switch_guard'],
    ['../supabase/migrations/20260721000000_member_booking_switch_guard.sql', 'member_booking_switch_guard'],
    ['../src/supabase/member_onboarding_upgrade.sql', 'member_onboarding_foundation'],
    ['../supabase/migrations/20260721010000_member_onboarding_foundation.sql', 'member_onboarding_foundation'],
    ['../src/supabase/member_activation_cockpit_upgrade.sql', 'member_activation_cockpit'],
    ['../supabase/migrations/20260721020000_member_activation_cockpit.sql', 'member_activation_cockpit'],
    ['../src/supabase/booking_schema.sql', 'member_waitlist_join'],
    ['../src/supabase/member_waitlist_upgrade.sql', 'member_waitlist_join'],
    ['../src/supabase/admin_cms_schema.sql', 'waitlist_fifo_promotion'],
    ['../src/supabase/waitlist_fifo_promotion_upgrade.sql', 'waitlist_fifo_promotion'],
    ['../supabase/migrations/20260714004100_waitlist_fifo_promotion.sql', 'waitlist_fifo_promotion'],
    ['../src/supabase/admin_cms_schema.sql', 'admin_role_safety'],
    ['../src/supabase/admin_role_safety_upgrade.sql', 'admin_role_safety'],
    ['../src/supabase/admin_cms_schema.sql', 'attendance_roll_call'],
    ['../src/supabase/attendance_roll_call_upgrade.sql', 'attendance_roll_call'],
    ['../src/supabase/admin_cms_schema.sql', 'attendance_request_resolution_guard'],
    ['../src/supabase/attendance_roll_call_upgrade.sql', 'attendance_request_resolution_guard'],
    ['../supabase/migrations/20260727020000_attendance_request_resolution_guard.sql', 'attendance_request_resolution_guard'],
    ['../src/supabase/admin_cms_schema.sql', 'class_session_update_guard'],
    ['../supabase/migrations/20260713000000_class_session_update_guard.sql', 'class_session_update_guard'],
    ['../src/supabase/admin_cms_schema.sql', 'product_update_guard'],
    ['../supabase/migrations/20260713010000_product_update_guard.sql', 'product_update_guard'],
    ['../src/supabase/admin_cms_schema.sql', 'stripe_refund_reconciliation'],
    ['../supabase/migrations/20260713020000_stripe_refund_reconciliation.sql', 'stripe_refund_reconciliation'],
    ['../src/supabase/booking_schema.sql', 'checkout_reconciliation'],
    ['../supabase/migrations/20260713030000_checkout_reconciliation.sql', 'checkout_reconciliation'],
    ['../src/supabase/booking_schema.sql', 'stripe_payment_fulfillment'],
    ['../src/supabase/stripe_payment_fulfillment_upgrade.sql', 'stripe_payment_fulfillment'],
    ['../supabase/migrations/20260715010000_stripe_payment_fulfillment.sql', 'stripe_payment_fulfillment'],
    ['../src/supabase/guarded_payment_activation_upgrade.sql', 'guarded_payment_activation'],
    ['../supabase/migrations/20260716010000_guarded_payment_activation.sql', 'guarded_payment_activation'],
    ['../src/supabase/payment_activation_drift_guard_upgrade.sql', 'payment_activation_drift_guard'],
    ['../supabase/migrations/20260716060000_payment_activation_drift_guard.sql', 'payment_activation_drift_guard'],
    ['../src/supabase/admin_settings_singleton_upgrade.sql', 'admin_settings_singleton'],
    ['../supabase/migrations/20260716020000_admin_settings_singleton.sql', 'admin_settings_singleton'],
    ['../src/supabase/booking_schema.sql', 'stripe_pending_order_guard'],
    ['../src/supabase/stripe_payment_fulfillment_upgrade.sql', 'stripe_pending_order_guard'],
    ['../supabase/migrations/20260716030000_stripe_pending_order_guard.sql', 'stripe_pending_order_guard'],
    ['../src/supabase/booking_schema.sql', 'stripe_order_terms_snapshot'],
    ['../src/supabase/stripe_payment_fulfillment_upgrade.sql', 'stripe_order_terms_snapshot'],
    ['../supabase/migrations/20260716040000_stripe_order_terms_snapshot.sql', 'stripe_order_terms_snapshot'],
    ['../src/supabase/booking_schema.sql', 'stripe_webhook_ledger'],
    ['../src/supabase/stripe_webhook_ledger_upgrade.sql', 'stripe_webhook_ledger'],
    ['../supabase/migrations/20260716050000_stripe_webhook_ledger.sql', 'stripe_webhook_ledger'],
    ['../src/supabase/booking_schema.sql', 'member_announcements'],
    ['../supabase/migrations/20260713040000_member_announcements.sql', 'member_announcements'],
    ['../src/supabase/booking_schema.sql', 'announcement_receipts'],
    ['../supabase/migrations/20260713050000_announcement_receipts.sql', 'announcement_receipts'],
    ['../src/supabase/booking_schema.sql', 'announcement_actions'],
    ['../supabase/migrations/20260714000000_announcement_actions.sql', 'announcement_actions'],
    ['../src/supabase/booking_schema.sql', 'announcement_archival'],
    ['../src/supabase/announcement_archival_upgrade.sql', 'announcement_archival'],
    ['../supabase/migrations/20260714010000_announcement_archival.sql', 'announcement_archival'],
    ['../src/supabase/booking_schema.sql', 'booking_time_conflict_guard'],
    ['../supabase/migrations/20260714002000_booking_time_conflicts.sql', 'booking_time_conflict_guard'],
    ['../src/supabase/admin_cms_schema.sql', 'admin_member_notes'],
    ['../supabase/migrations/20260714003000_admin_member_notes.sql', 'admin_member_notes'],
    ['../src/supabase/availability_schema.sql', 'schedule_blackout_guard'],
    ['../supabase/migrations/20260714004000_schedule_blackout_guard.sql', 'schedule_blackout_guard'],
    ['../supabase/migrations/20260714006000_database_security_hardening.sql', 'database_security_hardening'],
    ['../supabase/migrations/20260714007000_rls_policy_performance.sql', 'rls_policy_performance'],
    ['../src/supabase/admin_request_status_audit_upgrade.sql', 'request_status_audit'],
    ['../supabase/migrations/20260714008000_admin_request_status_audit.sql', 'request_status_audit'],
    ['../src/supabase/member_push_notifications_upgrade.sql', 'member_push_notifications'],
    ['../supabase/migrations/20260714009000_member_push_notifications.sql', 'member_push_notifications'],
    ['../src/supabase/admin_cms_schema.sql', 'credit_expiry_follow_up'],
    ['../supabase/migrations/20260713060000_credit_expiry_follow_up.sql', 'credit_expiry_follow_up'],
    ['../src/supabase/member_pt_request_tracking.sql', 'member_pt_request_tracking'],
    ['../supabase/migrations/20260714004200_member_pt_request_tracking.sql', 'member_pt_request_tracking'],
    ['../src/supabase/public_form_integrity_upgrade.sql', 'public_form_integrity'],
    ['../supabase/migrations/20260714004300_public_form_integrity.sql', 'public_form_integrity'],
    ['../src/supabase/lead_pipeline_audit_upgrade.sql', 'lead_pipeline_audit'],
    ['../supabase/migrations/20260714011000_lead_pipeline_audit.sql', 'lead_pipeline_audit'],
    ['../src/supabase/schedule_change_audit_upgrade.sql', 'schedule_change_audit'],
    ['../supabase/migrations/20260714012000_schedule_change_audit.sql', 'schedule_change_audit'],
    ['../src/supabase/content_change_audit_upgrade.sql', 'content_change_audit'],
    ['../supabase/migrations/20260714013000_content_change_audit.sql', 'content_change_audit'],
    ['../src/supabase/booking_lifecycle_audit_upgrade.sql', 'booking_lifecycle_audit'],
    ['../supabase/migrations/20260714014000_booking_lifecycle_audit.sql', 'booking_lifecycle_audit'],
    ['../src/supabase/class_cancellation_notifications_upgrade.sql', 'class_cancellation_notifications'],
    ['../supabase/migrations/20260714015000_class_cancellation_notifications.sql', 'class_cancellation_notifications'],
    ['../src/supabase/admin_cms_schema.sql', 'admin_daily_operations'],
    ['../src/supabase/admin_daily_operations_upgrade.sql', 'admin_daily_operations'],
    ['../supabase/migrations/20260714016000_admin_daily_operations.sql', 'admin_daily_operations'],
    ['../src/supabase/availability_schema.sql', 'schedule_optimistic_locking'],
    ['../src/supabase/schedule_optimistic_locking_upgrade.sql', 'schedule_optimistic_locking'],
    ['../supabase/migrations/20260714018000_schedule_optimistic_locking.sql', 'schedule_optimistic_locking'],
    ['../src/supabase/shared_admin_optimistic_locking_upgrade.sql', 'shared_admin_optimistic_locking'],
    ['../supabase/migrations/20260714019000_shared_admin_optimistic_locking.sql', 'shared_admin_optimistic_locking'],
    ['../src/supabase/catalog_optimistic_locking_upgrade.sql', 'catalog_optimistic_locking'],
    ['../supabase/migrations/20260714020000_catalog_optimistic_locking.sql', 'catalog_optimistic_locking'],
    ['../src/supabase/product_commercial_terms_guard_upgrade.sql', 'product_commercial_terms_guard'],
    ['../supabase/migrations/20260720000000_product_commercial_terms_guard.sql', 'product_commercial_terms_guard'],
    ['../src/supabase/targeted_member_notices_upgrade.sql', 'targeted_member_notices'],
    ['../supabase/migrations/20260714021000_targeted_member_notices.sql', 'targeted_member_notices'],
    ['../src/supabase/waitlist_promotion_notifications_upgrade.sql', 'waitlist_promotion_notifications'],
    ['../supabase/migrations/20260721030000_waitlist_promotion_notifications.sql', 'waitlist_promotion_notifications'],
    ['../src/supabase/booking_decision_notifications_upgrade.sql', 'booking_decision_notifications'],
    ['../supabase/migrations/20260722000000_booking_decision_notifications.sql', 'booking_decision_notifications'],
    ['../src/supabase/staff_assisted_booking_upgrade.sql', 'staff_assisted_booking'],
    ['../supabase/migrations/20260727010000_staff_assisted_booking.sql', 'staff_assisted_booking'],
    ['../supabase/migrations/20260722010000_owner_stripe_price_provisioning.sql', 'owner_stripe_price_provisioning'],
    ['../supabase/migrations/20260811010000_xert_forms_surveys.sql', 'forms_surveys_builder'],
    ['../supabase/migrations/20260813020000_require_versioned_form_submissions.sql', 'form_response_snapshots'],
    ['../supabase/migrations/20260902010000_fitbox_zapier_bridge.sql', 'fitbox_zapier_bridge'],
    ['../supabase/migrations/20260902020000_fitbox_get_user_refresh.sql', 'fitbox_get_user_refresh'],
  ];
  for (const [path, capability] of pairs) {
    const sql = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(sql, new RegExp(`values \\('${capability}'\\)`, 'i'));
  }

  for (const path of ['../src/supabase/booking_schema.sql', '../src/supabase/admin_cms_schema.sql']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /xert_public_capabilities/i);
  }
});

test('Codemagic TestFlight preflight enforces every production capability', () => {
  const yaml = readFileSync(new URL('../codemagic.yaml', import.meta.url), 'utf8');
  assert.match(yaml, /Verify production service contract/);
  assert.match(yaml, /admin_role_safety/);
  assert.match(yaml, /audited_credit_grants/);
  assert.match(yaml, /booking_waitlist_withdrawal/);
  assert.match(yaml, /member_cancellation_receipt/);
  assert.match(yaml, /member_booking_switch_guard/);
  assert.match(yaml, /member_onboarding_foundation/);
  assert.match(yaml, /member_activation_cockpit/);
  assert.match(yaml, /member_waitlist_join/);
  assert.match(yaml, /waitlist_fifo_promotion/);
  assert.match(yaml, /attendance_roll_call/);
  assert.match(yaml, /attendance_request_resolution_guard/);
  assert.match(yaml, /class_session_update_guard/);
  assert.match(yaml, /product_update_guard/);
  assert.match(yaml, /stripe_refund_reconciliation/);
  assert.match(yaml, /checkout_reconciliation/);
  assert.match(yaml, /stripe_payment_fulfillment/);
  assert.match(yaml, /guarded_payment_activation/);
  assert.match(yaml, /payment_activation_drift_guard/);
  assert.match(yaml, /admin_settings_singleton/);
  assert.match(yaml, /stripe_pending_order_guard/);
  assert.match(yaml, /stripe_order_terms_snapshot/);
  assert.match(yaml, /stripe_webhook_ledger/);
  assert.match(yaml, /member_announcements/);
  assert.match(yaml, /announcement_receipts/);
  assert.match(yaml, /announcement_actions/);
  assert.match(yaml, /announcement_archival/);
  assert.match(yaml, /booking_time_conflict_guard/);
  assert.match(yaml, /admin_member_notes/);
  assert.match(yaml, /schedule_blackout_guard/);
  assert.match(yaml, /database_security_hardening/);
  assert.match(yaml, /rls_policy_performance/);
  assert.match(yaml, /request_status_audit/);
  assert.match(yaml, /member_push_notifications/);
  assert.match(yaml, /credit_expiry_follow_up/);
  assert.match(yaml, /member_pt_request_tracking/);
  assert.match(yaml, /public_form_integrity/);
  assert.match(yaml, /lead_pipeline_audit/);
  assert.match(yaml, /schedule_change_audit/);
  assert.match(yaml, /content_change_audit/);
  assert.match(yaml, /booking_lifecycle_audit/);
  assert.match(yaml, /class_cancellation_notifications/);
  assert.match(yaml, /admin_daily_operations/);
  assert.match(yaml, /schedule_optimistic_locking/);
  assert.match(yaml, /shared_admin_optimistic_locking/);
  assert.match(yaml, /catalog_optimistic_locking/);
  assert.match(yaml, /product_commercial_terms_guard/);
  assert.match(yaml, /targeted_member_notices/);
  assert.match(yaml, /waitlist_promotion_notifications/);
  assert.match(yaml, /booking_decision_notifications/);
  assert.match(yaml, /staff_assisted_booking/);
  assert.match(yaml, /owner_stripe_price_provisioning/);
  assert.match(yaml, /forms_surveys_builder/);
  assert.match(yaml, /form_response_snapshots/);
  assert.match(yaml, /fitbox_zapier_bridge/);
  assert.match(yaml, /fitbox_get_user_refresh/);
  assert.match(yaml, /\/api\/checkout/);
  assert.match(yaml, /expected HTTP 401/);
  assert.match(yaml, /STRIPE_SECRET_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(yaml, /\/api\/stripe-webhook/);
  assert.match(yaml, /\/api\/admin-refund-order/);
  assert.match(yaml, /\/api\/admin-reconcile-order/);
  assert.match(yaml, /\/api\/admin-publish-announcement[\s\S]*notify_class_cancellation/);
  assert.match(yaml, /expected HTTP 400/);
  assert.match(yaml, /STRIPE_WEBHOOK_SECRET/);
  assert.match(yaml, /Report production push delivery readiness/);
  assert.match(yaml, /\/api\/push-health/);
  assert.match(yaml, /REQUIRE_PRODUCTION_SERVICES/);
  assert.match(yaml, /TestFlight upload will continue/);
});

test('read-only production check reports every release capability and migration', () => {
  const sql = readFileSync(new URL('../src/supabase/release_readiness_check.sql', import.meta.url), 'utf8');
  const capabilities = [
    'admin_role_safety',
    'audited_credit_grants',
    'booking_waitlist_withdrawal',
    'member_cancellation_receipt',
    'member_booking_switch_guard',
    'member_onboarding_foundation',
    'member_activation_cockpit',
    'member_waitlist_join',
    'waitlist_fifo_promotion',
    'attendance_roll_call',
    'attendance_request_resolution_guard',
    'class_session_update_guard',
    'product_update_guard',
    'stripe_refund_reconciliation',
    'checkout_reconciliation',
    'stripe_payment_fulfillment',
    'guarded_payment_activation',
    'payment_activation_drift_guard',
    'admin_settings_singleton',
    'stripe_pending_order_guard',
    'stripe_order_terms_snapshot',
    'stripe_webhook_ledger',
    'member_announcements',
    'announcement_receipts',
    'announcement_actions',
    'announcement_archival',
    'booking_time_conflict_guard',
    'admin_member_notes',
    'schedule_blackout_guard',
    'database_security_hardening',
    'rls_policy_performance',
    'request_status_audit',
    'member_push_notifications',
    'credit_expiry_follow_up',
    'member_pt_request_tracking',
    'public_form_integrity',
    'lead_pipeline_audit',
    'schedule_change_audit',
    'content_change_audit',
    'booking_lifecycle_audit',
    'class_cancellation_notifications',
    'admin_daily_operations',
    'schedule_optimistic_locking',
    'shared_admin_optimistic_locking',
    'catalog_optimistic_locking',
    'product_commercial_terms_guard',
    'targeted_member_notices',
    'waitlist_promotion_notifications',
    'booking_decision_notifications',
    'staff_assisted_booking',
    'owner_stripe_price_provisioning',
    'forms_surveys_builder',
    'form_response_snapshots',
    'fitbox_zapier_bridge',
    'fitbox_get_user_refresh',
  ];

  for (const capability of capabilities) {
    assert.match(sql, new RegExp(`\\('${capability}', '(?:src/supabase|supabase/migrations)/.+\\.sql'\\)`));
  }
  assert.match(sql, /bool_and\(installed\) over \(\) as release_ready/i);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|create|drop|grant|revoke)\b/i);
});
