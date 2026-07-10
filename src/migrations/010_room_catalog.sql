-- Room type catalog upgrade — brings the schema to an Agoda-style listing
-- standard: rich descriptions, multi-image galleries with ordering/cover
-- photo, and normalized amenities that can be used as search filters.
--
-- Run with: npm run migrate (numbered after whatever your latest migration
-- is in src/migrations/ - check the folder and rename this file accordingly,
-- e.g. 011_room_catalog.sql if 010 is already taken)

-- ---------- Extend hotels (branches) with catalog-grade fields ----------
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS star_rating SMALLINT CHECK (star_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS check_in_time TIME DEFAULT '14:00',
  ADD COLUMN IF NOT EXISTS check_out_time TIME DEFAULT '12:00',
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- ---------- Extend room_types with catalog-grade fields ----------
ALTER TABLE room_types
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS size_sqm NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS bed_type VARCHAR(50),      -- e.g. 'King', 'Twin', 'Queen x2'
  ADD COLUMN IF NOT EXISTS bed_count SMALLINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_adults SMALLINT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS max_children SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_type VARCHAR(50),      -- e.g. 'Sea view', 'Garden view', 'City view'
  ADD COLUMN IF NOT EXISTS smoking_allowed BOOLEAN DEFAULT false;

-- ---------- Amenities: one lookup table, reused at hotel and room level ----------
-- `category` here is a DISPLAY grouping (like Agoda's "Bathroom", "Internet",
-- "Entertainment" section headers on a listing page) - it is NOT about
-- whether the amenity is hotel-level or room-level. The same amenity
-- ("Free Wi-Fi") can appear in both hotel_amenities and room_type_amenities.
CREATE TABLE IF NOT EXISTS amenities (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      VARCHAR(100) NOT NULL UNIQUE,
  icon      VARCHAR(50),
  category  VARCHAR(50) NOT NULL DEFAULT 'ทั่วไป'
);

CREATE TABLE IF NOT EXISTS hotel_amenities (
  hotel_id    UUID NOT NULL REFERENCES branches(id),
  amenity_id  UUID NOT NULL REFERENCES amenities(id),
  PRIMARY KEY (hotel_id, amenity_id)
);

CREATE TABLE IF NOT EXISTS room_type_amenities (
  room_type_id  UUID NOT NULL REFERENCES room_types(id),
  amenity_id    UUID NOT NULL REFERENCES amenities(id),
  PRIMARY KEY (room_type_id, amenity_id)
);

-- ---------- Room type photo gallery ----------
-- Store URLs, never image bytes - see the note on object storage below.
CREATE TABLE IF NOT EXISTS room_type_images (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_id   UUID NOT NULL REFERENCES room_types(id),
  image_url      TEXT NOT NULL,
  alt_text       VARCHAR(255),           -- accessibility + SEO, e.g. "Pool Villa bedroom facing the garden"
  display_order  SMALLINT NOT NULL DEFAULT 0,
  is_cover       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_type_images_order ON room_type_images (room_type_id, display_order);

-- DB-level guarantee: at most one cover photo per room type, even if two
-- admin requests race to set is_cover=true at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_type_images_one_cover
  ON room_type_images (room_type_id) WHERE is_cover = true;

-- ---------- Starter amenity list (extend as needed) ----------
INSERT INTO amenities (name, icon, category) VALUES
  ('Wi-Fi ฟรี', 'wifi', 'อินเทอร์เน็ต'),
  ('สระว่ายน้ำ', 'pool', 'สิ่งอำนวยความสะดวก'),
  ('ที่จอดรถฟรี', 'parking', 'สิ่งอำนวยความสะดวก'),
  ('อาหารเช้ารวมในราคา', 'breakfast', 'อาหารและเครื่องดื่ม'),
  ('เครื่องปรับอากาศ', 'ac', 'ห้องพัก'),
  ('อ่างอาบน้ำ', 'bathtub', 'ห้องน้ำ'),
  ('ทีวีจอแบน', 'tv', 'ความบันเทิง'),
  ('มินิบาร์', 'minibar', 'ห้องพัก'),
  ('ระเบียงส่วนตัว', 'balcony', 'ห้องพัก'),
  ('บริการซักรีด', 'laundry', 'บริการ')
ON CONFLICT (name) DO NOTHING;
