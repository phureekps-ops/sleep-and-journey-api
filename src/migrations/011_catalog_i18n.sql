-- Multi-language catalog support (TH / EN / ZH / JA).
--
-- Design principle: branches.name/description and room_types.name/description
-- STAY as they are and continue holding the Thai (default) text - every
-- existing query in bookingService, availabilityService, adminBookings, etc.
-- keeps working unchanged. These new *_translations tables are an OVERLAY:
-- only populated for languages OTHER than Thai. A LEFT JOIN + COALESCE falls
-- back to the base table's Thai text whenever a translation row is missing,
-- so the catalog never shows a blank field just because a translator hasn't
-- gotten to it yet.
--
-- Run after the room-catalog migration (branches/room_types columns must
-- already exist). Number this file after your latest migration.

CREATE TABLE IF NOT EXISTS languages (
  code         VARCHAR(5) PRIMARY KEY,  -- 'th' | 'en' | 'zh' | 'ja'
  name_native  VARCHAR(50) NOT NULL,
  name_en      VARCHAR(50) NOT NULL,
  sort_order   SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO languages (code, name_native, name_en, sort_order) VALUES
  ('th', 'ไทย',     'Thai',     0),
  ('en', 'English', 'English',  1),
  ('zh', '中文',     'Chinese',  2),
  ('ja', '日本語',   'Japanese', 3)
ON CONFLICT (code) DO NOTHING;

-- ---------- Hotel (branch) translations ----------
CREATE TABLE IF NOT EXISTS branch_translations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  language_code  VARCHAR(5) NOT NULL REFERENCES languages(code),
  name           VARCHAR(150) NOT NULL,
  description    TEXT,
  UNIQUE (branch_id, language_code)
);

-- ---------- Room type translations ----------
CREATE TABLE IF NOT EXISTS room_type_translations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id   UUID NOT NULL REFERENCES room_types(id),
  language_code  VARCHAR(5) NOT NULL REFERENCES languages(code),
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  UNIQUE (room_type_id, language_code)
);

-- ---------- Amenity translations (name AND the category grouping label) ----------
CREATE TABLE IF NOT EXISTS amenity_translations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amenity_id     UUID NOT NULL REFERENCES amenities(id),
  language_code  VARCHAR(5) NOT NULL REFERENCES languages(code),
  name           VARCHAR(100) NOT NULL,
  category       VARCHAR(50) NOT NULL,
  UNIQUE (amenity_id, language_code)
);

-- ---------- Image alt text translations (accessibility + SEO per language) ----------
CREATE TABLE IF NOT EXISTS room_type_image_translations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id       UUID NOT NULL REFERENCES room_type_images(id),
  language_code  VARCHAR(5) NOT NULL REFERENCES languages(code),
  alt_text       VARCHAR(255) NOT NULL,
  UNIQUE (image_id, language_code)
);

-- Speeds up the LEFT JOIN fallback pattern used by every catalog read query.
CREATE INDEX IF NOT EXISTS idx_branch_translations_lookup ON branch_translations (branch_id, language_code);
CREATE INDEX IF NOT EXISTS idx_room_type_translations_lookup ON room_type_translations (room_type_id, language_code);
CREATE INDEX IF NOT EXISTS idx_amenity_translations_lookup ON amenity_translations (amenity_id, language_code);
