# Creating a booking: flowchart and sequence diagram

How `POST /v1/bookings` works, drawn from the code on `feat/route-calendar-rules` (2026-10-08).
Recovered from the Claude session that drew them. View the Mermaid blocks in the VS Code Markdown
preview, on GitHub, or at mermaid.live.

## In short

The client never picks the status. It sends the trips and says which button was pressed: `intent: "quote"` or `"confirm"`. The server then:
1. Checks you're logged in.
2. Checks every route exists and runs that day.
3. Weighs the seats day by day.
4. Decides the status from those facts.
5. Saves it all in one transaction (a group of writes that either all succeed or all undo).

If any day is refused, nothing is saved.

## Flowchart: `POST /v1/bookings`

```mermaid
flowchart TD
    A["Client sends POST /v1/bookings<br/>trips + intent: quote or confirm"] --> B{"Valid Bearer token<br/>with booking:write?"}
    B -- no --> X1["401 / 403"]
    B -- yes --> C{"Every route in<br/>the catalogue?"}
    C -- no --> X2["400 unknown route"]
    C -- yes --> D{"Route runs that day?<br/>(calendar: seasons + overrides)"}
    D -- "no, and not a b2c_ booking" --> X3["409 route_closed"]
    D -- yes --> E["For each route+day:<br/>lock that day's seat pool,<br/>read boats, bookings, seat locks"]
    E --> F{"Land route, or<br/>no boat deployed yet?"}
    F -- yes --> OK["Day fits (no seat limit)"]
    F -- no --> G{"Fits the seats on sale?"}
    G -- yes --> OK
    G -- no --> H{"Would only fit by taking<br/>other agents' locked seats?"}
    H -- yes --> X4["409 rest held by seat locks"]
    H -- no --> I{"Within the boats'<br/>registered seats (license_pax)?"}
    I -- no --> X5["409 registered seats full"]
    I -- yes --> OVER["Day is OVER the allotment<br/>(needs a manager)"]
    OK --> J["decideStatus"]
    OVER --> J
    J --> K{"intent = confirm with FOC pax<br/>but no foc_reason?"}
    K -- yes --> X6["400 foc_reason is required"]
    K -- no --> L{"Any day over the allotment,<br/>or confirm with a discount?"}
    L -- yes --> P["pending_approval<br/>(+ approval record)<br/>over allotment = holds NO seats"]
    L -- no --> M{"intent?"}
    M -- quote --> Q["quote"]
    M -- confirm --> N{"FOC (free) pax?"}
    N -- yes --> PF["pending_foc"]
    N -- no --> CF["confirmed<br/>stamp confirmed_by / confirmed_at"]
    P --> S["INSERT booking, trips, passengers,<br/>add-ons, approvals, history"]
    Q --> S
    PF --> S
    CF --> S
    S --> T["COMMIT → 201 + booking"]
```

## Sequence diagram: the same request, step by step

```mermaid
sequenceDiagram
    autonumber
    actor Staff as Client (Vue app / legacy / Love Kingdom)
    participant API as Fastify (routes/operations.ts)
    participant Auth as Authenticator (auth.ts)
    participant Store as PostgresOperationsStore
    participant Cal as calendar.ts
    participant Cap as capacity.ts
    participant Appr as booking-approvals.ts
    participant DB as PostgreSQL

    Staff->>API: POST /v1/bookings {trips, intent, header, passengers, addOns}
    API->>Auth: authenticate(Bearer token)
    Auth-->>API: user + scopes (needs booking:write)
    API->>API: bookingInput() parse, createHeader() sets created_by/booked_at from the token
    API->>Store: transaction(createBooking)
    Store->>DB: BEGIN ISOLATION LEVEL SERIALIZABLE
    Store->>DB: SELECT routes (assertRoutes)
    Store->>Cal: assertRoutesOpen(calendar, trips)
    Cal-->>Store: ok, or throws 409 route_closed
    loop each route+day, in sorted order
        Store->>DB: pg_advisory_xact_lock("route:date")
        Store->>DB: read deployments, trips that hold seats, seat locks
        Store->>Cap: dayCapacity() then weighDay(day, demand)
        Cap-->>Store: fits / over by N / throws 409
    end
    Store->>Appr: decideStatus(intent, {focCount, focReason, discount, overDays})
    Appr-->>Store: status + approvals + history lines
    Store->>DB: INSERT bookings, booking_trips, passengers, add-ons
    Store->>DB: INSERT booking_approvals (+ days), booking history
    Store->>DB: COMMIT (a serialization conflict rolls back and retries)
    Store-->>API: booking
    API-->>Staff: 201 {status, allocated_pax, approvals, ...}
```

## What to notice

- **Seat-pool lock:** `pg_advisory_xact_lock` is a lock held only until the transaction ends, one per route+day. Two people booking the same boat on the same day wait in line instead of both getting the last seat. Days are locked in sorted order, so two bookings can't each grab one day and block each other.
- **Same rules in both stores:** the in-process store (`src/domain/operations.ts:548`) calls the same `weighDay` and `decideStatus`. Only the reading and writing of data differ.
- **Seat-holding rule:** a waiting over-allotment booking holds 0 seats until it's approved. Otherwise it would take the very room it's waiting for. A booking waiting only for a discount approval does hold its seats.
- **After create:** the status changes only through commands: `/confirm`, `/approve`, `/reject`, `/cancel`, `/cancel-weather`, `/restore`. `PATCH` changes client facts (names, notes, trips), and sending it a different `status` is a `400`.
