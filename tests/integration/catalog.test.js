const request = require('supertest');
const app = require('../../src/app');
const { pool, truncateAll, closeDb } = require('../helpers/db');
const { createBranch, createRoomType } = require('../helpers/fixtures');
const { hashPassword } = require('../../src/utils/passwords');

async function insertStaff({ role, branchId, email }) {
  await pool.query(`INSERT INTO staff (name, email, password_hash, role, branch_id) VALUES ($1, $2, $3, $4, $5)`, [
    'Test Staff',
    email,
    hashPassword('password123'),
    role,
    branchId || null,
  ]);
}

async function loginStaff(email) {
  const res = await request(app).post('/v1/admin/auth/login').send({ email, password: 'password123' });
  return res.body.access_token;
}

async function hqAdminToken() {
  await insertStaff({ role: 'hq_admin', branchId: null, email: 'hq@test.com' });
  return loginStaff('hq@test.com');
}

describe('catalog - public reads', () => {
  let branchId;
  let roomTypeId;

  beforeEach(async () => {
    await truncateAll();
    branchId = await createBranch({ name: 'สาขาทดสอบ' });
    roomTypeId = await createRoomType(branchId, { name: 'ห้องมาตรฐาน' });
  });

  // Pool is NOT closed here - a second describe block below runs in this
  // same file/process and shares this pool. It's closed once, at the very
  // end of the file, in that second block's afterAll.

  test('GET /v1/branches/:id returns Thai fields by default', async () => {
    const res = await request(app).get(`/v1/branches/${branchId}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('สาขาทดสอบ');
    expect(res.body.language).toBe('th');
    expect(res.body.amenities).toEqual([]);
    expect(res.body.room_types).toHaveLength(1);
    expect(res.body.room_types[0].name).toBe('ห้องมาตรฐาน');
  });

  test('GET /v1/branches/:id?lang=en falls back to Thai when no translation exists yet', async () => {
    const res = await request(app).get(`/v1/branches/${branchId}?lang=en`);

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('en');
    expect(res.body.name).toBe('สาขาทดสอบ'); // COALESCE fallback, not a blank field
  });

  test('GET /v1/branches/:id?lang=en returns the English translation once one exists', async () => {
    await pool.query(
      `INSERT INTO branch_translations (branch_id, language_code, name, description)
       VALUES ($1, 'en', 'Test Branch', 'A lovely test branch')`,
      [branchId]
    );

    const res = await request(app).get(`/v1/branches/${branchId}?lang=en`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Branch');
    expect(res.body.description).toBe('A lovely test branch');
  });

  test('GET /v1/branches/:id?lang=xx (unsupported code) degrades to Thai instead of erroring', async () => {
    const res = await request(app).get(`/v1/branches/${branchId}?lang=xx`);

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('th');
  });

  test('GET /v1/branches/:id 404s for an unknown branch', async () => {
    const res = await request(app).get('/v1/branches/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('HOTEL_NOT_FOUND');
  });

  test('GET /v1/room-types/:id returns images in display order with translated alt text', async () => {
    const img1 = await pool.query(
      `INSERT INTO room_type_images (room_type_id, image_url, alt_text, display_order, is_cover)
       VALUES ($1, 'https://example.com/1.jpg', 'ห้องนอน', 1, true) RETURNING id`,
      [roomTypeId]
    );
    const img2 = await pool.query(
      `INSERT INTO room_type_images (room_type_id, image_url, alt_text, display_order, is_cover)
       VALUES ($1, 'https://example.com/0.jpg', 'ห้องน้ำ', 0, false) RETURNING id`,
      [roomTypeId]
    );
    await pool.query(
      `INSERT INTO room_type_image_translations (image_id, language_code, alt_text)
       VALUES ($1, 'en', 'Bathroom')`,
      [img2.rows[0].id]
    );

    const res = await request(app).get(`/v1/room-types/${roomTypeId}?lang=en`);

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(2);
    // ordered by display_order, so img2 (order 0) comes first
    expect(res.body.images[0].id).toBe(img2.rows[0].id);
    expect(res.body.images[0].alt_text).toBe('Bathroom'); // translated
    expect(res.body.images[1].id).toBe(img1.rows[0].id);
    expect(res.body.images[1].alt_text).toBe('ห้องนอน'); // no en translation -> Thai fallback
  });

  test('GET /v1/room-types/:id 404s for an unknown room type', async () => {
    const res = await request(app).get('/v1/room-types/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROOM_TYPE_NOT_FOUND');
  });

  test('GET /v1/branches lists active branches with their cheapest room price', async () => {
    await createRoomType(branchId, { basePrice: 1500 });
    await createRoomType(branchId, { basePrice: 900 }); // cheaper - should win as from_price

    const res = await request(app).get('/v1/branches');

    expect(res.status).toBe(200);
    const listed = res.body.data.find((b) => b.id === branchId);
    expect(listed).toBeDefined();
    expect(listed.name).toBe('สาขาทดสอบ');
    expect(Number(listed.from_price)).toBe(900); // cheapest of the room types created, not the first one
  });

  test('GET /v1/branches?region=... filters, and an inactive branch never appears', async () => {
    const northBranch = await createBranch({ name: 'สาขาเหนือ', region: 'เหนือ' });
    const southBranch = await createBranch({ name: 'สาขาใต้', region: 'ใต้' });
    await pool.query(`INSERT INTO branches (id, name, province, region, status) VALUES (gen_random_uuid(), 'ปิดปรับปรุง', 'ทดสอบ', 'เหนือ', 'inactive')`);

    const res = await request(app).get('/v1/branches?region=เหนือ');

    expect(res.status).toBe(200);
    expect(res.body.data.some((b) => b.id === northBranch)).toBe(true);
    expect(res.body.data.some((b) => b.id === southBranch)).toBe(false);
    expect(res.body.data.every((b) => b.name !== 'ปิดปรับปรุง')).toBe(true); // inactive branch excluded
  });
});

describe('catalog - admin content entry (hq_admin only)', () => {
  let branchId;
  let roomTypeId;
  let amenityId;

  beforeEach(async () => {
    await truncateAll();
    branchId = await createBranch({ name: 'สาขาทดสอบ' });
    roomTypeId = await createRoomType(branchId, { name: 'ห้องมาตรฐาน' });
    const amenityRes = await pool.query(
      `INSERT INTO amenities (name, icon, category) VALUES ('Wi-Fi ฟรี', 'wifi', 'อินเทอร์เน็ต') RETURNING id`
    );
    amenityId = amenityRes.rows[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  test('hq_admin can create then update a branch translation (upsert)', async () => {
    const token = await hqAdminToken();

    const created = await request(app)
      .post(`/v1/admin/branches/${branchId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'en', name: 'Test Branch', description: 'v1' });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe('Test Branch');

    const updated = await request(app)
      .post(`/v1/admin/branches/${branchId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'en', name: 'Test Branch Updated', description: 'v2' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Test Branch Updated');

    const rows = await pool.query('SELECT * FROM branch_translations WHERE branch_id = $1', [branchId]);
    expect(rows.rows).toHaveLength(1); // upsert, not a duplicate row
  });

  test('rejects language_code = th - Thai is edited on the base branch record, not via translations', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .post(`/v1/admin/branches/${branchId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'th', name: 'ชื่อไทย' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_LANGUAGE');
  });

  test('404s when translating a branch that does not exist', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .post('/v1/admin/branches/00000000-0000-0000-0000-000000000000/translations')
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'en', name: 'Ghost Branch' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('HOTEL_NOT_FOUND');
  });

  test('a branch_manager cannot write catalog translations', async () => {
    await insertStaff({ role: 'branch_manager', branchId, email: 'mgr@test.com' });
    const token = await loginStaff('mgr@test.com');

    const res = await request(app)
      .post(`/v1/admin/branches/${branchId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'en', name: 'Test Branch' });

    expect(res.status).toBe(403);
  });

  test('requires authentication', async () => {
    const res = await request(app)
      .post(`/v1/admin/branches/${branchId}/translations`)
      .send({ language_code: 'en', name: 'Test Branch' });

    expect(res.status).toBe(401);
  });

  test('hq_admin can create a room type translation', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'zh', name: '标准间', description: '一个舒适的房间' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('标准间');
  });

  test('hq_admin can create an amenity translation', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .post(`/v1/admin/amenities/${amenityId}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'ja', name: '無料Wi-Fi', category: 'インターネット' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('無料Wi-Fi');
  });

  test('adding a new cover image demotes the previous cover atomically', async () => {
    const token = await hqAdminToken();

    const first = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/a.jpg', is_cover: true, display_order: 0 });
    expect(first.status).toBe(201);
    expect(first.body.is_cover).toBe(true);

    const second = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/b.jpg', is_cover: true, display_order: 1 });
    expect(second.status).toBe(201);
    expect(second.body.is_cover).toBe(true);

    const coverRows = await pool.query(
      'SELECT id FROM room_type_images WHERE room_type_id = $1 AND is_cover = true',
      [roomTypeId]
    );
    expect(coverRows.rows).toHaveLength(1); // partial unique index never violated
    expect(coverRows.rows[0].id).toBe(second.body.id);
  });

  test('PATCH can move the cover flag to a different image', async () => {
    const token = await hqAdminToken();

    const imgA = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/a.jpg', is_cover: true });
    const imgB = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/b.jpg', is_cover: false });

    const patched = await request(app)
      .patch(`/v1/admin/room-types/${roomTypeId}/images/${imgB.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_cover: true });

    expect(patched.status).toBe(200);
    expect(patched.body.is_cover).toBe(true);

    const coverRows = await pool.query(
      'SELECT id FROM room_type_images WHERE room_type_id = $1 AND is_cover = true',
      [roomTypeId]
    );
    expect(coverRows.rows).toHaveLength(1);
    expect(coverRows.rows[0].id).toBe(imgB.body.id);
    void imgA; // imgA's is_cover should now be false, implicitly verified by the single-row assertion above
  });

  test('DELETE removes an image, then a second delete 404s', async () => {
    const token = await hqAdminToken();

    const img = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/a.jpg' });

    const del = await request(app)
      .delete(`/v1/admin/room-types/${roomTypeId}/images/${img.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const delAgain = await request(app)
      .delete(`/v1/admin/room-types/${roomTypeId}/images/${img.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(delAgain.status).toBe(404);
    expect(delAgain.body.error.code).toBe('IMAGE_NOT_FOUND');
  });

  test('hq_admin can add a translated alt text for an image', async () => {
    const token = await hqAdminToken();

    const img = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images`)
      .set('Authorization', `Bearer ${token}`)
      .send({ image_url: 'https://example.com/a.jpg', alt_text: 'ห้องนอน' });

    const translated = await request(app)
      .post(`/v1/admin/room-types/${roomTypeId}/images/${img.body.id}/translations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ language_code: 'en', alt_text: 'Bedroom' });

    expect(translated.status).toBe(200);
    expect(translated.body.alt_text).toBe('Bedroom');

    const publicRes = await request(app).get(`/v1/room-types/${roomTypeId}?lang=en`);
    expect(publicRes.body.images[0].alt_text).toBe('Bedroom');
  });

  test('hq_admin can edit a branch\'s own Thai fields (description, star rating, cover photo)', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .patch(`/v1/admin/branches/${branchId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'ที่พักริมทะเลบรรยากาศดี', star_rating: 4, cover_image_url: 'https://example.com/cover.jpg' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('ที่พักริมทะเลบรรยากาศดี');
    expect(res.body.star_rating).toBe(4);

    // and the public read reflects it immediately - no separate publish step
    const publicRes = await request(app).get(`/v1/branches/${branchId}`);
    expect(publicRes.body.description).toBe('ที่พักริมทะเลบรรยากาศดี');
    expect(publicRes.body.star_rating).toBe(4);
  });

  test('rejects an out-of-range star_rating', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .patch(`/v1/admin/branches/${branchId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ star_rating: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('404s when editing a branch that does not exist', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .patch('/v1/admin/branches/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'ไม่มีจริง' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('HOTEL_NOT_FOUND');
  });

  test('a branch_manager cannot edit branch details', async () => {
    await insertStaff({ role: 'branch_manager', branchId, email: 'mgr2@test.com' });
    const token = await loginStaff('mgr2@test.com');

    const res = await request(app)
      .patch(`/v1/admin/branches/${branchId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'พยายามแก้เอง' });

    expect(res.status).toBe(403);
  });

  test('hq_admin can edit a room type\'s own Thai fields (price, size, bed setup)', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .patch(`/v1/admin/room-types/${roomTypeId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'ห้องกว้างวิวสวน', base_price: 2500, size_sqm: 32, bed_type: 'King' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('ห้องกว้างวิวสวน');
    expect(Number(res.body.base_price)).toBe(2500);
    expect(Number(res.body.size_sqm)).toBe(32);
    expect(res.body.bed_type).toBe('King');

    const publicRes = await request(app).get(`/v1/room-types/${roomTypeId}`);
    expect(publicRes.body.description).toBe('ห้องกว้างวิวสวน');
  });

  test('404s when editing a room type that does not exist', async () => {
    const token = await hqAdminToken();

    const res = await request(app)
      .patch('/v1/admin/room-types/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'ไม่มีจริง' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROOM_TYPE_NOT_FOUND');
  });
});
