# Pier office: petty cash and the office lists

Legacy read on wt-lk-inbox@658298d (`allotment_v2/js/08-app.js` §poCash, §pcRows, §pcSum, §pcCalc,
§pkNat, §pcPrint, §pcPick, §pierOffice, §poKinds, §pierAtt, §paSect, §pierLic, §pierEdit;
`01-auth-sync.js` §poCash; `05-fleet.js` `fdStaffAt`) and legacy data read-only on 2026-10-10.
Built on `feat/pier-office` (migrations 170–171).

## What legacy does

### Petty cash (`pop-<pier>`, "เงินสดย่อย")

A cash box per pier (Panwa, Tub Lamu, Ranong). Money never resets: yesterday's balance is today's
opening. Three tabs:

1. **Main (ledger, "สมุดเดินบัญชี")** for one chosen day. Four cards: opening ("ยอดยกมา" = every
   earlier day's in − out at that pier), in today, out today, balance in hand (opening + in − out;
   below 0 shows "⚠ ติดลบ · ตรวจรายการ", **a warning, never a refusal**). Rows sorted by the time
   typed (rows with no time last), each with a running balance; the category is "รับเงิน", or for
   out "หางยาว"/"อุทยาน"/"ค่าจอด" when pulled from a sheet, else "จ่ายอื่น".
   - **Add** (`pcRowSave`): dialog with text, time (defaults to now), amount. Refused in the browser
     when the amount is not above 0 ("ใส่จำนวนเงินก่อนครับ"). The amount is rounded to whole baht
     (`pcNum`). No edit of a saved row.
   - **Delete** (`pcRowDel`): after a `confirm()`, removed for good.
   - **Month table** ("รวมทั้งเดือน") above the ledger: every day of the month that has money rows or
     boats running at the pier, with opening, in, out, balance, and three *reference* figures from the
     other two tabs (longtail paid, park fees paid, dock fees), which do **not** count in the ledger
     until **"⤓ ดึง" (pull)** copies them in as out rows (`src` lt/pk/dock, text "ค่าเรือหางยาว
     (ดึงจากชีท)" …). A category already pulled that day is not pulled again; nothing new →
     alert "ไม่มียอดใหม่ให้ดึง". "Waiting" = reference − pulled.
   - **Select rows** (§pcPick, browser memory only) and sum them; **print** the day's ledger, or a
     **"ใบรับรองแทนใบเสร็จรับเงิน"** (receipt-substitute certificate) of the day's out rows, or of the
     selected out rows only ("No rows selected." when none). The certificate needs the company name
     (`po_cash_co`, one string for all piers); first print without it opens the name dialog. The total
     is printed in Thai words (`pcBahtText`, whole baht) and dates in Thai Buddhist era (`pcThDate`).
2. **Longtail ("เรือหางยาว")**, a month sheet: per day, per boat running from the pier, read from
   bookings: join heads and charter boats (`pxLongtail`: `bkLtState`, on-board after no-shows); keyed
   by the pier: boats actually used for join (`nj`) and charter (`nc`), money paid (`amt`), note.
   Legacy also keeps `n = nj + nc`. A cell with nothing left is removed.
3. **Park fees ("ค่าอุทยาน")**, a month sheet: per day and boat, heads by nationality and age read
   from bookings (`pcPax`: on-board after check-in, `t.nat` real nationality, lost passengers by
   type), the expected fee (cost plan's park line × heads, `pcParkRate`; INF 0, FOC adult price);
   keyed: the 8 head counts paid at the gate (`ad_th … foc_fr`), money paid (`amt`), dock fee
   (`dock`), and which set "⤓ เติมจากใบจอง" filled from (`src` nat/price). A cell with no count, no
   money and no dock fee is removed. "ต่าง" = paid − expected.

Who may write: `pcGuard` → `poCanEdit`: the `pier` edit area, or `operations` for an account whose
edit list predates `pier` (§pierEdit). Seeing the page is the view right `pop-<pier>` (back-filled
from `po-<pier>`). Everyone stamps `by` (`ckMe`) and `ts`.

**No link to the hand-over.** Legacy's petty cash never reads pier payments or on-tour sales, and the
hand-over at day close (migration 111) is this service's own; nothing links them here either.

### The office lists (§pierOffice, §pierAtt, §pierLic)

All edited from the Pier Office pages under `poCanEdit` (pier, or operations as above), saved whole
by `poPersist`:

| List | What it is | Edited where | Read by |
|---|---|---|---|
| `pier_kinds` (6) | kinds of loan equipment: name, English name (printed on the guest sign sheet), unit, colour, order | "ทะเบียนของ" dialog, shared by every pier | stock board, sign-out sheets (`PO_KIND`) |
| `pier_items` (41) | each pier's equipment line (kind, label e.g. "ตีนกบ · L (42-44)", total bought, active) | "ทะเบียนของ" per pier | stock board and moves (`pier_moves`), sign sheets |
| `pier_codes` (13) | roster codes (PP, SE, OFF, PH, LWOP, …): label, colour and tint, counts as work/off/leave/none/night | "ทะเบียนรหัส" (roster) | roster (`pier_shift`), pay (`pier_cfg.payRules`) |
| `pier_sect` (5) | groups heading the roster per pier (office, service, …) | roster "กลุ่ม" dialog | roster |
| `pier_lic_types` (2) | licence kinds: captain (deck), engineer (eng): short and formal name, how many each boat needs | "ทะเบียนประเภทใบ" | licences page (`pier_licenses`) |
| `pier_lic_classes` (4) | classes of a licence type with the largest boat it allows (gross tonnage, bhp) | same dialog | licences page: is a licence good for a boat |
| `pier_staff` (72) | pier staff: nick, full name, role, phone, home pier, active, default roster code, group, note, order | "ทะเบียนพนักงาน", roster | roster, duty and job sheets, licences, Fleet dashboard (`fdStaffAt` counts captains by role) |

Rules legacy keeps (browser only):
- **Kinds:** a kind still used by items cannot be deleted (alert, a refusal). Name, English name and
  unit are cut to 40 characters. New kinds go last; ▲▼ swap order.
- **Items:** a label is required; a new item needs a kind (alert when there are none); total is a
  whole number. No delete: "ปิด" (active off) keeps it countable.
- **Staff:** nick or full name required; the missing one copies the other. No delete: "ปิดใช้".
  The default code is upper-cased. Moving into a group puts the person last in it (`paStaffSect`).
- **Groups:** deleting a group that has people asks first (`confirm`), then they become unassigned.
- **Codes:** the colour picked sets the tint (`paTint`). Deleting a code in use in the roster asks
  first. New code "NEW", kind none.
- **Licence types:** only short name, formal name and per-boat count are edited; no add or delete.
- **Licence classes:** "ชั้นใหม่" by default; empty limit = no limit; delete asks first when licences
  use it.
- **Seeds:** with nothing saved, the browser starts from 3 kinds, 7 items per pier, 11 codes, 2
  licence types and 4 classes.

## Legacy data (2026-10-10, read-only)

| Table | Rows | Money |
|---|---|---|
| `po_cash_rows` | Panwa 38 in, 114 out; Tub Lamu 1 out (153) | in ฿169,828; out ฿159,728 + ฿1,800 |
| `po_cash_lt` | 54 (Panwa) | ฿190,000 (one cell has no amount) |
| `po_cash_pk` | 61 (Panwa) | ฿661,280 park + ฿10,500 dock |
| `app_meta.po_cash_co` | "เลิฟ ไอแลนด์" | |

All rows are whole baht, every row has a time, no row was ever pulled (`src` empty everywhere), no
longtail cell has `n` without `nj`/`nc` and `n = nj + nc` always, no park cell has `src`. Eight boats
appear, all in the catalogue. `po_cash_panwa` (a string in `app_meta`) is the pre-table copy;
the tables are what the screen reads.

Lists: 6 kinds, 41 items (Panwa 21, Tub Lamu 13, Ranong 7; 2 inactive), 13 codes (kinds work, off,
leave, none, **night**), 5 groups (Panwa), 2 licence types, 4 classes, 72 staff (Panwa 32 with order
and groups, 4 inactive; Tub Lamu 40 with no order). No item names a missing kind, no staff a missing
group.

## Design

### Petty cash: fields and authority

**A ledger row** (`pier_cash_rows`):

| Field | Kind | Rule |
|---|---|---|
| `id` | computed | `pc_…`; legacy's `pc…` kept on import |
| `pier`, `date` | client fact | from the path; pier one of tublamu, panwa, ranong |
| `kind` | client fact | `in` or `out` |
| `description` | client fact | legacy `txt`, may be empty |
| `amount` | validated | above 0, to the satang |
| `time` | client fact | `HH:MM`, optional (legacy `at`) |
| `source` | computed | `longtail`/`park`/`dock` only when made by **pull**; refused on a write |
| `created_at`, `created_by` | computed | |
| `deleted_at/_by`, `delete_reason` | computed | by `DELETE` |
| `balance` (read) | computed | running balance after the row |

**A longtail cell** (`pier_cash_longtail`, key pier + date + boat): `join_boats`, `charter_boats`
(whole, ≥ 0, client facts), `amount` (≥ 0, client fact), `note`; computed `used_boats` (=
join + charter, legacy `n`), `updated_at/_by`. All empty → the cell is removed.

**A park cell** (`pier_cash_park`): `ad_th, chd_th, inf_th, foc_th, ad_fr, chd_fr, inf_fr, foc_fr`
(whole, ≥ 0), `amount` (park fee paid), `dock` (dock fee), `filled_from` (`nat`/`price`, client
fact: the set a client's "fill from bookings" used); computed `heads` (the 8 counts), `updated_at/_by`.
No count, no amount and no dock fee → removed.

**Settings** (`pier_cash_settings`, one row): `company_name` (client fact).

**Computed on read:** a day's opening, in, out, closing, the reference figures (`longtail`, `park`,
`dock`, their sum `reference`), `pulled` (out rows with a source), `waiting` (reference − pulled,
not below 0), `negative` (closing below 0, the warning). The boats of a day: those deployed on a
route of the pier, plus any boat with a cell that day.

### Migration 170 `pier_cash.sql`

```sql
CREATE TABLE pier_cash_rows (
  id TEXT PRIMARY KEY,
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  cash_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  description TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  time TEXT CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  source TEXT CHECK (source IN ('longtail', 'park', 'dock')),
  created_at TIMESTAMPTZ NOT NULL, created_by TEXT,
  deleted_at TIMESTAMPTZ, deleted_by TEXT, delete_reason TEXT,
  CHECK (source IS NULL OR kind = 'out')
);
CREATE INDEX pier_cash_rows_day_idx ON pier_cash_rows (pier, cash_date);
-- One live pulled row per category and day (legacy pulls a category once).
CREATE UNIQUE INDEX pier_cash_rows_pulled ON pier_cash_rows (pier, cash_date, source) WHERE source IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE pier_cash_longtail (
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  cash_date DATE NOT NULL,
  boat_id TEXT NOT NULL REFERENCES boats (id),
  join_boats INTEGER CHECK (join_boats >= 0), charter_boats INTEGER CHECK (charter_boats >= 0),
  amount NUMERIC(12,2) CHECK (amount >= 0), note TEXT,
  updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT,
  PRIMARY KEY (pier, cash_date, boat_id)
);
CREATE TABLE pier_cash_park (… same key, ad_th … foc_fr INTEGER CHECK (>= 0), amount, dock NUMERIC(12,2) CHECK (>= 0),
  filled_from TEXT CHECK (filled_from IN ('nat', 'price')), updated_at, updated_by);
CREATE TABLE pier_cash_settings (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), company_name TEXT, updated_at TIMESTAMPTZ, updated_by TEXT);
-- change feed: 'pier_cash', appended as migration 100 does.
```

### Migration 171 `pier_office_lists.sql`

```sql
CREATE TABLE pier_item_kinds (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 40),
  name_en TEXT CHECK (length(name_en) <= 40), unit TEXT NOT NULL DEFAULT 'ชิ้น' CHECK (length(unit) <= 40),
  color TEXT NOT NULL, sort INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE pier_items (id TEXT PRIMARY KEY, pier TEXT NOT NULL CHECK (pier IN (…)), kind_id TEXT NOT NULL REFERENCES pier_item_kinds (id),
  label TEXT NOT NULL CHECK (label <> ''), total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0), active BOOLEAN NOT NULL DEFAULT true, note TEXT);
CREATE TABLE pier_attendance_codes (id TEXT PRIMARY KEY, code TEXT NOT NULL CHECK (code <> ''), label TEXT, color TEXT NOT NULL, bg TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work', 'off', 'leave', 'none', 'night')), sort INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT true);
CREATE UNIQUE INDEX pier_attendance_codes_code ON pier_attendance_codes (upper(code));
CREATE TABLE pier_sections (id TEXT PRIMARY KEY, pier TEXT NOT NULL CHECK (…), name TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL);
CREATE TABLE pier_staff (id TEXT PRIMARY KEY, pier TEXT NOT NULL CHECK (…), nick TEXT NOT NULL, name TEXT NOT NULL, role TEXT, phone TEXT,
  active BOOLEAN NOT NULL DEFAULT true, default_code TEXT, section_id TEXT REFERENCES pier_sections (id) ON DELETE SET NULL, note TEXT, sort INTEGER NOT NULL,
  CHECK (nick <> '' OR name <> ''));
CREATE TABLE pier_license_types (id TEXT PRIMARY KEY, side TEXT NOT NULL CHECK (side IN ('deck', 'eng')), short TEXT NOT NULL, formal TEXT,
  per_boat INTEGER NOT NULL DEFAULT 1 CHECK (per_boat >= 0), active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE pier_license_classes (id TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES pier_license_types (id), name TEXT NOT NULL,
  max_gt NUMERIC(10,2) CHECK (max_gt >= 0), max_bhp NUMERIC(10,2) CHECK (max_bhp >= 0), sort INTEGER NOT NULL);
-- Legacy's browser seeds (kinds, codes, licence types and classes), so a fresh system starts as legacy does.
-- change feed: 'pier_office', appended.
```

Every list field is a client fact except: `id` (computed), `bg` of a code (computed from `color`,
legacy `paTint`, refused on a write), a staff member's `sort` when their group changes (computed:
last in the new group). `sort` is otherwise set by an order command.

### Contract

Pier cash (writes: `pier` or `operations`; reads: any staff login, never an agent's):

```
GET    /v1/pier-cash/{pier}/days/{date}                 the ledger day
POST   /v1/pier-cash/{pier}/days/{date}/rows            add  {kind, description?, amount, time?}       201
DELETE /v1/pier-cash/rows/{id}?reason=                  delete (kept, out of every total)               200
POST   /v1/pier-cash/{pier}/days/{date}/pull            pull the sheets' totals in as out rows          201 | 409 nothing_to_pull
GET    /v1/pier-cash/{pier}/days/{date}/certificate?ids=a,b   the receipt-substitute certificate       409 company_name_missing
GET    /v1/pier-cash/{pier}/months/{yyyy-mm}            the month table
GET    /v1/pier-cash/{pier}/months/{yyyy-mm}/longtail[?date=]   the longtail sheet
GET    /v1/pier-cash/{pier}/months/{yyyy-mm}/park[?date=]       the park sheet
PATCH  /v1/pier-cash/{pier}/days/{date}/longtail/{boat_id}      {join_boats?, charter_boats?, amount?, note?}
PATCH  /v1/pier-cash/{pier}/days/{date}/park/{boat_id}          {ad_th? … foc_fr?, amount?, dock?, filled_from?}
GET    /v1/pier-cash/settings, PUT /v1/pier-cash/settings       {company_name}
```

```json
GET /v1/pier-cash/panwa/days/2026-10-08   (figures illustrative)
{ "pier": "panwa", "date": "2026-10-08", "opening": 12100, "in": 0, "out": 4350, "closing": 7750, "negative": false,
  "reference": { "longtail": 11000, "park": 17540, "dock": 200, "total": 28740 }, "pulled": 0, "waiting": 28740,
  "rows": [ { "id": "pc1791444743497z1j", "kind": "out", "description": "ค่า TAXI 1 …", "amount": 1200, "time": "14:30",
              "source": null, "created_by": "GSA.PK02", "created_at": "…", "balance": 10900 } ] }
```

Errors: `400` bad pier/date/amount/time, a server-owned field (`source`, `used_boats`, `heads`) or an
unknown field; `404` an unknown row or boat; `409 nothing_to_pull` ("No new totals to pull: already
pulled, or nothing entered in the longtail and park sheets"), `409 row_deleted`, `409
company_name_missing`.

Office lists (writes: `pier` or `operations`):

```
GET    /v1/pier-office[?pier=]                     every list
POST   /v1/pier-office/item-kinds | items | attendance-codes | sections | staff | license-classes   201
PATCH  /v1/pier-office/{list}/{id}                 every list (license-types: short, formal, per_boat only)
DELETE /v1/pier-office/item-kinds/{id}             409 kind_in_use while items use it
DELETE /v1/pier-office/attendance-codes/{id}
DELETE /v1/pier-office/sections/{id}?unassign_anyway=true   409 section_in_use without it
DELETE /v1/pier-office/license-classes/{id}
POST   /v1/pier-office/item-kinds/order {ids}, attendance-codes/order {ids}, sections/order {pier, ids}, staff/order {pier, ids}
```

### Import

`npm run import:pier-office` (`src/tools/import-pier-office.ts`, mapping `legacy-pier-office.ts`,
dry run unless `--commit`, source read-only). Legacy is master until the pier area cuts over, so a
rerun replaces: the lists whole (in key order), the petty cash rows with legacy ids (rows made here,
`pc_…`, are kept) and every sheet cell; the company name. Amounts as legacy has them, `src`
lt/pk/dock → `source`, `at` → `time`, `txt` → `description`; a cell or row naming a boat not in the
catalogue, a bad date or a non-positive amount is listed and skipped. Staff with no order get one
after the ordered ones, in legacy's row order.

## Open

1. **The read side of the two sheets** is not built: booked join heads and charter boats per boat
   (`pxLongtail`), on-board heads by nationality (`pcPax`, with `pckOnBoard`, `ckLostByType`, trip
   `nat`), the expected park fee from the cost plan's park line (`pcParkRate`), and the fill panel.
   They need the cost model (cost plans are not here; `money-reports.ts` leaves trip costs out) and
   a port of legacy's on-board count. The sheets show what the pier keyed and the boats of the day.
2. **The park tickets page** (`pok-<pier>`, §pkTk) reads the same heads (`pcPax`) and writes
   `pier_cfg.parkTypes/parkFix/parkName`: not built.
3. **The rest of the Pier Office data** has no home yet: `pier_moves` (1,177 stock moves),
   `pier_sheet` (84 sign-out sheets with deposits), `pier_shift` (1,151 roster cells), `pier_duty`
   (81), `pier_job` (239 job sheets), `pier_team` (1), `pier_licenses` (29), `pier_cfg` (19 keys:
   pay rates per staff, pay rules, roster settings, licence warning days, park ticket types).
   Deleting a code, group or licence class does not yet check those (legacy asks when they are used).
4. **Legacy's item seed** (7 sample lines per pier) is not seeded: a fresh pier starts with none.

## Flagged

- **A deleted row is kept**, out of every total (as pier payments, decided 2026-10-09); legacy
  removes it. Pull may then run again for that category.
- **Amounts keep satang**; legacy rounds to whole baht. The certificate's Thai words add "…สตางค์".
- **`source` is server-only**: a client cannot write a "pulled" row by hand.
- **A sheet cell for a boat not in the catalogue is `404`**; legacy stores any id.
- **The sheets also list a boat that has a cell but no deployment that day**, so nothing typed is
  hidden; legacy showed only boats running that day, while still counting the hidden money.
- **An attendance code must be unique** (case-insensitive); legacy matched the first.
- **A negative item total is refused**; legacy's `parseInt` let one through.
- **`bg` follows `color`** on every colour change (legacy `paTint`); the designed palette of the
  seeds and legacy's "use standard colours" reset are not here.
- **Staff `sort`** is set for every person on import (legacy's unordered Tub Lamu staff keep their
  row order); a person moved to another pier keeps their place number.
