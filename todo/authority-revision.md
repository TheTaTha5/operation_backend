# Moving authority to the server: index

The server decides, clients display (`CLAUDE.md`). Bookings first. Each area's open work lives in
its own note:

| Area | Note |
|---|---|
| Login: deploy steps and the legacy screens' changes | `login-permissions-model.md` |
| Refusing deployment changes that strand sold seats; `license_pax` from the catalogue | `deployment-guards-model.md` |
| `POST /v1/quote` and server-priced bookings | `pricing-model.md`, `rate-types-model.md` |
| Agent writes | `agents.md` |
| Day-of-operations: boats, vans, check-in, reconfirm | built; open items in `trip-ops-and-vans-model.md` |
| Live updates | built; open items in `change-feed-model.md` |
| Money | `money-model.md` |
| Fleet maintenance | `fleet-maintenance-model.md` |
| Every legacy browser rule and whether this API owns it (`legacy-replacement.md` lists only the data) | `legacy-browser-rules.md` |

Owned by no other note:

- **Add-on labels** are still the client's (legacy writes them from its add-on catalogue); `amount` is
  computed.
- **Love Kingdom:** a contract change ships on both sides together
  (`docs/love-kingdom-integration.md`).
