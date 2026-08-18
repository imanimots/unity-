-- i18n Phase 2: locale preference persistence.
--
-- Additive only. No backfill: NULL means "no saved explicit preference" and
-- the application falls through to cookie / Accept-Language / en-ZA default
-- (see src/i18n/resolve-locale.ts). Existing rows are left untouched.
--
-- Locale identifiers are validated against a fixed allowlist via CHECK
-- constraint (database-authoritative, not app-trusted) rather than a
-- separate locale lookup table — the three enabled locales are config, not
-- data that needs its own table (see docs/I18N_GLOSSARY.md).

alter table profiles
  add column if not exists preferred_locale text;

alter table profiles
  add constraint profiles_preferred_locale_check
  check (preferred_locale is null or preferred_locale in ('en-ZA', 'af-ZA', 'zu-ZA'));

comment on column profiles.preferred_locale is
  'Ordinary UX preference (language), not KYC/authorization data. NULL = no explicit preference saved; resolver falls through to cookie / Accept-Language / en-ZA default. Never exposed via public_profiles.';

-- Snapshot only — never part of email idempotency identity (see
-- src/lib/email/idempotency.ts, unchanged by this migration). Recorded at
-- send time so a later preference change can never be mistaken for the
-- locale an already-sent email actually used.
alter table email_deliveries
  add column if not exists resolved_locale text;

alter table email_deliveries
  add constraint email_deliveries_resolved_locale_check
  check (resolved_locale is null or resolved_locale in ('en-ZA', 'af-ZA', 'zu-ZA'));

comment on column email_deliveries.resolved_locale is
  'Locale actually used to render this email at send time. Nullable for historical rows sent before locale support existed. Never included in the idempotency key.';
