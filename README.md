# Sleep&Journey Reservation API — ตัวอย่างจริง (Node.js + Express + PostgreSQL)

ตัวอย่างนี้ implement `GET /v1/availability` และ `POST /v1/bookings` ตาม spec ที่ร่างไว้ก่อนหน้า
โดยเน้นจุดสำคัญที่สุด: **การล็อกห้องเพื่อป้องกัน overbooking** เมื่อมีคนจองพร้อมกันหลายคน

## วิธีป้องกัน overbooking (สรุปแนวคิด)

ทุกครั้งที่มีคนพยายามจองห้องประเภทเดียวกัน ระบบจะ:
1. ขอ `pg_advisory_xact_lock(hashtext(room_type_id))` — เปรียบเหมือนคิวเข้าคนเดียวสำหรับห้องประเภทนั้น
   ใครถึงคิวก่อนจะเช็ค+จองเสร็จก่อน คนถัดไปต้องรอจนกว่า transaction แรกจะ commit/rollback
2. นับห้องที่มีทั้งหมด ลบด้วยจำนวนการจองที่ทับซ้อนช่วงวันที่ (เฉพาะ `confirmed` และ `pending` ที่ยังไม่หมดเวลาถือ)
3. ถ้าเหลือ 0 ห้อง → ตอบ `409 ROOM_NOT_AVAILABLE` ทันที ไม่สร้าง booking
4. ถ้ายังมีห้องว่าง → insert booking แล้ว commit — lock จะถูกปล่อยอัตโนมัติ คิวถัดไปทำงานต่อ

รายละเอียดทั้งหมดอยู่ใน `src/services/bookingService.js`

## ติดตั้ง

```bash
npm install
cp .env.example .env    # แก้ DATABASE_URL ให้ตรงกับเครื่องคุณ
npm run migrate         # สร้างตาราง + seed ข้อมูลตัวอย่าง (สาขาภูเก็ต 1 ประเภทห้อง มี 2 ห้องจริง)
npm start
```

เซิร์ฟเวอร์จะรันที่ `http://localhost:3000` (เปลี่ยนพอร์ตได้ใน `.env`)

## ทดสอบด้วยตัวเอง

**1. เช็คห้องว่าง**
```bash
curl "http://localhost:3000/v1/availability?branch_id=11111111-1111-1111-1111-111111111111&checkin=2026-08-10&checkout=2026-08-12"
```
ควรเห็น Pool Villa เหลือ `rooms_remaining: 2`

**2. จองห้อง (สำเร็จ)**
```bash
curl -X POST http://localhost:3000/v1/bookings \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "branch_id": "11111111-1111-1111-1111-111111111111",
    "room_type_id": "22222222-2222-2222-2222-222222222222",
    "checkin": "2026-08-10",
    "checkout": "2026-08-12",
    "guests_count": 2,
    "guest": { "first_name": "สมชาย", "last_name": "ใจดี", "email": "somchai@email.com", "phone": "0812345678" }
  }'
```
ทำซ้ำขั้นตอนนี้อีกครั้งด้วยอีเมลอื่น (เช่น `wichai@email.com`) — ตอนนี้ห้องเต็มพอดี (มี 2 ห้อง จอง 2 ครั้งแล้ว)

**3. ทดสอบ overbooking (ควรถูกปฏิเสธ)**
```bash
curl -X POST http://localhost:3000/v1/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "branch_id": "11111111-1111-1111-1111-111111111111",
    "room_type_id": "22222222-2222-2222-2222-222222222222",
    "checkin": "2026-08-10",
    "checkout": "2026-08-12",
    "guest": { "first_name": "คนที่สาม", "email": "third@email.com" }
  }'
```
ควรได้ `409 ROOM_NOT_AVAILABLE` เพราะห้องเต็มแล้ว

**4. ทดสอบยิงพร้อมกัน (race condition)** — เปิด 2 terminal แล้วยิงคำสั่งข้อ 2 พร้อมกันในจังหวะเดียวกันด้วยอีเมลต่างกัน หรือใช้สคริปต์ยิงพร้อมกันหลาย request เกินจำนวนห้องที่มี ระบบต้องปฏิเสธส่วนเกินทั้งหมดโดยไม่มีห้องไหนถูกจองซ้ำ (สามารถตรวจสอบได้จาก `SELECT COUNT(*) FROM bookings WHERE room_type_id = '...' AND status != 'cancelled'` ต้องไม่เกินจำนวนห้องจริง)

**5. ทดสอบ idempotency** — ยิง request เดิมซ้ำด้วย `Idempotency-Key` เดิม จะได้ response เดิมทุกครั้ง (ไม่สร้าง booking ใหม่)

## การชำระเงิน: `POST /bookings/:id/payment` + webhook

### ติดตั้งเพิ่ม
```bash
npm run migrate  # รันซ้ำได้ - จะสร้างตาราง payments และ webhook_events เพิ่ม (002_payments.sql)
```
เพิ่มคีย์ Omise ทดสอบ (`pkey_test_...`, `skey_test_...` จาก https://dashboard.omise.co/keys) ใน `.env`

### ทดสอบจ่ายผ่าน QR (PromptPay ผ่าน Omise)
```bash
curl -X POST http://localhost:3000/v1/bookings/<booking_id>/payment \
  -H "Content-Type: application/json" \
  -d '{ "method": "qr" }'
```
จะได้ `qr_image_url` กลับมา — เปิดรูปนั้นดูได้ (โหมด test ของ Omise ให้สแกนจ่ายจำลองได้จาก dashboard)

### ทดสอบจ่ายด้วยบัตร
ต้องสร้าง `card_token` จากฝั่ง client ก่อนด้วย Omise.js (ห้ามส่งเลขบัตรมาที่ server ตรง ๆ) แล้วส่งมาที่ endpoint:
```bash
curl -X POST http://localhost:3000/v1/bookings/<booking_id>/payment \
  -H "Content-Type: application/json" \
  -d '{ "method": "card", "card_token": "tokn_test_xxxxxxxxxxxx" }'
```
บัตรทดสอบที่ไม่ต้องผ่าน 3-D Secure จะยืนยัน booking ทันทีในการเรียกนี้เลย (ไม่ต้องรอ webhook) — ดูใน `paymentService.initiatePayment`

### ทดสอบ webhook จาก Omise
ตั้งค่า webhook URL ใน Omise dashboard ให้ชี้มาที่ `https://<your-ngrok-url>/v1/webhooks/payment/omise` (ต้องใช้ ngrok หรือคล้ายกันตอน dev เพราะ Omise ต้องยิงเข้ามาจากอินเทอร์เน็ต) จากนั้นลองจ่ายเงินจริงในโหมด test แล้วดู log ว่า booking เปลี่ยนเป็น `confirmed`

**จุดสำคัญที่โค้ดนี้ทำ**: เมื่อ webhook มาถึง จะไม่เชื่อ `status` ที่ webhook ส่งมาตรง ๆ แต่เรียก `omise.fetchChargeStatus(chargeId)` กลับไปถาม Omise ด้วย secret key ของเราเองอีกที ว่า charge นี้จ่ายจริงหรือไม่ — ป้องกันคนปลอม webhook มาหลอกว่า "จ่ายแล้ว"

### 2C2P — เริ่มชำระเงินและคืนเงิน

**⚠️ อ่านก่อนใช้กับเงินจริง**: 2C2P Payment Gateway API มีหลายเวอร์ชันตลอดหลายปีที่ผ่านมา โค้ดส่วนนี้ทำตามรูปแบบของ **PGW 4.x แบบ JWT** (request body เป็น JWT เซ็นด้วย merchant secret key ของคุณเอง, response และ backend notification ก็เป็น JWT แบบเดียวกัน) — **ชื่อฟิลด์, endpoint path, และรายละเอียดอาจต่างจากสัญญา 2C2P ของคุณจริง** ก่อนขึ้นจริงต้อง:
1. ล็อกอิน 2C2P merchant portal แล้วโหลด API spec/Postman collection ของบัญชีคุณเอง
2. เทียบทุกชื่อฟิลด์และ URL ในไฟล์ `src/services/paymentGateway/twoCtwoPClient.js` กับของจริง
3. ทดสอบกับ sandbox ของ 2C2P ให้ครบทุกเคสก่อนใช้เงินจริง

### วิธีใช้
```bash
curl -X POST http://localhost:3000/v1/bookings/<booking_id>/payment \
  -H "Content-Type: application/json" \
  -d '{ "gateway": "2c2p" }'
```
ต่างจากฝั่ง Omise ตรงที่ **ไม่ต้องส่ง `method`** — หน้าชำระเงินของ 2C2P (hosted payment page) ให้ลูกค้าเลือกช่องทางจ่ายเอง (บัตร/QR/อื่น ๆ) ไม่ใช่ server เลือกให้ ระบบจะได้ `redirect_url` กลับมาให้พาลูกค้าไปหน้านั้น

**ตัวแปรที่ต้องตั้งก่อนใช้งาน**: `TWOCTWOP_MERCHANT_ID`, `TWOCTWOP_SECRET_KEY`, `TWOCTWOP_BACKEND_RETURN_URL` (ชี้มาที่ `/v1/webhooks/payment/2c2p` ของคุณ) — ถ้าไม่ตั้ง `TWOCTWOP_BACKEND_RETURN_URL` ระบบจะปฏิเสธด้วย `500 GATEWAY_NOT_CONFIGURED` ทันที แทนที่จะสร้าง payment ที่ไม่มีทางได้รับการยืนยันกลับมา

### Webhook: `POST /webhooks/payment/2c2p`
รับ backend notification ที่ 2C2P ส่งกลับมาเป็น `{ "payload": "<jwt>" }` — เข้ารหัสด้วย merchant secret key เดียวกัน route จะ **verify ลายเซ็น JWT ก่อนเสมอ** (`decodeBackendNotification`) ถ้าตรวจสอบไม่ผ่านจะปฏิเสธด้วย `400 INVALID_SIGNATURE` โดยไม่แตะข้อมูลใด ๆ ต่อ — เหมือนหลักการเดียวกับที่ยึดไว้ตอนทำ Omise webhook: **ไม่เชื่อ payload ที่ยังตรวจสอบลายเซ็นไม่ผ่านเด็ดขาด**

### การคืนเงินผ่าน 2C2P
`PATCH /bookings/:id/cancel` ที่ทำไว้ก่อนหน้า รองรับการคืนเงินผ่าน 2C2P แล้วโดยอัตโนมัติ — ถ้า payment ที่จะคืนมีค่า `gateway = '2c2p'` ระบบจะเรียก `requestRefund` โดยใช้ `invoiceNo` เดิมที่บันทึกไว้ตอนสร้าง payment token ตรรกะ error-handling เหมือนกับ Omise ทุกอย่าง (ถ้าเรียก API ไม่สำเร็จ การยกเลิกจองยังสำเร็จอยู่ แต่ `refund_status` จะเป็น `failed_needs_manual_review`)

### สิ่งที่ยังไม่ตรงกับ 2C2P จริง 100% (ต้องแก้ตามสัญญาของคุณ)
- ชื่อฟิลด์ต่าง ๆ ใน request/response payload (`paymentChannel`, `respCode`, ฯลฯ)
- รูปแบบ `invoiceNo` ที่ยอมรับได้ (ความยาว, อักขระที่ใช้ได้) — โค้ดนี้ตัด UUID ของ booking มาใช้แบบง่าย ๆ ยังไม่ได้เช็คกับ spec จริง
- endpoint path (`/payment/4.3/paymentToken`, `/payment/4.3/refund`) อาจเปลี่ยนตาม API version ของสัญญา

## Authentication (JWT)

### ติดตั้งเพิ่ม
```bash
npm run migrate  # รันซ้ำได้ - เพิ่มคอลัมน์รหัสผ่านใน guests, ตาราง staff/refresh_tokens/loyalty_transactions (003_auth.sql)
```
ตั้งค่า `JWT_ACCESS_SECRET` ใน `.env` ให้เป็นสตริงสุ่มยาว ๆ (เช่น `openssl rand -hex 32`)

**สร้างบัญชีแอดมินคนแรก** (ห้าม hardcode รหัสผ่านไว้ในไฟล์ migration เด็ดขาด จึงมีสคริปต์แยก):
```bash
npm run seed:staff -- hq@sleepandjourney.com "รหัสผ่านของคุณ" hq_admin
```

### สมัคร/ล็อกอินฝั่งลูกค้า
```bash
# สมัครสมาชิก (ได้ 300 แต้มต้อนรับทันที)
curl -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{ "first_name": "สมชาย", "email": "somchai@email.com", "password": "supersecret123" }'

# ล็อกอิน
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "somchai@email.com", "password": "supersecret123" }'
```
ทั้งสอง endpoint คืน `access_token` (อายุ 15 นาที ใช้แนบใน `Authorization: Bearer <token>`) กับ `refresh_token` (อายุ 30 วัน ใช้ขอ access token ใหม่)

### ดู/แก้ไขโปรไฟล์ตัวเอง
```bash
curl http://localhost:3000/v1/guests/me \
  -H "Authorization: Bearer <access_token>"
```

### ขอ access token ใหม่เมื่อหมดอายุ
```bash
curl -X POST http://localhost:3000/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refresh_token": "<refresh_token เดิม>" }'
```
ทุกครั้งที่ refresh สำเร็จ refresh_token เดิมจะถูกยกเลิกทันที (rotation) — เอา refresh_token เก่าที่ใช้ไปแล้วมายิงซ้ำจะได้ `401 INVALID_REFRESH_TOKEN` เสมอ

### ฝั่งพนักงาน (CRM)
```bash
curl -X POST http://localhost:3000/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "hq@sleepandjourney.com", "password": "รหัสผ่านของคุณ" }'

curl http://localhost:3000/v1/admin/bookings \
  -H "Authorization: Bearer <staff_access_token>"
```
ลองสร้างพนักงานสาขาด้วย `npm run seed:staff -- phuket-manager@sleepandjourney.com <รหัสผ่าน> branch_manager 11111111-1111-1111-1111-111111111111` แล้วล็อกอินดู — เรียก `/admin/bookings?branch_id=<สาขาอื่น>` จะยังเห็นแค่ข้อมูลสาขาตัวเองเท่านั้น เพราะ query param นี้ถูก "เมิน" ไปเลยสำหรับ role ที่ไม่ใช่ hq_admin (ดูใน `adminBookings.js`)

### จัดการบัญชีพนักงานผ่าน API (hq_admin เท่านั้น)
```bash
# ต้อง login เป็น hq_admin ก่อน แล้วใช้ access_token ที่ได้
curl -X POST http://localhost:3000/v1/admin/staff \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <hq_admin_access_token>" \
  -d '{
    "name": "ผู้จัดการสาขาภูเก็ต",
    "email": "phuket-manager@sleepandjourney.com",
    "password": "รหัสผ่านที่ปลอดภัย",
    "role": "branch_manager",
    "branch_id": "11111111-1111-1111-1111-111111111111"
  }'

curl http://localhost:3000/v1/admin/staff \
  -H "Authorization: Bearer <hq_admin_access_token>"
```
เอ็นด์พอยต์นี้จำกัดด้วย `requireRole('hq_admin')` เท่านั้น — ถ้า branch_manager หรือ branch_staff เรียกจะได้ `403 FORBIDDEN` ทันที `npm run seed:staff` ยังมีประโยชน์อยู่จุดเดียวคือใช้สร้าง **บัญชี hq_admin คนแรก** ก่อนที่จะมีใคร login เพื่อเรียก endpoint นี้ได้ (ไก่กับไข่: ต้องมี hq_admin อย่างน้อยหนึ่งคนก่อนถึงจะสร้างคนอื่นผ่าน API ได้)

### แก้ไข/ปิดใช้งานบัญชีพนักงาน (hq_admin เท่านั้น)
```bash
npm run migrate  # เพิ่มคอลัมน์ is_active (004_staff_status.sql)

# แก้ไขข้อมูล (ส่งเฉพาะฟิลด์ที่ต้องการเปลี่ยน)
curl -X PATCH http://localhost:3000/v1/admin/staff/<staff_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <hq_admin_access_token>" \
  -d '{ "name": "ชื่อใหม่", "branch_id": "11111111-1111-1111-1111-111111111111" }'

# ปิดใช้งานบัญชี (ยกเลิก refresh token ทั้งหมดของคนนั้นทันที)
curl -X PATCH http://localhost:3000/v1/admin/staff/<staff_id> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <hq_admin_access_token>" \
  -d '{ "is_active": false }'
```
**กันตัวเองล็อกตัวเอง**: ถ้า hq_admin พยายามปิดใช้งานหรือเปลี่ยน role ของ**บัญชีตัวเอง** ผ่าน endpoint นี้ จะได้ `409 CANNOT_DISABLE_SELF` / `409 CANNOT_CHANGE_OWN_ROLE` เสมอ — ต้องให้ hq_admin คนอื่นเป็นคนทำแทน (ป้องกันกรณีเผลอปิดบัญชีตัวเองจนเข้าระบบไม่ได้เลย)

**หมายเหตุเรื่องความไว**: การปิดใช้งานจะยกเลิก refresh token ทั้งหมดทันที (ขอ access token ใหม่ไม่ได้อีก) แต่ access token ที่ออกไปแล้วก่อนหน้านี้จะยังใช้ได้จนกว่าจะหมดอายุ (สูงสุด 15 นาทีตาม `ACCESS_TOKEN_TTL`) เพราะ JWT เป็น stateless เพิกถอนกลางคันไม่ได้ — TTL สั้นคือมาตรการป้องกันในตัวมันเองอยู่แล้ว ไม่ใช่ช่องโหว่ที่มองข้าม


## ปล่อยห้องที่ hold หมดเวลา (cron job)

**หมายเหตุสำคัญก่อนอื่น**: ระบบป้องกัน overbooking ทำงานถูกต้องอยู่แล้วโดยไม่ต้องมี cron job นี้ — ตอนคำนวณห้องว่าง (`availabilityService`) จะไม่นับการจอง `pending` ที่ `hold_expires_at` ผ่านไปแล้วอยู่แล้ว ดังนั้น cron job นี้มีไว้เพื่อ **ความสะอาดของข้อมูล** เท่านั้น ไม่ให้มีรายการ `pending` ที่ไม่มีวันจ่ายเงินค้างเต็มตาราง `bookings` จนกวนสายตาในหน้า CRM

### ทดสอบรันเอง
```bash
npm run jobs:release-expired-holds
```
จะเปลี่ยนสถานะการจอง `pending` ที่หมดเวลาถือห้องแล้วเป็น `expired` พร้อมเปลี่ยนสถานะการชำระเงินที่ยังค้าง `pending` อยู่ของการจองนั้นเป็น `failed` ไปด้วย

### ตั้งให้รันอัตโนมัติ — **อย่าฝังไว้ในโปรเซสเว็บเซิร์ฟเวอร์**
สิ่งที่ควรหลีกเลี่ยงคือการใช้ `setInterval` ยิงงานนี้อยู่ในตัว `server.js` เอง เพราะถ้าคุณรันเซิร์ฟเวอร์มากกว่า 1 instance (สเกลแนวนอนเพื่อรองรับโหลด) ทุก instance จะรันงานนี้ซ้ำกันพร้อมกันโดยไม่จำเป็น ให้แยกรันเป็น process ต่างหากแทน เลือกได้ตามที่ deploy จริง:

- **เซิร์ฟเวอร์ทั่วไป (VPS/EC2)**: ใช้ system crontab
  ```
  */5 * * * * cd /path/to/sleep-and-journey-api && /usr/bin/npm run jobs:release-expired-holds >> /var/log/sj-cron.log 2>&1
  ```
- **Railway / Render**: ใช้ฟีเจอร์ "Cron Job" ของแพลตฟอร์ม ชี้ไปที่คำสั่ง `npm run jobs:release-expired-holds` ตั้ง schedule เป็น `*/5 * * * *`
- **Kubernetes**: ใช้ `CronJob` resource รัน image เดียวกับแอป แต่สั่ง `node src/jobs/releaseExpiredHolds.js` แทน `node src/server.js`

ทุก 5 นาทีเหมาะสมเพราะ hold มีอายุ 15 นาที — ถี่พอที่ข้อมูลจะไม่ค้างนานเกินไป แต่ไม่ถี่จนรบกวนฐานข้อมูลโดยไม่จำเป็น


## ใช้แต้มแลกส่วนลด: `POST /loyalty/redeem`

```bash
npm run migrate  # เพิ่ม unique index กันแลกแต้มซ้ำ (005_loyalty_redeem_constraint.sql)

curl -X POST http://localhost:3000/v1/loyalty/redeem \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <guest_access_token>" \
  -d '{ "booking_id": "<booking_id ของฉันที่ยัง pending>", "points": 300 }'
```
คืนค่า `discount_amount`, `new_total_price` (ยอดที่ต้องจ่ายจริงหลังหักส่วนลด), และ `points_balance` ที่เหลือ — เรียก `POST /bookings/:id/payment` ต่อได้เลยตามปกติ เพราะ payment จะอ่าน `total_price` ที่ถูกหักไปแล้วจากตาราง `bookings` โดยตรง ไม่ต้องมีตัวแปร "ส่วนลดที่ใช้ไป" แยกให้จัดการเพิ่ม

**กติกาที่บังคับไว้**
- ใช้แต้มได้ **ครั้งเดียวต่อการจอง** เท่านั้น (เช็คซ้ำสองชั้น — ตรวจในโค้ดก่อน แล้วมี unique index ที่ฐานข้อมูลกันเคสสองคำขอมาพร้อมกันพอดี)
- ใช้ได้เฉพาะตอน booking ยังเป็น `pending` (ยังไม่จ่ายเงิน)
- ใช้แลกส่วนลดได้สูงสุด **50% ของยอดจอง** — ป้องกันการจองราคา 0 บาท
- อัตราแลก: **1 แต้ม = 1 บาท** ส่วนลด ต้องใช้อย่างน้อย 100 แต้มต่อครั้ง
- แต้มที่ได้จากการจ่ายเงิน (`earnPointsForBooking`) คำนวณจากยอดที่จ่ายจริง**หลัง**หักส่วนลดแล้ว ไม่ใช่ยอดเต็มก่อนใช้แต้ม — ป้องกันไม่ให้ได้แต้มคืนจากเงินที่ไม่ได้จ่ายจริง

**Error ที่ควรรู้จัก**: `409 ALREADY_REDEEMED`, `409 BOOKING_NOT_REDEEMABLE`, `422 INSUFFICIENT_POINTS` (พร้อม `details.available_points`), `422 REDEMPTION_LIMIT_EXCEEDED` (พร้อม `details.max_points_allowed`)


## ยกเลิกการจองและคืนเงิน: `PATCH /bookings/:id/cancel`

```bash
npm run migrate  # เพิ่มตาราง booking_cancellations (006_booking_cancellations.sql)

# ฝั่งลูกค้ายกเลิกการจองของตัวเอง
curl -X PATCH http://localhost:3000/v1/bookings/<booking_id>/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <guest_access_token>" \
  -d '{ "reason": "เปลี่ยนแผนการเดินทาง" }'
```
Endpoint เดียวกันนี้ staff ก็เรียกได้ (ยกเลิกแทนลูกค้าทางโทรศัพท์) โดยอัตโนมัติจำกัดสิทธิ์ตามสาขาเหมือน `/admin/bookings` — branch_manager/branch_staff ยกเลิกได้แค่ booking ของสาขาตัวเอง

### นโยบายยกเลิก (แบบง่าย ใช้เหมือนกันทุกสาขา)
| ก่อนวันเช็คอิน | ค่าธรรมเนียม | คืนเงิน |
|---|---|---|
| ≥ 72 ชั่วโมง | ไม่มี | เต็มจำนวน |
| 24-72 ชั่วโมง | 50% | 50% |
| < 24 ชั่วโมง (หรือเลยเช็คอินไปแล้ว) | 100% | ไม่คืนเงิน |

การจองที่ยัง `pending` (ยังไม่จ่ายเงิน) ยกเลิกได้ฟรีทันทีเสมอ เพราะไม่มีอะไรต้องคืน

### สิ่งที่เกิดขึ้นเบื้องหลังเมื่อมีการคืนเงิน
1. เรียก Omise refund API (`POST /charges/:id/refunds`) ถ้าจ่ายด้วยบัตร/QR ผ่าน Omise — ถ้าจ่ายด้วยการโอนเงิน (`manual`) จะได้ `refund_status: "manual_required"` แทน เพราะไม่มี API ให้เรียกคืนเงินแบบโอนเงินได้ ต้องให้เจ้าหน้าที่โอนคืนเอง
2. **หัก (claw back) แต้มสะสมที่เคยได้จากการจองนั้น** — ถ้าคืนเงิน (ไม่ว่าเต็มจำนวนหรือบางส่วน) แต้มที่เคยได้จากการจ่ายเงินครั้งนั้นจะถูกหักคืนทั้งหมด ป้องกันลูกค้าได้แต้มจากเงินที่ไม่ได้จ่ายจริงในที่สุด (กฎง่าย ๆ ไม่คิดสัดส่วนตามยอดคืนบางส่วน)
3. ถ้าการเรียก Omise refund ล้มเหลว (เช่น เน็ตหลุด, gateway ล่ม) **การยกเลิกจองจะยังสำเร็จอยู่** (ห้องถูกปล่อยคืน) แต่ `refund_status` จะเป็น `"failed_needs_manual_review"` ให้ทีมงานตามไปคืนเงินเองภายหลัง — ไม่ปล่อยให้เงินลูกค้าหายไปเงียบ ๆ เพราะ API ล้ม

`refund_status` ที่เป็นไปได้: `not_applicable` (ไม่เคยจ่ายเงิน), `none` (จ่ายแล้วแต่ยกเลิกช้าเกินไป ไม่คืน), `processing` (Omise รับคำขอคืนเงินแล้ว), `manual_required` (จ่ายด้วยโอนเงิน ต้องคืนเอง), `failed_needs_manual_review` (เรียก gateway ไม่สำเร็จ)


## Automated tests (Jest)

```bash
npm install       # เพิ่ม jest + supertest เข้ามาแล้วใน devDependencies
```

### Unit tests — ไม่ต้องมีฐานข้อมูล รันได้ทันที
```bash
npm run test:unit
```
ทดสอบ logic ล้วน ๆ ที่ไม่แตะ DB: การคำนวณค่าธรรมเนียมยกเลิก, การสุ่มรหัสจอง, การ hash รหัสผ่าน, JWT sign/verify, refresh token, และ HMAC signature verification ของ 2C2P

### Integration tests — ต้องมี PostgreSQL จริง
```bash
cp .env.test.example .env.test   # แก้ DATABASE_URL_TEST ให้ตรงกับเครื่องคุณ
createdb sleep_and_journey_test  # หรือสร้างผ่านเครื่องมือที่ถนัด
DATABASE_URL="$DATABASE_URL_TEST" npm run migrate   # รัน migration ทั้งหมดใส่ฐานข้อมูลทดสอบ

npm run test:integration
```
**สำคัญ**: ใช้ฐานข้อมูลแยกต่างหากเสมอ (`DATABASE_URL_TEST`) — testsuite จะ `TRUNCATE` ทุกตารางก่อนแต่ละเทสต์ (`tests/helpers/db.js`) ห้ามชี้ไปที่ฐานข้อมูล dev/production เด็ดขาด `tests/setup/env.js` ตั้งใจ**เลือก `DATABASE_URL_TEST` ก่อน**เสมอเพื่อกันความผิดพลาดนี้

**เทสต์ที่สำคัญที่สุดในชุดนี้** คือใน `tests/integration/bookings.test.js`:
```js
test('never oversells the room type under concurrent requests ...', async () => { ... })
```
ยิง 5 คำขอจองพร้อมกันไปที่ห้องที่มีแค่ 2 ห้องจริง แล้วยืนยันว่าสำเร็จได้แค่ 2 คำขอเท่านั้น — นี่คือเทสต์ที่ตรวจสอบ `pg_advisory_xact_lock` ใน `bookingService.js` โดยตรง ถ้าใครมาแก้โค้ดแล้วเผลอลบ lock ออก เทสต์นี้จะ fail ทันที (แทนที่จะรอให้เจอปัญหาจริงตอน production มีคนจองพร้อมกัน)

เทสต์ที่คุ้มค่าอื่น ๆ ที่ครอบคลุมไว้: refresh token rotation (ใช้ซ้ำไม่ได้), บัญชีพนักงานที่ถูกปิดใช้งาน login ไม่ได้, branch scoping ของ `/admin/bookings`, กฎการใช้แต้ม/คืนเงินทุกเงื่อนไข (mock การเรียก Omise refund ด้วย `jest.mock` เพื่อไม่ให้ทดสอบไปยิง API จริงโดยไม่ตั้งใจ)

### ข้อจำกัดของชุดเทสต์นี้
- ยังไม่ครอบคลุมทุก endpoint (เช่น payment initiation ผ่าน Omise จริง ต้องทดสอบด้วยมือกับ test key ตามหัวข้อการชำระเงินด้านบน เพราะการ mock การเรียก HTTP ไปยัง Omise ในทุกกรณีจะทำให้เทสต์ไม่ได้ตรวจสอบ integration จริงกับ API ภายนอก)
- ไม่มี CI pipeline (GitHub Actions ฯลฯ) ตั้งไว้ให้ — ต้องเพิ่มเองพร้อม PostgreSQL service container สำหรับรัน integration tests อัตโนมัติ


## Rate limiting บน login และ register endpoints

```bash
npm run migrate  # เพิ่มตาราง login_attempts และ registration_attempts (007, 008)
```

**ทำไมเก็บใน Postgres แทนที่จะใช้ตัวนับในหน่วยความจำ (เช่น `express-rate-limit` แบบ default) หรือ Redis**: ปัญหาเดียวกับที่เจอตอนทำ cron job ปล่อยห้อง hold — ถ้า deploy มากกว่า 1 instance ตัวนับในหน่วยความจำของแต่ละ instance จะแยกกัน ทำให้คนร้ายได้โควตาผิดพลาดคูณตามจำนวน instance โดยไม่ตั้งใจ เพราะ Postgres เป็น source of truth ของทุกอย่างในระบบนี้อยู่แล้ว จึงใช้มันเก็บ log การพยายามแทนที่จะเพิ่ม infrastructure ใหม่

### กติกาฝั่ง login (`/auth/login`, `/admin/auth/login`)
- บล็อกตาม **อีเมล**: ผิดเกิน 5 ครั้งในเวลา 15 นาที (กันคนร้ายเดารหัสผ่านบัญชีเดียวซ้ำ ๆ)
- บล็อกตาม **IP**: ผิดเกิน 20 ครั้งในเวลา 15 นาที ไม่ว่าจะพยายามกับกี่อีเมลก็ตาม (กันคนร้ายไล่เดาหลายบัญชีจาก IP เดียว)
- การจับคู่อีเมลไม่สนตัวพิมพ์เล็ก-ใหญ่ (`Test@Email.com` กับ `test@email.com` นับรวมกัน) แต่การ login จริงยังใช้ค่าที่พิมพ์มาตรง ๆ เหมือนเดิม ไม่กระทบ logic เดิม
- login สำเร็จไม่ถูกนับเป็นความล้มเหลว และไม่ล้าง log ความล้มเหลวเก่า (ปล่อยให้หมดอายุตามหน้าต่างเวลาไปเอง)

### กติกาฝั่ง register (`/auth/register`) — ต่างจาก login
สมัครสมาชิกไม่มีสัญญาณ "รหัสผ่านผิด" ให้นับ เพราะสคริปต์สแปมจะใช้อีเมลใหม่ทุกครั้ง ทุก request จึงดูถูกต้องผิวเผินเสมอ กติกาเลยต่างออกไป:
- นับ **ทุกความพยายามจาก IP เดียวกัน** ไม่ว่าจะสำเร็จหรือล้มเหลว (แม้แต่สมัครซ้ำด้วยอีเมลเดิมจนเจอ `EMAIL_ALREADY_REGISTERED` ก็นับด้วย เพราะยังกินทรัพยากรเซิร์ฟเวอร์ และใช้ไล่เช็คได้ว่าอีเมลไหนมีบัญชีอยู่แล้ว)
- จำกัดที่ **5 ครั้งต่อ IP ต่อชั่วโมง** (หน้าต่างเวลานานกว่า login เพราะการสมัครสมาชิกไม่ใช่สิ่งที่คนทำถี่ ๆ ตามปกติอยู่แล้ว)

### ตั้งค่าก่อน deploy จริงถ้ามี reverse proxy/load balancer อยู่หน้า API
`rateLimitService` อิง `req.ip` ทั้งสองฝั่ง (login และ register) ถ้าไม่บอก Express ว่าอยู่หลัง proxy กี่ชั้น `req.ip` จะเห็นแค่ IP ของ proxy เอง ทำให้ทุก request หน้าตาเหมือนมาจาก IP เดียวกันหมด (การจำกัดตาม IP จะไร้ความหมายทันที) ตั้งค่าผ่าน env:
```
TRUST_PROXY_HOPS=1
```
**อย่าตั้งมั่ว ๆ** — ถ้าเชื่อ `X-Forwarded-For` มากเกินจำนวน proxy จริง ผู้ใช้จะปลอม IP ตัวเองได้ผ่าน header นี้ตรง ๆ

Error ที่ได้เมื่อถูกจำกัด: `429 TOO_MANY_ATTEMPTS` (login) หรือ `429 TOO_MANY_REGISTRATIONS` (register) — ทั้งคู่แนบ `details.retry_after_minutes` มาด้วย


## ทำความสะอาด log การจำกัดจำนวนครั้ง (cron job)

ตาราง `login_attempts` และ `registration_attempts` เก็บทุกความพยายามไว้ไม่มีวันลบเอง (ตัว rate limiter อ่านแค่ข้อมูลในหน้าต่างเวลา 15/60 นาทีล่าสุดเท่านั้น แต่แถวเก่ายังค้างอยู่ในตารางตลอดไปถ้าไม่มีใครลบ) job นี้ลบแถวที่เก่ากว่า 30 วันทิ้ง

### ทดสอบรันเอง
```bash
npm run jobs:cleanup-rate-limit-logs
```

### ตั้งให้รันอัตโนมัติ
งานนี้ไม่เร่งด่วนเท่า `release-expired-holds` (ไม่กระทบความถูกต้องของระบบเลยแม้จะไม่รันหลายวัน) รันวันละครั้งก็เกินพอ เลือก deploy ตามแบบเดียวกับ job ปล่อยห้อง hold:

- **system crontab**: `0 3 * * * cd /path/to/sleep-and-journey-api && /usr/bin/npm run jobs:cleanup-rate-limit-logs >> /var/log/sj-cron.log 2>&1` (รันตี 3 ทุกวัน)
- **Railway / Render Cron**: ชี้ไปที่ `npm run jobs:cleanup-rate-limit-logs` ตั้ง schedule เป็น `0 3 * * *`
- **Kubernetes CronJob**: `node src/jobs/cleanupRateLimitLogs.js` แทน `node src/server.js`

เหมือนเดิม**ห้ามฝังไว้ใน `server.js` ด้วย `setInterval`** ด้วยเหตุผลเดียวกับ job อื่น ๆ — รันหลาย instance พร้อมกันจะลบข้อมูลซ้ำซ้อนกันโดยไม่จำเป็น (ไม่ได้อันตรายเท่า overbooking แต่ก็เปลืองโดยใช่เหตุ)


## CI: รันเทสต์อัตโนมัติด้วย GitHub Actions

Workflow อยู่ที่ `.github/workflows/test.yml` ทำงานทุกครั้งที่ push หรือเปิด pull request เข้า `main`

### สิ่งที่ workflow นี้ทำ
1. สั่ง Postgres จริง (ไม่ใช่ mock) ขึ้นมาเป็น service container ของ job — รอจน health check ผ่านก่อนถึงจะรัน step ถัดไป ไม่ต้องเขียน step "wait for postgres" เอง
2. `npm ci` ติดตั้ง dependency ตาม `package-lock.json` เป๊ะ ๆ (เร็วกว่าและ deterministic กว่า `npm install`)
3. รัน migration ทั้งหมดใส่ฐานข้อมูลทดสอบใน container
4. รัน `npm run test:unit` แล้ว `npm run test:integration` แยกกัน จะได้เห็นชัดใน log ว่าพังจากฝั่งไหน

### สิ่งที่ต้องทำก่อน push workflow นี้ใช้งานได้จริง
```bash
npm install          # สร้าง package-lock.json ถ้ายังไม่มี
git add package-lock.json
git commit -m "Add package-lock.json for reproducible CI installs"
```
`npm ci` ใน workflow จะ **fail ทันที** ถ้า repo ไม่มี `package-lock.json` — เป็นความตั้งใจ ไม่ใช่บั๊ก เพื่อบังคับให้ dependency version ที่ใช้ตอน dev กับตอน CI ตรงกันเป๊ะเสมอ

### ดูผลลัพธ์
เข้าไปที่แท็บ **Actions** ในหน้า repository บน GitHub จะเห็นทุกครั้งที่ push ว่าเทสต์ผ่านหรือไม่ และดู log แบบ step-by-step ได้ตรงจุดที่พัง


## สิ่งที่ตัวอย่างนี้ยังไม่ทำ (ต้องต่อยอด)

- **ยืนยันฟิลด์/API version ของ 2C2P กับสัญญาจริง** — โครงสร้าง request/response/webhook implement ครบแล้ว (ดูหัวข้อการชำระเงินด้านบน) แต่ยังเป็น "รูปแบบที่น่าจะตรง" ไม่ใช่ verified กับบัญชีจริง ต้องเทียบกับ Postman collection ของ 2C2P ก่อนใช้เงินจริงเสมอ
