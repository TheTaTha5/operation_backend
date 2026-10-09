-- Attachments (todo/booking-extras-model.md §1, approved 2026-10-09): files kept in PostgreSQL, as
-- legacy keeps them (allotment.attachments, bytea). One file table, and one reference table per owner
-- so each keeps its foreign key. This migration covers a booking's documents and its upgrade sales'
-- payment slips; the other slips come with the payments model. Legacy, 2026-10-09: 6,342 files,
-- 699 MB, all JPEG, PNG or PDF, the largest 1.4 MB.

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                       -- legacy's att_<time>_<hex>, kept
  filename TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 6291456),
  data BYTEA NOT NULL,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A booking's documents (legacy bk.attachments): the agent's voucher, passports, a capture.
CREATE TABLE booking_documents (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  kind TEXT CHECK (kind IN ('upload', 'capture', 'paste')),
  by TEXT,
  at TIMESTAMPTZ,
  PRIMARY KEY (booking_id, seq)
);
CREATE INDEX booking_documents_attachment_idx ON booking_documents (attachment_id);

-- An upgrade sale's payment slips (legacy upgrades[].slips).
CREATE TABLE booking_upgrade_slips (
  booking_id TEXT NOT NULL,
  upgrade_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (booking_id, upgrade_id, seq),
  FOREIGN KEY (booking_id, upgrade_id) REFERENCES booking_upgrades (booking_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_upgrade_slips_attachment_idx ON booking_upgrade_slips (attachment_id);
