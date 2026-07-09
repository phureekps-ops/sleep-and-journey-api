-- Adds the remaining 15 branches shown on the marketing site (homepage +
-- reservation page mockups) so the reservation flow has real inventory to
-- check availability against for every branch it advertises, not just the
-- single Phuket branch seeded in 001_init.sql.
--
-- Each branch gets 3 room tiers, matching the frontend's own pricing
-- formula exactly: price = round(base_price * multiplier / 10) * 10
--   Standard Chic        x1.00
--   Deluxe Nature View    x1.55
--   Pool Villa            x2.60
--
-- Room counts are deliberately small (matches the brand's low-investment,
-- boutique container-hotel concept, and the existing Phuket seed which
-- only has 2 Pool Villa rooms): 4 Standard, 3 Deluxe, 2 Pool Villa.
--
-- Safe to re-run: skips any branch whose name already exists.

DO $$
DECLARE
  branch_row RECORD;
  tier_row RECORD;
  new_branch_id UUID;
  new_room_type_id UUID;
  i INT;
BEGIN
  FOR branch_row IN
    SELECT * FROM (VALUES
      ('Sleep&Journey เชียงใหม่',        'เชียงใหม่',   'เหนือ',      1290),
      ('Sleep&Journey เชียงราย',         'เชียงราย',    'เหนือ',      1190),
      ('Sleep&Journey น่าน',              'น่าน',         'เหนือ',       990),
      ('Sleep&Journey แม่ฮ่องสอน',        'แม่ฮ่องสอน',   'เหนือ',      1090),
      ('Sleep&Journey ขอนแก่น',          'ขอนแก่น',     'อีสาน',       890),
      ('Sleep&Journey อุดรธานี',         'อุดรธานี',     'อีสาน',       850),
      ('Sleep&Journey ภูเรือ เลย',        'เลย',          'อีสาน',      1150),
      ('Sleep&Journey บุรีรัมย์',         'บุรีรัมย์',     'อีสาน',       820),
      ('Sleep&Journey เขาค้อ เพชรบูรณ์', 'เพชรบูรณ์',   'กลาง',       1350),
      ('Sleep&Journey หัวหิน',            'ประจวบคีรีขันธ์','กลาง',     1690),
      ('Sleep&Journey กาญจนบุรี',        'กาญจนบุรี',    'กลาง',       990),
      ('Sleep&Journey ภูทับเบิก เพชรบูรณ์','เพชรบูรณ์',  'กลาง',      1250),
      ('Sleep&Journey ระยอง',            'ระยอง',        'ตะวันออก',   1050),
      ('Sleep&Journey เกาะช้าง ตราด',    'ตราด',         'ตะวันออก',  1490),
      ('Sleep&Journey กระบี่',           'กระบี่',       'ใต้',        1590)
    ) AS b(name, province, region, base_price)
  LOOP
    IF EXISTS (SELECT 1 FROM branches WHERE name = branch_row.name) THEN
      CONTINUE;
    END IF;

    INSERT INTO branches (name, province, region)
    VALUES (branch_row.name, branch_row.province, branch_row.region)
    RETURNING id INTO new_branch_id;

    FOR tier_row IN
      SELECT * FROM (VALUES
        ('Standard Chic',       1.00, 2, 'STD', 4),
        ('Deluxe Nature View',  1.55, 3, 'DLX', 3),
        ('Pool Villa',          2.60, 4, 'PV',  2)
      ) AS t(name, mult, max_occupancy, code, room_count)
    LOOP
      INSERT INTO room_types (branch_id, name, base_price, max_occupancy)
      VALUES (
        new_branch_id,
        tier_row.name,
        ROUND(branch_row.base_price * tier_row.mult / 10) * 10,
        tier_row.max_occupancy
      )
      RETURNING id INTO new_room_type_id;

      FOR i IN 1..tier_row.room_count LOOP
        INSERT INTO rooms (room_type_id, room_number)
        VALUES (new_room_type_id, tier_row.code || '-' || LPAD(i::text, 2, '0'));
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
