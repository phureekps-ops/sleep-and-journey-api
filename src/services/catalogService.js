const pool = require('../db');
const AppError = require('../utils/AppError');

const SUPPORTED_LANGUAGES = ['th', 'en', 'zh', 'ja'];
const DEFAULT_LANGUAGE = 'th';

// Never throws on a bad/missing language code - just falls back to Thai.
// A typo'd `?lang=zx` from a client should degrade gracefully, not 400.
function resolveLanguage(code) {
  return SUPPORTED_LANGUAGES.includes(code) ? code : DEFAULT_LANGUAGE;
}

/**
 * GET /v1/branches/:id?lang=en
 * Every SELECT here follows the same shape: LEFT JOIN the *_translations
 * table for the requested language, then COALESCE back to the base table's
 * Thai text. If a translator hasn't reached this hotel/room type yet in a
 * given language, the guest still sees Thai instead of a blank field -
 * never a broken-looking page for the sake of "purity".
 */
async function getHotelDetails(hotelId, languageCode) {
  const lang = resolveLanguage(languageCode);

  const hotelRes = await pool.query(
    `SELECT
       b.id,
       COALESCE(bt.name, b.name) AS name,
       COALESCE(bt.description, b.description) AS description,
       b.star_rating,
       b.province,
       b.check_in_time,
       b.check_out_time,
       b.cover_image_url
     FROM branches b
     LEFT JOIN branch_translations bt
       ON bt.branch_id = b.id AND bt.language_code = $2
     WHERE b.id = $1`,
    [hotelId, lang]
  );
  if (hotelRes.rows.length === 0) {
    throw new AppError(404, 'HOTEL_NOT_FOUND', 'ไม่พบโรงแรมนี้');
  }
  const hotel = hotelRes.rows[0];

  const amenitiesRes = await pool.query(
    `SELECT
       a.id,
       COALESCE(at.name, a.name) AS name,
       COALESCE(at.category, a.category) AS category
     FROM hotel_amenities ha
     JOIN amenities a ON a.id = ha.amenity_id
     LEFT JOIN amenity_translations at
       ON at.amenity_id = a.id AND at.language_code = $2
     WHERE ha.hotel_id = $1
     ORDER BY category, name`,
    [hotelId, lang]
  );

  const roomTypesRes = await pool.query(
    `SELECT
       rt.id,
       COALESCE(rtt.name, rt.name) AS name,
       COALESCE(rtt.description, rt.description) AS description,
       rt.base_price, rt.size_sqm, rt.bed_type, rt.max_adults, rt.max_children,
       (SELECT image_url FROM room_type_images
        WHERE room_type_id = rt.id AND is_cover = true LIMIT 1) AS cover_image_url
     FROM room_types rt
     LEFT JOIN room_type_translations rtt
       ON rtt.room_type_id = rt.id AND rtt.language_code = $2
     WHERE rt.branch_id = $1
     ORDER BY rt.base_price`,
    [hotelId, lang]
  );

  return {
    ...hotel,
    language: lang,
    amenities: amenitiesRes.rows,
    room_types: roomTypesRes.rows,
  };
}

/**
 * GET /v1/room-types/:id?lang=ja
 * Full room detail page: description, specs, every photo in order (with
 * per-language alt text), and room-level amenities.
 */
async function getRoomTypeDetails(roomTypeId, languageCode) {
  const lang = resolveLanguage(languageCode);

  const roomRes = await pool.query(
    `SELECT
       rt.id, rt.branch_id AS hotel_id,
       COALESCE(rtt.name, rt.name) AS name,
       COALESCE(rtt.description, rt.description) AS description,
       rt.base_price, rt.size_sqm, rt.bed_type, rt.bed_count,
       rt.max_adults, rt.max_children, rt.view_type, rt.smoking_allowed
     FROM room_types rt
     LEFT JOIN room_type_translations rtt
       ON rtt.room_type_id = rt.id AND rtt.language_code = $2
     WHERE rt.id = $1`,
    [roomTypeId, lang]
  );
  if (roomRes.rows.length === 0) {
    throw new AppError(404, 'ROOM_TYPE_NOT_FOUND', 'ไม่พบประเภทห้องนี้');
  }

  const imagesRes = await pool.query(
    `SELECT
       i.id, i.image_url, i.display_order, i.is_cover,
       COALESCE(it.alt_text, i.alt_text) AS alt_text
     FROM room_type_images i
     LEFT JOIN room_type_image_translations it
       ON it.image_id = i.id AND it.language_code = $2
     WHERE i.room_type_id = $1
     ORDER BY i.display_order`,
    [roomTypeId, lang]
  );

  const amenitiesRes = await pool.query(
    `SELECT
       a.id,
       COALESCE(at.name, a.name) AS name,
       COALESCE(at.category, a.category) AS category
     FROM room_type_amenities rta
     JOIN amenities a ON a.id = rta.amenity_id
     LEFT JOIN amenity_translations at
       ON at.amenity_id = a.id AND at.language_code = $2
     WHERE rta.room_type_id = $1
     ORDER BY category, name`,
    [roomTypeId, lang]
  );

  return {
    ...roomRes.rows[0],
    language: lang,
    images: imagesRes.rows,
    amenities: amenitiesRes.rows,
  };
}

// ---------------------------------------------------------------------------
// Admin content-entry: translations + image gallery management.
// Thai text lives only in the base tables (branches/room_types/amenities) -
// admins edit that through the existing branch/room-type update flows.
// These functions are for EN/ZH/JA overlays only, so 'th' is rejected here
// rather than silently writing into an overlay table nothing reads for th.
// ---------------------------------------------------------------------------

function assertTranslatableLanguage(code) {
  if (code === DEFAULT_LANGUAGE) {
    throw new AppError(
      400,
      'INVALID_LANGUAGE',
      'ภาษาไทยแก้ไขผ่านข้อมูลหลักของสาขา/ห้องพักโดยตรง ไม่ใช่ผ่าน endpoint คำแปล'
    );
  }
  if (!SUPPORTED_LANGUAGES.includes(code)) {
    throw new AppError(400, 'INVALID_LANGUAGE', `ไม่รองรับภาษา '${code}'`);
  }
}

/**
 * POST /v1/admin/branches/:id/translations  body: { language_code, name, description }
 * Upserts one language's translation row for a branch (hotel).
 */
async function upsertBranchTranslation(branchId, { language_code, name, description }) {
  assertTranslatableLanguage(language_code);
  if (!name) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ต้องระบุ name');
  }
  const branchExists = await pool.query('SELECT id FROM branches WHERE id = $1', [branchId]);
  if (branchExists.rows.length === 0) {
    throw new AppError(404, 'HOTEL_NOT_FOUND', 'ไม่พบโรงแรมนี้');
  }
  const result = await pool.query(
    `INSERT INTO branch_translations (branch_id, language_code, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (branch_id, language_code)
     DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
     RETURNING id, branch_id, language_code, name, description`,
    [branchId, language_code, name, description || null]
  );
  return result.rows[0];
}

/**
 * POST /v1/admin/room-types/:id/translations  body: { language_code, name, description }
 */
async function upsertRoomTypeTranslation(roomTypeId, { language_code, name, description }) {
  assertTranslatableLanguage(language_code);
  if (!name) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ต้องระบุ name');
  }
  const roomExists = await pool.query('SELECT id FROM room_types WHERE id = $1', [roomTypeId]);
  if (roomExists.rows.length === 0) {
    throw new AppError(404, 'ROOM_TYPE_NOT_FOUND', 'ไม่พบประเภทห้องนี้');
  }
  const result = await pool.query(
    `INSERT INTO room_type_translations (room_type_id, language_code, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (room_type_id, language_code)
     DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
     RETURNING id, room_type_id, language_code, name, description`,
    [roomTypeId, language_code, name, description || null]
  );
  return result.rows[0];
}

/**
 * POST /v1/admin/amenities/:id/translations  body: { language_code, name, category }
 */
async function upsertAmenityTranslation(amenityId, { language_code, name, category }) {
  assertTranslatableLanguage(language_code);
  if (!name || !category) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ต้องระบุ name และ category');
  }
  const amenityExists = await pool.query('SELECT id FROM amenities WHERE id = $1', [amenityId]);
  if (amenityExists.rows.length === 0) {
    throw new AppError(404, 'AMENITY_NOT_FOUND', 'ไม่พบสิ่งอำนวยความสะดวกนี้');
  }
  const result = await pool.query(
    `INSERT INTO amenity_translations (amenity_id, language_code, name, category)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (amenity_id, language_code)
     DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category
     RETURNING id, amenity_id, language_code, name, category`,
    [amenityId, language_code, name, category]
  );
  return result.rows[0];
}

/**
 * POST /v1/admin/room-types/:id/images
 * body: { image_url, alt_text?, display_order?, is_cover? }
 * If is_cover is true, atomically demotes any existing cover image first -
 * the partial unique index on room_type_images would otherwise reject the
 * insert if two images tried to be "the" cover at once.
 */
async function addRoomTypeImage(roomTypeId, { image_url, alt_text, display_order, is_cover }) {
  if (!image_url) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ต้องระบุ image_url');
  }
  const roomExists = await pool.query('SELECT id FROM room_types WHERE id = $1', [roomTypeId]);
  if (roomExists.rows.length === 0) {
    throw new AppError(404, 'ROOM_TYPE_NOT_FOUND', 'ไม่พบประเภทห้องนี้');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (is_cover) {
      await client.query(
        'UPDATE room_type_images SET is_cover = false WHERE room_type_id = $1 AND is_cover = true',
        [roomTypeId]
      );
    }
    const result = await client.query(
      `INSERT INTO room_type_images (room_type_id, image_url, alt_text, display_order, is_cover)
       VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5, false))
       RETURNING id, room_type_id, image_url, alt_text, display_order, is_cover`,
      [roomTypeId, image_url, alt_text || null, display_order, is_cover]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PATCH /v1/admin/room-types/:roomTypeId/images/:imageId
 * body: any subset of { alt_text, display_order, is_cover }
 */
async function updateRoomTypeImage(roomTypeId, imageId, { alt_text, display_order, is_cover }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM room_type_images WHERE id = $1 AND room_type_id = $2',
      [imageId, roomTypeId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'IMAGE_NOT_FOUND', 'ไม่พบรูปภาพนี้');
    }
    if (is_cover === true) {
      await client.query(
        'UPDATE room_type_images SET is_cover = false WHERE room_type_id = $1 AND is_cover = true AND id != $2',
        [roomTypeId, imageId]
      );
    }
    const result = await client.query(
      `UPDATE room_type_images SET
         alt_text = COALESCE($3, alt_text),
         display_order = COALESCE($4, display_order),
         is_cover = COALESCE($5, is_cover)
       WHERE id = $1 AND room_type_id = $2
       RETURNING id, room_type_id, image_url, alt_text, display_order, is_cover`,
      [imageId, roomTypeId, alt_text, display_order, is_cover]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * DELETE /v1/admin/room-types/:roomTypeId/images/:imageId
 */
async function deleteRoomTypeImage(roomTypeId, imageId) {
  const result = await pool.query(
    'DELETE FROM room_type_images WHERE id = $1 AND room_type_id = $2 RETURNING id',
    [imageId, roomTypeId]
  );
  if (result.rows.length === 0) {
    throw new AppError(404, 'IMAGE_NOT_FOUND', 'ไม่พบรูปภาพนี้');
  }
}

/**
 * POST /v1/admin/room-types/:roomTypeId/images/:imageId/translations
 * body: { language_code, alt_text }
 */
async function upsertImageAltTranslation(roomTypeId, imageId, { language_code, alt_text }) {
  assertTranslatableLanguage(language_code);
  if (!alt_text) {
    throw new AppError(400, 'VALIDATION_ERROR', 'ต้องระบุ alt_text');
  }
  const imageExists = await pool.query(
    'SELECT id FROM room_type_images WHERE id = $1 AND room_type_id = $2',
    [imageId, roomTypeId]
  );
  if (imageExists.rows.length === 0) {
    throw new AppError(404, 'IMAGE_NOT_FOUND', 'ไม่พบรูปภาพนี้');
  }
  const result = await pool.query(
    `INSERT INTO room_type_image_translations (image_id, language_code, alt_text)
     VALUES ($1, $2, $3)
     ON CONFLICT (image_id, language_code)
     DO UPDATE SET alt_text = EXCLUDED.alt_text
     RETURNING id, image_id, language_code, alt_text`,
    [imageId, language_code, alt_text]
  );
  return result.rows[0];
}

module.exports = {
  getHotelDetails,
  getRoomTypeDetails,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  upsertBranchTranslation,
  upsertRoomTypeTranslation,
  upsertAmenityTranslation,
  addRoomTypeImage,
  updateRoomTypeImage,
  deleteRoomTypeImage,
  upsertImageAltTranslation,
};
