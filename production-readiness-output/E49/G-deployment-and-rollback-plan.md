# G — Deployment and Rollback Plan

## Exact release order (once a production project exists)

1. **Infrastructure verification** — confirm the new project's region, plan tier (extensions available, storage available), and that `PRODUCTION_SUPABASE_PROJECT_REF` is known.
2. **Database migration** — point the Supabase GitHub deploy integration at the new project; apply all 270 migrations via the same mechanism already used for the existing project. Verify via `supabase migration list --linked` equivalent (or the dashboard's own migration-status view) that all 270 applied cleanly.
3. **Storage configuration** — confirmed to be covered by the same migration sequence (Doc B) — no separate manual step, provided storage is available on the plan tier.
4. **Authentication configuration** — project-level Auth settings (password policy, redirect URLs, email confirmation) configured via the dashboard; not covered by migrations.
5. **Production secrets** — every genuine secret from `docs/operations/SECRETS_AND_CONFIG_INVENTORY.md`'s 14-row table, freshly issued for production (never copied from the existing project's `.env.local`).
6. **Provider integrations** — payment (Peach — see Doc F's naming-discrepancy finding), email (Resend), AI assistant (Anthropic), embeddings (Voyage) — each needs its own production-tier credentials, separate from whatever sandbox credentials the existing project uses.
7. **Monitoring activation** — only if Sentry (or equivalent) has been provisioned by then; otherwise this step is explicitly skipped, not faked.
8. **Backup verification** — confirm the new project's actual backup/PITR configuration (Doc D) before considering this step complete.
9. **Pre-production smoke tests** — the same test suites this engagement has run repeatedly (authenticated-smoke, rls-negative-access, route-protection), run against the new project once it's reachable.
10. **Production deployment** — Vercel's production environment, pointed at the new project's URL/keys, with `PRODUCTION_SUPABASE_PROJECT_REF` set to activate the environment-separation guard (Doc C).
11. **Post-deployment verification** — re-run the same smoke tests against the live production URL.
12. **Rollback and incident response** — per `docs/operations/INCIDENT_RESPONSE_WORKFLOW.md`, unchanged.

**None of steps 1-11 were performed this session** — no production project exists to perform them against. This is the plan for when one does.

## Rollback actions, by failure mode

| Failure | Rollback action | Distinguishing note |
|---|---|---|
| Database migration failure | **Not a `git revert`.** Per this project's standing forward-fix-only convention, a bad migration is corrected with a new, forward migration undoing the specific effect — never a destructive rollback migration. If the failure is severe enough to block all further work, the new project itself can simply be discarded and re-provisioned from scratch (it would hold no real data yet) — an option only available before real customers exist |
| Authentication failure | Revert the specific Auth dashboard setting that caused it; this is configuration, not code, so no redeploy is needed |
| Storage misconfiguration | Same — a dashboard/migration-level fix, not a code rollback |
| Incorrect environment variables | Fix directly in Vercel's environment variable settings; takes effect on the next deploy, no code change needed. **The environment-separation guard (Doc C) would have caught the specific case of a production/staging URL mismatch before this could even reach a running deployment** |
| Failed third-party integration | Vendor-side issue — check the provider's status page first (per `docs/operations/INCIDENT_RESPONSE_WORKFLOW.md`'s "provider outage" triage category) before assuming an application bug |
| Search defects | A new, forward code fix + redeploy — `git revert` of the application code is the correct mechanism here specifically, since search logic lives in application code (RPCs + TypeScript), not just schema |
| Payment errors | **Requires your explicit approval before any corrective action that touches live payment configuration** — per this and every prior phase's standing instruction |
| Major platform outage | Supabase/Vercel's own incident, not something this application's rollback plan can act on directly — monitor their status pages, communicate to users once a status-page mechanism exists (still a named gap from the second programme) |

**A `git revert` of application code never, by itself, undoes a database migration.** This plan does not conflate the two anywhere above — each failure mode's rollback action is stated in terms of what actually reverses it.
