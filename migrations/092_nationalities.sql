-- Nationalities (todo/sales-editing-model.md, decision 11): the server owns the list the booking form
-- picks from. Legacy hard-codes 73 built-ins in the browser (`BKV2_NATIONALITIES`) and stores only the
-- custom ones typed into the booking form (`sb_nationalities`); both live here. The same built-ins are
-- `BUILTIN_NATIONALITIES` in src/domain/nationalities.ts, for the in-process store.
-- Legacy's 65 custom ones arrive with the import, unmerged: merging rewrites 218 bookings (later).
CREATE TABLE nationalities (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  builtin    BOOLEAN NOT NULL,
  -- The built-ins' order in legacy's list; null for custom ones, which follow by creation.
  sort       INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

INSERT INTO nationalities (code, name, builtin, sort, created_at) VALUES
  ('TH', 'Thai', true, 1, '2026-01-01'), ('CN', 'Chinese', true, 2, '2026-01-01'),
  ('RU', 'Russian', true, 3, '2026-01-01'), ('IN', 'Indian', true, 4, '2026-01-01'),
  ('KR', 'Korean', true, 5, '2026-01-01'), ('JP', 'Japanese', true, 6, '2026-01-01'),
  ('US', 'American', true, 7, '2026-01-01'), ('GB', 'British', true, 8, '2026-01-01'),
  ('DE', 'German', true, 9, '2026-01-01'), ('FR', 'French', true, 10, '2026-01-01'),
  ('IT', 'Italian', true, 11, '2026-01-01'), ('ES', 'Spanish', true, 12, '2026-01-01'),
  ('AU', 'Australian', true, 13, '2026-01-01'), ('NZ', 'New Zealander', true, 14, '2026-01-01'),
  ('CA', 'Canadian', true, 15, '2026-01-01'), ('NL', 'Dutch', true, 16, '2026-01-01'),
  ('SE', 'Swedish', true, 17, '2026-01-01'), ('NO', 'Norwegian', true, 18, '2026-01-01'),
  ('DK', 'Danish', true, 19, '2026-01-01'), ('FI', 'Finnish', true, 20, '2026-01-01'),
  ('PL', 'Polish', true, 21, '2026-01-01'), ('UA', 'Ukrainian', true, 22, '2026-01-01'),
  ('KZ', 'Kazakh', true, 23, '2026-01-01'), ('IL', 'Israeli', true, 24, '2026-01-01'),
  ('SG', 'Singaporean', true, 25, '2026-01-01'), ('MY', 'Malaysian', true, 26, '2026-01-01'),
  ('ID', 'Indonesian', true, 27, '2026-01-01'), ('PH', 'Filipino', true, 28, '2026-01-01'),
  ('VN', 'Vietnamese', true, 29, '2026-01-01'), ('TW', 'Taiwanese', true, 30, '2026-01-01'),
  ('HK', 'Hong Konger', true, 31, '2026-01-01'), ('AE', 'Emirati', true, 32, '2026-01-01'),
  ('SA', 'Saudi', true, 33, '2026-01-01'), ('BR', 'Brazilian', true, 34, '2026-01-01'),
  ('AR', 'Argentinian', true, 35, '2026-01-01'), ('MX', 'Mexican', true, 36, '2026-01-01'),
  ('ZA', 'South African', true, 37, '2026-01-01'), ('EG', 'Egyptian', true, 38, '2026-01-01'),
  ('TR', 'Turkish', true, 39, '2026-01-01'), ('IR', 'Iranian', true, 40, '2026-01-01'),
  ('CH', 'Swiss', true, 41, '2026-01-01'), ('AT', 'Austrian', true, 42, '2026-01-01'),
  ('BE', 'Belgian', true, 43, '2026-01-01'), ('PT', 'Portuguese', true, 44, '2026-01-01'),
  ('GR', 'Greek', true, 45, '2026-01-01'), ('IE', 'Irish', true, 46, '2026-01-01'),
  ('CZ', 'Czech', true, 47, '2026-01-01'), ('SK', 'Slovak', true, 48, '2026-01-01'),
  ('RO', 'Romanian', true, 49, '2026-01-01'), ('HU', 'Hungarian', true, 50, '2026-01-01'),
  ('BG', 'Bulgarian', true, 51, '2026-01-01'), ('HR', 'Croatian', true, 52, '2026-01-01'),
  ('RS', 'Serbian', true, 53, '2026-01-01'), ('BY', 'Belarusian', true, 54, '2026-01-01'),
  ('GE', 'Georgian', true, 55, '2026-01-01'), ('UZ', 'Uzbek', true, 56, '2026-01-01'),
  ('KH', 'Cambodian', true, 57, '2026-01-01'), ('LA', 'Lao', true, 58, '2026-01-01'),
  ('MM', 'Burmese', true, 59, '2026-01-01'), ('BD', 'Bangladeshi', true, 60, '2026-01-01'),
  ('PK', 'Pakistani', true, 61, '2026-01-01'), ('LK', 'Sri Lankan', true, 62, '2026-01-01'),
  ('NP', 'Nepali', true, 63, '2026-01-01'), ('QA', 'Qatari', true, 64, '2026-01-01'),
  ('KW', 'Kuwaiti', true, 65, '2026-01-01'), ('OM', 'Omani', true, 66, '2026-01-01'),
  ('BH', 'Bahraini', true, 67, '2026-01-01'), ('JO', 'Jordanian', true, 68, '2026-01-01'),
  ('LB', 'Lebanese', true, 69, '2026-01-01'), ('CL', 'Chilean', true, 70, '2026-01-01'),
  ('CO', 'Colombian', true, 71, '2026-01-01'), ('PE', 'Peruvian', true, 72, '2026-01-01'),
  ('OTHER', 'Other', true, 73, '2026-01-01');
