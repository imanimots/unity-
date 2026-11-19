# B — Supabase Production Setup Report

**No production project exists. This is the exact, verified specification for provisioning one — not a report of configuration already applied.**

## Migration sequence

- **270 migration files**, to be applied in filename (timestamp) order — the same order the Supabase GitHub deploy integration already applies them in for the existing project.
- Earliest: `20260613000001_initial_schema.sql`. Latest: `20261118095532_admin_kyc_document_access_log.sql` (this programme's own work).
- **Apply via the same Supabase GitHub "Deploy to production" integration mechanism this project already uses** — pointed at the new project once it exists, never via direct SQL/CLI execution. This preserves the one deployment mechanism this entire engagement has used throughout, rather than introducing a second, different one for "real" production.
- **Zero data migration.** No row from the existing project should be copied — the migrations create schema only (tables, columns, indexes, constraints, functions, triggers, RLS policies); every table starts empty.

## Required Postgres extensions (found via `create extension` grep across all 270 migrations)

| Extension | Purpose |
|---|---|
| `uuid-ossp` | UUID generation (`uuid_generate_v4()`, used as the primary-key default across nearly every table) |
| `pg_trgm` | Trigram similarity search (listing title typo-tolerance) |
| `btree_gist` | Required for the `bookings_no_overlap_when_blocking` exclusion constraint (double-booking prevention) |
| `vector` | pgvector, for the Knowledge Base's semantic search embeddings |
| `supabase_vault` | Encrypts payout bank account numbers at rest |

All five must be available on the new project's plan tier before the migrations will apply cleanly — **this is itself something to confirm during provisioning, not assume**.

## Row-Level Security

**271 `create policy` statements** across the 270 migrations — these are schema, not data, and apply automatically as part of the same migration sequence. No separate RLS setup step exists; it is inseparable from running the migrations themselves.

## Storage buckets (10, to be created fresh — empty, no files copied)

| Bucket | Public | Contents |
|---|---|---|
| `listing-media` | Yes | Listing photos/video |
| `avatars` | Yes | Profile pictures |
| `rental-media` | No | Pre/post-rental condition evidence |
| `ownership-proofs` | No | Proof-of-ownership documents |
| `kyc-documents` | No | Identity verification documents |
| `barter-offer-media` | No | Barter offer evidence |
| `chat-attachments` | No | In-chat file sharing |
| `dispute-evidence` | No | Dispute supporting evidence |
| `rent-to-buy-evidence` | No | RTB condition/handover evidence |
| `barter-milestone-evidence` | No | Barter milestone proof |

Bucket creation (name, public/private flag, file-size limit, allowed MIME types) is itself done via migration (`storage.buckets` inserts), so this too is covered by the same migration sequence — **not a manual dashboard step**, provided the new project's storage subsystem is otherwise available on its plan tier.

## Database functions/triggers

Covered by the same 270-migration sequence — every RPC (`search_listings`, `create_booking_request`, `payoff_rent_to_buy_agreement`, etc.) and every trigger (e.g. the immutability triggers on audit-log tables) is defined via `CREATE OR REPLACE FUNCTION`/`CREATE TRIGGER` statements within the migrations themselves.

## Authentication configuration

**Cannot be fully specified without Supabase dashboard access** — password policy, email-confirmation requirements, and redirect-URL allow-listing are project-level Auth settings, not something a SQL migration configures. What IS known from code: this app expects Supabase Auth's standard email/password flow plus optional TOTP MFA (the mechanism this programme built in `src/lib/supabase/admin-mfa.ts`), with no custom auth provider.

## Roles

No custom Postgres roles beyond Supabase's own standard `anon`/`authenticated`/`service_role` are referenced anywhere in the 270 migrations (confirmed via grep for `create role`) — the new project's default role setup is sufficient; nothing extra to configure here.

## Evidence this spec is accurate, not assumed

Every figure above (270 migrations, 271 policies, 5 extensions, 10 buckets) was obtained by directly reading the actual migration files this session, not carried over from memory or a prior report without re-verification.
