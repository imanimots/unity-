# A — Production Environment Architecture

## Current state (verified this session)

```
┌─────────────────────────────────────────────────────┐
│  ONE Supabase project (pwueguyrlcorurvbphej)         │
│  Serves development AND the only "real" data today   │
│                                                        │
│  314 auth users total                                 │
│    ├─ 303 match the @unitytest.internal / qa- pattern │
│    └─  11 do not (gmail.com x2, unitytest.co.za x9)   │
│         but EVERY listing/booking/payment touched by  │
│         these 11 is explicitly is_test=true           │
│                                                        │
│  9,270 listing rows                                    │
│    ├─ 10 pass status=active AND is_test=false          │
│    │    (both owning accounts are @unitytest.internal) │
│    └─ 9,259 are is_test=true QA fixtures               │
└─────────────────────────────────────────────────────┘
          │
          ▼
   ONE Vercel deployment, reading the same project for
   every environment (no evidence of per-environment
   Supabase URL scoping found in the repo)
```

**This corroborates, with concrete live evidence rather than trust alone, the Founder's confirmed statement that no real customer accounts or transactions exist in the current project.**

## Target state (not yet built — requires provisioning this session cannot perform)

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  EXISTING project        │        │  NEW project             │
│  (pwueguyrlcorurvbphej)  │        │  (ref: TBD)               │
│  → becomes STAGING/DEV   │        │  → becomes PRODUCTION     │
│                           │        │                           │
│  Keeps all 9,270 rows,   │        │  Starts empty, receives   │
│  all QA accounts, all    │        │  the same 270-migration   │
│  test fixtures intact    │        │  schema (Doc B) with      │
│  (nothing deleted)        │        │  ZERO data copied in      │
└─────────────────────────┘        └─────────────────────────┘
          │                                   │
          ▼                                   ▼
   Vercel Preview/Development           Vercel Production
   environment variables                environment variables
   (NEXT_PUBLIC_SUPABASE_URL →           (NEXT_PUBLIC_SUPABASE_URL →
    existing project)                     new project)
          │                                   │
          └───────────────┬───────────────────┘
                           ▼
          src/lib/env/environment-separation.ts
          (built and verified this session — throws
           at build time if either side ever points
           at the wrong project, once the new project's
           ref is configured as PRODUCTION_SUPABASE_PROJECT_REF)
```

## Why this session could not build the right-hand side

Creating a new Supabase project requires either the Supabase Dashboard or the Supabase Management API — this environment has neither (only the existing project's own data-plane anon/service-role keys, confirmed repeatedly across this and the two prior programme sessions). This is a hard capability gap, not a policy choice: there is no command this session could run that would create a new project, with or without approval. Everything in this report's remaining sections prepares for that provisioning rather than assumes it happened.
