# Contracts: what is still open

Built: migration 029, `GET /v1/contracts`, `GET /v1/contracts/{id}`, `npm run import:contracts`
(README → "Contracts"). These are for the pricing steps (`pricing-model.md`).

- **Main contracts are frozen snapshots.** Legacy made them once (2026-07-23); renewals since change
  only the agent's fields (74 agents' dates and 259 agents' rate types differ from their main
  contract). A discount promo prices from the main contract's rate (`laPromoMainRt`: the **first**
  main in legacy's list, whatever its status, else the agent's rate). Legacy loads contracts ordered
  by `id` (`os_repo.js` `§stableOrder`), so "first" is the smallest id, and an archived `ct_hist_…`
  sorts before `ct_main_…`. Copied as decided: the quote orders by id the same way.
- **Main contracts drift from their agent** (259 rates, 73 end dates): decided 2026-10-09 to copy
  legacy, so the agent's `contract_*` fields are the truth for the Agents screen and a renewal makes
  no contract row (`sales-editing-model.md` 6). A rate change syncs the active main contract's rate.
- **`import:contracts` reruns** overwrite a main contract's rate and `doc_id`, which are set here now:
  make it seed-only like the agents import (`sales-editing-model.md`, Flagged).
- **Writes** (the promo form, `ctSaveAddPromo`: `POST`/`PATCH /v1/contracts`, area `sales`) come
  with the quote, with legacy's warning when an edited promo was already sold.
- `booking_trips.promo_id` (legacy `trip.promoId`; no legacy trip uses it yet) arrives with step 5.
