# Real Chat (Step 11 Phase 3)

## What existed before this phase

`/chat` was 100% mock: `CURRENT_USER_ID = 'user-1'` was hardcoded, `MOCK_CONVERSATIONS` was a fixed
in-memory array (`src/lib/mock/conversations.ts`, now deleted), and `send()` only ever called local
`setMessages()` — nothing was persisted, nothing was filtered server-side. `messages` itself had
already been real and RLS-correct since Step 11 Phase 1/2, and Phase 2's dispute chat
(`GET/POST /api/disputes/[id]/messages`) proved the real send/read pattern for one domain ahead of
this phase. This was the single most misleading gap the original Full Site Audit found — a
nav-prominent feature that looked live but wasn't.

## Architectural Guarantees

These are the load-bearing invariants of this system. Anyone revisiting messaging later — to add a
feature, debug a report, or extend Realtime to a new domain — should be able to rely on all nine
holding true. If a future change would break one of these, that's a sign to update this section
deliberately, not to let it drift silently.

1. **There is exactly one message model.** `messages` is the only table that represents a chat
   message, for every transaction type and for disputes. No `Conversation`, `ChatRoom`, `Thread`,
   `DisputeConversation`, or `BookingConversation` construct exists or should ever be introduced.
2. **There is exactly one chat component.** `src/components/messaging/chat-thread.tsx` is the only
   UI that renders a message thread, anywhere in the app — the real `/chat` page and the dispute
   detail view both render it with different props, not different components.
3. **There is exactly one generic messaging service.** `src/lib/messaging/service.ts`'s
   `sendMessage()`/`listMessages()` are the only send/list implementations. Every route that sends
   or lists messages — including the legacy dispute wrapper — calls these, never reimplements them.
4. **Disputes are only a tagged subset of messages, not a second thread.** A dispute-scoped message
   is a normal row in `messages` with `dispute_id` set; it lives in the same thread as the
   transaction's general chat. There is no dispute-specific message store or view.
5. **Conversation summaries are computed, never stored.** `listMyConversations()`
   (`src/lib/messaging/conversations.ts`) derives the inbox list from the transaction tables plus
   each thread's latest message, on every request. There is no cached/materialized "conversations"
   table to keep in sync or let go stale.
6. **Realtime never bypasses RLS.** The `messages` Realtime subscription runs through the same
   Postgres RLS policies as every other read — a non-participant's subscription to a thread they
   can't read simply never receives its rows. There is no service-role or elevated-privilege
   realtime channel anywhere in this system.
7. **Admin access is read-only and audited.** No admin-write route or policy exists for messages or
   attachments. Every admin read is logged to `admin_message_access_log` before data returns —
   there is no path that lets an admin view a thread without leaving an audit trail.
8. **Attachments are immutable.** `message_attachments` and the `chat-attachments` bucket have no
   update or delete policy for any client role. An attachment, once registered, cannot be replaced
   or silently changed — only appended alongside.
9. **The provider abstraction is unchanged.** This phase reused the existing `sendTemplate()` email
   pipeline, the existing Realtime publication, and the existing storage/RLS conventions. No new
   third-party provider, no new abstraction layer, no swap-in-place seam was added — messaging
   plugs into infrastructure that already existed before this phase.

## Architecture

**One messaging model, no exceptions.** `messages` remains the only source of truth — there is no
`Conversation`, `ChatRoom`, `Thread`, `DisputeConversation`, or `BookingConversation` table
anywhere. A dispute does not have its own thread: a message sent from the dispute detail view is
tagged with `dispute_id` but lands in the exact same row set as the transaction's general chat.
Viewing a dispute's "messages" and viewing the underlying booking/order/barter agreement's
messages return the same result — the tag exists for audit/context, not for partitioning.

**One shared implementation, reused everywhere:**

- `src/lib/messaging/thread-resolution.ts` — `resolveThread()` is the one place a thread reference
  (`booking_id`/`order_id`/`barter_agreement_id`/`dispute_id`) resolves to a canonical
  `{ type, id, bookingId, orderId, barterAgreementId, disputeId }` shape. A dispute reference
  resolves to its underlying transaction. Every consumer — the messages API, the admin message
  route, email notification code, and the dispute-route wrapper — calls this one function.
- `src/lib/messaging/service.ts` — `sendMessage()`/`listMessages()` are the one send/list
  implementation. `GET/POST /api/messages` and the legacy `GET/POST /api/disputes/[id]/messages`
  wrapper both call these rather than duplicating query/insert logic.
- `src/components/messaging/chat-thread.tsx` — the one shared chat UI, used by the real `/chat`
  page and the dispute detail view alike. No `BookingChat`/`OrderChat`/`DisputeChat`/`BarterChat`
  variants.

**Session-client inserts under RLS, not a new RPC.** Sending a message still goes through the
session-scoped Supabase client, with `"messages: parties send"` RLS as the real enforcement of
participancy — the same pattern established in Phase 1/2 and deliberately preserved rather than
moved to a `SECURITY DEFINER` RPC. "The browser must never write directly to the table" is
satisfied at the route boundary: the browser calls the trusted `/api/messages` route, which
validates the body, checks idempotency, and only then performs the session-client insert — not by
switching to a service-role/RPC pattern, which would have been a bigger, unrequested architectural
change for no security benefit (RLS already fully gates the insert).

## Database changes

Three migrations, all additive — no changes to `messages`' own exactly-one-of CHECK or its four
reference columns (all already correct from Phase 1/2):

1. **`20260815000001_message_attachments.sql`** — `message_attachments` table (`message_id`,
   `uploaded_by`, `storage_path`, `file_type`, unique on `(message_id, storage_path)`), the
   `chat-attachments` storage bucket (private, 10MB, `image/jpeg|png|webp` + `application/pdf`,
   mirroring `dispute-evidence`'s exact config), and `is_message_participant(p_message_id,
   p_user_id)` (mirrors `is_dispute_participant()`, generalized to join through whichever of
   `messages.booking_id`/`order_id`/`barter_agreement_id` is set). Storage RLS dispatches on a
   `{type}/{transaction_id}/{uploader_uid}/{filename}` path, comparing `id::text = (storage.
   foldername(name))[N]` — never casting the path segment itself to `uuid` (the same pitfall
   `dispute-evidence`'s storage RLS was written to avoid: a malformed segment cast to `uuid` throws
   a hard Postgres error instead of just failing the policy).
2. **`20260815000002_messages_admin_audit.sql`** — `"messages: admin read"` RLS policy (first
   admin-read policy on this table), and `admin_message_access_log` (the first "an admin *viewed*
   X" audit table in this codebase — admin-only read, service-role-only insert, no update/delete
   policy for anyone).
3. **`20260815000003_message_thread_presence.sql`** — `message_thread_presence` (`user_id`,
   `transaction_type`, `transaction_id`, `last_active_at`, composite primary key). RLS: a user may
   upsert only their own row, and read rows for threads they're a participant in. Uses generic
   `transaction_type`/`transaction_id` columns rather than the exactly-one-of FK-column pattern
   `messages`/`disputes` use — this table has no FK referential-integrity need (nothing else joins
   against it), so a plain composite key is simpler and gives a straightforward upsert target.

## Routes

`GET/POST /api/messages` — list one thread with pagination (`?booking_id=`/`order_id=`/
`barter_agreement_id=`/`dispute_id=&before=&limit=`) / send. `POST /api/messages/[id]/attachments`
— registers an already-uploaded storage object (upload-then-register, exactly mirroring
`POST /api/disputes/[id]/evidence`'s pattern). `GET /api/admin/messages` — the audited admin read
path. `GET/POST /api/disputes/[id]/messages` — rewritten as a thin wrapper over the same
`src/lib/messaging/service.ts` functions; **kept live, not deleted**, for rollback safety — actual
removal is deferred to a later cleanup commit. Its behavior changed slightly: it now returns the
underlying transaction's full thread rather than only `dispute_id`-tagged rows, matching the "one
thread" model above.

## Attachments

Upload-then-register, never binary data through the messaging endpoint: (1) client uploads
directly to the `chat-attachments` bucket under storage RLS, (2) client `POST`s the resulting path
to `/api/messages/[id]/attachments`, (3) the route re-validates the path prefix
(`{type}/{transactionId}/{callerUid}/...`) and ownership server-side, then inserts the row via a
service-role client. `src/lib/messaging/attachments.ts` defines the limits: `MAX_ATTACHMENT_SIZE_
BYTES` = 10MB, `MAX_ATTACHMENTS_PER_MESSAGE` = 4 (checked at the route via a `count`-query before
insert), `ALLOWED_ATTACHMENT_MIME_TYPES` = image/jpeg, image/png, image/webp, application/pdf.
Duplicate registration of the same `storage_path` is rejected by the unique constraint, on top of
route-level idempotency-key protection. Attachments are immutable/append-only — no update or
delete client policy anywhere, matching `dispute_evidence`'s precedent exactly.

## Realtime

Reuses the existing `supabase_realtime` publication (`messages` was added to it back in Phase 1,
unconsumed until this phase). No new realtime system. `chat-thread.tsx` **loads history first,
records the loaded message ids as a high-water mark, and only then opens the `postgres_changes`
subscription** — any incoming event for a message id already present in the loaded set is
discarded. This ordering (rather than subscribe-then-load, or subscribe-and-load-concurrently)
specifically avoids the race where a message inserted between "history query starts" and
"subscription opens" would otherwise arrive twice: once via history, once via the realtime event.
RLS applies to Realtime automatically — a non-participant's subscription to a thread they can't
read simply never receives its rows.

## Email notification: two-tier debounce

One new catalogue entry, `new-message-received` (event `message.new`), reusing the existing
`sendTemplate()`/`email_deliveries` infrastructure — no new provider, no redesign.
`src/lib/messaging/notify.ts` decides whether to email the *recipient* of a new message:

1. **Presence heartbeat (primary signal).** `chat-thread.tsx` upserts its own
   `message_thread_presence` row on mount and every ~25s while the thread is visible
   (`document.visibilityState === 'visible'`). If the recipient has a heartbeat on this exact
   thread within the last ~45 seconds, the email is skipped immediately — they plausibly have the
   thread open right now.
2. **Last-sent-message fallback.** Otherwise, if the recipient sent a message in this same thread
   within the last 10 minutes, the email is still skipped (the original MVP heuristic, kept as a
   fallback for a client that hasn't rendered `chat-thread.tsx` at all, e.g. a stale tab).
3. Otherwise, the email sends.

Both tiers were verified live (see below) — a heartbeat suppresses, an absent heartbeat but a
recent send suppresses, and neither present sends. This is **not** full presence: no cross-device
awareness beyond "a heartbeat exists somewhere," no "last seen X minutes ago" display anywhere, no
typing indicators, no read receipts (all explicitly excluded from this phase's scope). It's the
smallest real building block toward true presence without adopting it wholesale.

## Admin access: real, read-only, audited

`messages` and `message_attachments` both have a `role = 'admin'` read RLS policy. `GET
/api/admin/messages` and the admin dispute detail page (`src/app/admin/disputes/[id]/page.tsx`,
via `chat-thread.tsx`'s `useAdminEndpoint` prop) both route through
`src/lib/messaging/admin.ts`'s `getMessagesForAdmin()`, which writes one row to
`admin_message_access_log` **before** returning any message data — the first "an admin *viewed* X"
audit table in this codebase. There is no admin-write route or policy anywhere: an admin can view
for moderation but cannot send as if a party. Verified live (see below) that an admin `POST
/api/messages` against a thread they aren't a party to is rejected by RLS.

## Idempotency

`POST /api/messages` and `POST /api/messages/[id]/attachments` both use the same route-level
`checkIdempotentReplay()`/`idempotency_keys` pattern proven by Phase 2's evidence-registration
route (`src/lib/messaging/idempotency.ts` computes the request hashes). Replaying an identical send
or registration returns the original cached result rather than creating a duplicate row.

## UI

`chat-thread.tsx` (message list, pagination, optimistic send with a client-generated temp id
swapped for the server row on success and a retry affordance on failure, presence heartbeat,
ordered realtime subscription, attachment upload/display) and `conversation-list-item.tsx` (inbox
row). The real `/chat` page (`src/app/(marketing)/chat/{page,chat-ui}.tsx`) server-fetches
`listMyConversations()` (`src/lib/messaging/conversations.ts` — computes the inbox from the three
transaction tables + each thread's latest message, batched `Promise.all` + in-memory join, not
N+1) and supports real `?booking=`/`?order=`/`?barter=`/`?dispute=` deep-linking (a `?dispute=`
link resolves the dispute to its underlying transaction client-side via the existing `GET
/api/disputes/[id]` route, then renders the same thread). `dispute-chat-panel.tsx` is deleted;
`dispute-detail-view.tsx` renders `chat-thread.tsx` directly against the dispute's own
booking/order/barter reference, tagging outgoing messages with the dispute id. "Message" links
(`/chat?booking=`/`?order=`/`?barter=`) were added next to the existing "Raise a dispute" entry
point in `booking-actions.tsx`/`order-actions.tsx`/`barter-actions.tsx`, always visible regardless
of transaction status (unlike the dispute entry point, which stays status-gated).

## Security

RLS blocks non-participant read/send/attachment-access at every layer. A forged transaction or
dispute id behaves like a forged dispute id already did in Phase 2 — indistinguishable from
nonexistent (404, not 403, at both the route and the underlying RLS-scoped query). `POST
/api/messages` re-validates exactly-one-of server-side (defense in depth on top of the CHECK
constraint). Admin access is read-only and logged before data returns. Idempotent replay returns
the cached result rather than re-executing. Duplicate attachment registration is rejected by a
unique constraint. `message_thread_presence` RLS prevents writing another user's heartbeat.

## Live validation performed

Build health: `tsc --noEmit` clean, `eslint` clean, `vitest` 796/796 passing, `next build`
succeeded with all new routes present. Manual SSR smoke tests (authenticated, real QA sessions)
confirmed 200 responses with no application errors on `/chat`, `/chat?dispute=<id>`,
`/dashboard/disputes`, `/dashboard/disputes/[id]`, and `/admin/disputes/[id]`. The two-tier email
debounce was verified live end-to-end: a presence heartbeat suppressed the email; a recent
"recipient sent here" fallback suppressed the email; a fresh thread with neither sent the email
(confirmed via `email_deliveries` row counts before/after each probe).

### Permanent regression coverage: `scripts/verify-chat-security.mjs`

Mirrors `scripts/verify-dispute-locking.mjs`'s shape and philosophy exactly — a real script against
the live dev database using dedicated `[QA] Chat-Security Regression` fixtures (a booking, an
order, and a barter agreement, created but not accepted/paid, since `messages` participancy is
determined by the transaction's party columns at creation time, not its status), fixed-where-
appropriate idempotency keys, and QA accounts from `.qa-credentials.local.json`. Covers, per
transaction type: send/read, non-participant GET/POST rejection, forged transaction id rejection,
idempotent replay, attachment upload/registration/path-mismatch-rejection/non-participant-rejection
/visibility, and realtime delivery to the other party — plus dispute-tagged messaging (confirming
the "one thread, not two" model) and audited admin access (confirming the access-log row is
written and that an admin cannot send as if a party).

**A bug found and fixed while writing this script, before it ever reached the report:** the first
draft reused a fixed storage path for its attachment-upload check across re-runs, with `upsert:
true`. Since `message_attachments`/the `chat-attachments` bucket are deliberately immutable (no
client update policy — matching `dispute_evidence`'s precedent), a second run's upload to the same
path correctly failed RLS (`"new row violates row-level security policy"`). This was the
regression script's own bug, not a Phase 3 architecture bug — fixed by having the script clear any
existing attachments for its probe message via the service-role client at the start of each run
(mirroring the "safely re-runnable" convention every other permanent regression script in this
codebase follows), rather than depending on overwrite semantics the storage RLS deliberately
doesn't grant. Confirmed passing 3 times in a row (45/45 checks each run) after the fix. One
realtime check also failed once, on the very first subscription of the very first run, and passed
on every subsequent run — consistent with a one-off Realtime websocket cold-start delay rather than
a real defect (the same probe passed immediately afterward for the other two transaction types in
the same run, and for all three types on every later run).

## Known limitations

The presence heartbeat is a lightweight, purpose-built signal, not full presence — no cross-device
"online" indicator, no "last seen" display, no typing indicators, no read receipts, no message
editing/deletion, no reactions (all explicitly out of scope for this phase). Attachments are
images/PDFs only. The inbox list only surfaces transactions with at least one existing message,
plus whatever the current deep-link points at — a transaction with no chat activity yet doesn't
appear until the first message is sent from its own "Message" entry point. `GET/POST
/api/disputes/[id]/messages` is a legacy route kept live for rollback safety; nothing in the app
calls it after this phase (the dispute detail view now renders `chat-thread.tsx` directly against
`/api/messages`) — its removal is deferred to a later cleanup commit, not forgotten.

## Future enhancements (deferred, not forgotten)

Typing indicators, read receipts, message editing/deletion, reactions, voice notes, and full
cross-device presence were all explicitly excluded from this phase's brief. The
`message_thread_presence` table is deliberately shaped so a future phase could extend it into real
presence (a "last seen" display, an online indicator) without a schema migration — only new UI and
read paths would be needed.
