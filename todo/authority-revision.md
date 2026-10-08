# Moving authority to the server: index

The server decides, clients display (`CLAUDE.md`). Bookings first. Each area's open work lives in
its own note:

| Area | Note |
|---|---|
| Login: deploy steps and the legacy screens' changes | `login-permissions-model.md` |
| Refusing deployment changes that strand sold seats; `license_pax` from the catalogue | `deployment-guards-model.md` |
| `POST /v1/quote` and server-priced bookings | `pricing-model.md`, `rate-types-model.md` |
| Agent writes | `agents.md` |
| Day-of-operations: boats, vans, check-in, reconfirm | `trip-ops-and-vans-model.md` |
| Live updates | `change-feed-model.md` |
| Money, fleet maintenance | not designed yet |

Owned by no other note:

- **Add-on labels** are still the client's (legacy writes them from its add-on catalogue); `amount` is
  computed.
- **A checklist of legacy's business rules**: each rule in `allotment_v2/js` (wt-lk-inbox) and the
  endpoint that will own it. `legacy-replacement.md` lists only the data.
- **Love Kingdom:** a contract change ships on both sides together
  (`docs/love-kingdom-integration.md`).
