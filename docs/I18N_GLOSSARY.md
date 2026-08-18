# Unity i18n Product Glossary

Canonical semantic meaning of Unity's domain terms, and the approved translation used by the `en-ZA` / `af-ZA` / `zu-ZA` dictionaries (`src/i18n/messages/`). Translators and future contributors must use these terms consistently rather than improvising a different translation for the same concept on different pages (see the i18n implementation prompt, §66/§68).

Database enum values, column names, and stored data are never translated — only the *display* label changes. This glossary governs display labels only.

| Term | Semantic meaning | en-ZA | af-ZA | zu-ZA |
|---|---|---|---|---|
| Buy | Outright purchase, ownership transfers | Buy | Koop | Thenga |
| Rent | Temporary use for a fee, ownership never transfers | Rent | Huur | Qasha |
| Barter | Non-monetary (or partly cash-adjusted) exchange, zero Unity commission | Barter | Ruil | Shintshanisa |
| Available | Supply the poster is offering (item, Skill, or Task) | Available | Beskikbaar | Kuyatholakala |
| Looking For | Demand the poster wants (item, Skill, or Task) — distinct from Available | Looking For | Op Soek Na | Kufunwa |
| Skill | **A teachable instruction — something a person can teach another person.** Never implies a priced service. | Skill | Vaardigheid | Ikhono |
| Task | **Work performed for someone.** Distinct from Skill — see below. | Task | Taak | Umsebenzi |
| Rent-to-Buy | Instalment path from renting to eventual ownership | Rent-to-Buy | Huur-om-te-Koop | Qasha-Uze-Uthenge |
| Sponsored | **Paid advertising disclosure. Must never be softened into "Recommended"/"Featured"/"Popular."** | Sponsored | Geborg | Kuxhaswe Ngemali |
| Advertising Balance | Merchant's prepaid Advertising funds | Advertising balance | Advertensiesaldo | Ibhalansi Yokukhangisa |
| Affiliate | A user earning commission for referring a rental/sale | Affiliate | Filiaal | Umhlanganyeli |
| Escrow | Held funds released on confirmed completion | Escrow | — (not yet enabled; no UI surface exists to translate) | — |
| Deposit | Refundable amount held during a rental | Deposit | Deposito | Idiphozithi |
| Offer | A proposed barter/marketplace exchange | Offer | Aanbod | Umnikelo |
| Booking | A rental reservation | Booking | Bespreking | Ukubhukha |
| Order | A buy/sell transaction | Order | Bestelling | I-oda |
| Merchant | A user listing items/Skills/Tasks for rent, sale, or barter | Merchant | Handelaar | Umthengisi |
| Unity Score | Platform trust/reputation score | Unity Score | Unity-telling *(not yet surfaced in dictionaries — no current UI reads it as translatable copy)* | Amaphuzu e-Unity *(same caveat)* |
| Commission | Unity's or an affiliate's cut of a completed transaction | Commission | Kommissie | Ikhomishini |
| Payout | Funds released to a merchant/affiliate | Payout | Uitbetaling | Inkokhelo |
| Refund | Money returned to a payer | Refund | Terugbetaling | Ukubuyiselwa Kwemali |
| Dispute | A formal disagreement raised on a transaction | Dispute | Geskil | Ukuphikisana |
| Verification | KYC identity/ownership review | Verification | Verifikasie | Ukuqinisekiswa |

## Critical barter terminology safeguards

- **Skill = teachable instruction. Task = work performed for someone.** These must never collapse into the same word in any locale, and neither may be phrased as a priced service — Skills/Tasks carry no monetary value field in the schema, and translated copy must not imply one.
- **Available Skill** = "I can teach this" (`ek kan dit onderrig` / `ngingakufundisa lokhu`) — not "I can learn this." This exact learn/teach ambiguity was caught and corrected during Afrikaans translation (`leer` alone is ambiguous between "learn" and "teach"; `onderrig` is unambiguous).
- **Looking For Skill** = "I want to learn this."
- **Available Task** = "I can do this work." **Looking For Task** = "I need this work done."
- **Available** and **Looking For** must always translate to clearly distinct terms — never variants of the same word.

## Advertising disclosure safeguard

"Sponsored" must always translate to unambiguous **paid commercial disclosure**. Prohibited: any translation equivalent to "Recommended," "Featured," "Popular," or "Top Pick." The Afrikaans (`Geborg`, from `borg` = sponsor/guarantee) and isiZulu (`Kuxhaswe Ngemali`, literally "it is sponsored with money") translations were both chosen specifically to preserve this — isiZulu's phrasing is deliberately more explicit than a bare "sponsored" would be, given the higher ambiguity risk of a shorter form.

## Items requiring native-speaker / legal review before this leaves the current implementation-translation phase

- **isiZulu pluralized count strings** (`common.counts.*`, `lookingFor.offersReceived`): isiZulu's noun-class system means fully grammatically-correct plural agreement is more complex than the two-category (`one`/`other`) ICU plural rule this implementation uses. The current strings are functional and understandable but use a simplified, consistent noun form rather than full per-noun-class agreement — flagged for native-speaker review, not treated as finished/authoritative.
- **Afrikaans "KDK" abbreviation for CTR** (`advertising.dashboard.ctr`): a literal abbreviation of "klik-deur-koers" (click-through rate); not a widely standardized abbreviation in South African Afrikaans business usage — flagged for review; the English initialism "CTR" may be more broadly understood in practice.
- **All legal document translations**: explicitly out of scope for this phase (see `legal.json`'s `translationNotice`/`englishAuthoritative` keys). English legal copy remains sole authoritative; localized legal pages show translated chrome around the English legal body until a reviewed translation exists.
- **Every namespace beyond the set wired into real components in this phase** (see the implementation closure report for the exact list) has real, non-placeholder translations, but has not yet been proofread against actual rendered UI layout by a native speaker of Afrikaans/isiZulu — ordinary implementation-translation quality per the binding instructions' own §68 allowance, not yet a final-review pass.

## Ordinary low-risk product UI

Everything else in `src/i18n/messages/{en-ZA,af-ZA,zu-ZA}/*.json` not called out above is implementation-quality translation, real (not placeholder) text, glossary-consistent, and ready for use — further polish is welcome but not blocking.
