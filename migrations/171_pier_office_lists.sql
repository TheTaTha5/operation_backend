-- The Pier Office lists (todo/pier-office-model.md): legacy's pier_kinds, pier_items, pier_codes,
-- pier_sect, pier_lic_types, pier_lic_classes and pier_staff, edited from the Pier Office pages.
-- Legacy, 2026-10-10: 6 kinds, 41 items, 13 codes, 5 groups, 2 licence types, 4 classes, 72 staff.

-- Kinds of loan equipment, shared by every pier (legacy §poKinds).
CREATE TABLE pier_item_kinds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 40),
  name_en TEXT CHECK (length(name_en) <= 40),   -- printed on the guest sign sheet
  unit TEXT NOT NULL DEFAULT 'ชิ้น' CHECK (length(unit) <= 40),
  color TEXT NOT NULL,
  sort INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

-- Each pier's equipment lines; never deleted, switched off (legacy "ปิด").
CREATE TABLE pier_items (
  id TEXT PRIMARY KEY,
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  kind_id TEXT NOT NULL REFERENCES pier_item_kinds (id),
  label TEXT NOT NULL CHECK (label <> ''),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),   -- bought in total; the balance is the moves'
  active BOOLEAN NOT NULL DEFAULT true,
  note TEXT
);
CREATE INDEX pier_items_kind_idx ON pier_items (kind_id);

-- Roster codes (legacy §pierAtt). `bg` is the tint of `color` (legacy paTint), worked out here.
CREATE TABLE pier_attendance_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (code <> ''),
  label TEXT,
  color TEXT NOT NULL,
  bg TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work', 'off', 'leave', 'none', 'night')),
  sort INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX pier_attendance_codes_code ON pier_attendance_codes (upper(code));

-- Groups heading a pier's roster (legacy §paSect).
CREATE TABLE pier_sections (
  id TEXT PRIMARY KEY,
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL
);

-- Pier staff; never deleted, switched off (legacy "ปิดใช้"). Not logins.
CREATE TABLE pier_staff (
  id TEXT PRIMARY KEY,
  pier TEXT NOT NULL CHECK (pier IN ('tublamu', 'panwa', 'ranong')),
  nick TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  default_code TEXT,                          -- the roster code on a day off the boats
  section_id TEXT REFERENCES pier_sections (id) ON DELETE SET NULL,
  note TEXT,
  sort INTEGER NOT NULL,
  CHECK (nick <> '' OR name <> '')
);
CREATE INDEX pier_staff_section_idx ON pier_staff (section_id);

-- Licence kinds (legacy §pierLic): captain (deck) and engineer (eng); edited, never added.
CREATE TABLE pier_license_types (
  id TEXT PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('deck', 'eng')),
  short TEXT NOT NULL,
  formal TEXT,
  per_boat INTEGER NOT NULL DEFAULT 1 CHECK (per_boat >= 0),
  active BOOLEAN NOT NULL DEFAULT true
);
-- A class of a licence and the largest boat it allows; null = no limit.
CREATE TABLE pier_license_classes (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES pier_license_types (id),
  name TEXT NOT NULL,
  max_gt NUMERIC(10,2) CHECK (max_gt >= 0),
  max_bhp NUMERIC(10,2) CHECK (max_bhp >= 0),
  sort INTEGER NOT NULL
);

-- Legacy's browser seeds (PO_KIND_SEED, the PIER_CODES and PIER_LIC_* defaults), so a fresh system
-- starts as legacy does. The import replaces them with legacy's lists.
INSERT INTO pier_item_kinds (id, name, name_en, unit, color, sort) VALUES
  ('fin', 'ตีนกบ', 'FINS', 'คู่', '#0F6E56', 1),
  ('mask', 'หน้ากาก', 'MASK', 'ชิ้น', '#185FA5', 2),
  ('towel', 'ผ้าเช็ดตัว', 'TOWEL', 'ผืน', '#BA7517', 3);
INSERT INTO pier_attendance_codes (id, code, label, color, bg, kind, sort) VALUES
  ('c_pp', 'PP', 'ทำงาน (ลงเรือ)', '#20477E', '#E9EFF7', 'work', 1),
  ('c_se', 'SE', 'เข้าเวร', '#20477E', '#E9EFF7', 'work', 2),
  ('c_off', 'OFF', 'หยุดประจำสัปดาห์', '#B8BFC9', '#FCFCFD', 'off', 3),
  ('c_ph', 'PH', 'วันหยุดนักขัตฤกษ์', '#9AA3B0', '#FBFBFD', 'off', 4),
  ('c_lwop', 'LWOP', 'ลาไม่รับค่าจ้าง', '#A3251A', '#FDECEA', 'leave', 5),
  ('c_lwp', 'LWP', NULL, '#9B4A3A', '#FBEDE9', 'leave', 6),
  ('c_sc', 'SC', NULL, '#185FA5', '#E7F0FA', 'work', 7),
  ('c_sr', 'SR', NULL, '#0E6E86', '#E3F2F7', 'work', 8),
  ('c_5', '5', NULL, '#4A5568', '#EDEFF3', 'work', 9),
  ('c_abs', 'ABS', 'ขาดงาน', '#A3251A', '#FDECEA', 'none', 10),
  ('c_mt', 'MT', 'งานซ่อม / ขึ้นคาน', '#5B3B96', '#F2EBFA', 'work', 11);
INSERT INTO pier_license_types (id, side, short, formal, per_boat) VALUES
  ('deck', 'deck', 'ใบกัปตัน', 'ประกาศนียบัตรนายท้ายเรือกลเดินทะเล', 1),
  ('eng', 'eng', 'ใบช่างเครื่อง', 'ประกาศนียบัตรช่างเครื่องเรือกลเดินทะเล', 1);
INSERT INTO pier_license_classes (id, type_id, name, max_gt, max_bhp, sort) VALUES
  ('deck1', 'deck', 'ชั้นหนึ่ง', 500, NULL, 1),
  ('deck2', 'deck', 'ชั้นสอง', 60, NULL, 2),
  ('eng1', 'eng', 'ชั้นหนึ่ง', NULL, 3000, 1),
  ('eng2', 'eng', 'ชั้นสอง', NULL, 1000, 2);

-- The change feed announces a list's change (entity: the list's name).
DO $$
DECLARE def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'changes'::regclass AND conname = 'changes_kind_check';
  IF def IS NULL OR position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'changes_kind_check is not the IN (...) list this migration expects: %', def;
  END IF;
  IF position('''pier_office''' IN def) = 0 THEN
    ALTER TABLE changes DROP CONSTRAINT changes_kind_check;
    EXECUTE 'ALTER TABLE changes ADD CONSTRAINT changes_kind_check ' || regexp_replace(def, '\]', ', ''pier_office''::text]');
  END IF;
END $$;
