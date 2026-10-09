-- The add-on service catalogue (todo/sales-editing-model.md, decision 10). Legacy's "Add-on
-- Services" screen showed three hard-coded services and never saved an edit, so this starts empty:
-- what it lists must come from sales. A service has variants, each with a selling and a net price.
CREATE TABLE addon_services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- Legacy's icons: boat, van, guide, other.
  type        TEXT NOT NULL CHECK (type IN ('boat', 'van', 'guide', 'other')),
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  sort        INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addon_service_variants (
  service_id TEXT NOT NULL REFERENCES addon_services (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  -- What the price is per, as legacy wrote it: "per person · share boat", "per van (8–10 pax)".
  unit       TEXT,
  selling    NUMERIC(12,2) CHECK (selling >= 0),
  net        NUMERIC(12,2) CHECK (net >= 0),
  PRIMARY KEY (service_id, id)
);
