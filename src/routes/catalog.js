const express = require('express');
const router = express.Router();
const catalogService = require('../services/catalogService');
const { requireAuth, requireRole } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

// GET /v1/branches?lang=en&region=เหนือ
router.get('/branches', async (req, res, next) => {
  try {
    const branches = await catalogService.listBranches(req.query.lang, { region: req.query.region });
    res.json({ data: branches });
  } catch (err) {
    next(err);
  }
});

// GET /v1/branches/:id?lang=en
router.get('/branches/:id', async (req, res, next) => {
  try {
    const hotel = await catalogService.getHotelDetails(req.params.id, req.query.lang);
    res.json(hotel);
  } catch (err) {
    next(err);
  }
});

// GET /v1/room-types/:id?lang=ja
router.get('/room-types/:id', async (req, res, next) => {
  try {
    const roomType = await catalogService.getRoomTypeDetails(req.params.id, req.query.lang);
    res.json(roomType);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin content entry - hq_admin only for now. (Could be loosened to let a
// branch_manager edit translations for their own branch_id later, but that
// needs a branch-ownership check on room_types/amenities too - keeping this
// simple until there's an actual content-editor role in use.)
// ---------------------------------------------------------------------------

// PATCH /v1/admin/branches/:id  body: any subset of { name, description, star_rating, cover_image_url, check_in_time, check_out_time }
router.patch(
  '/admin/branches/:id',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const branch = await catalogService.updateBranchDetails(req.params.id, req.body);
      res.json(branch);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /v1/admin/room-types/:id  body: any subset of { name, description, base_price, size_sqm, bed_type, bed_count, max_adults, max_children, view_type, smoking_allowed }
router.patch(
  '/admin/room-types/:id',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const roomType = await catalogService.updateRoomTypeDetails(req.params.id, req.body);
      res.json(roomType);
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/admin/branches/:id/translations  body: { language_code, name, description }
router.post(
  '/admin/branches/:id/translations',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const translation = await catalogService.upsertBranchTranslation(req.params.id, req.body);
      res.status(200).json(translation);
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/admin/room-types/:id/translations  body: { language_code, name, description }
router.post(
  '/admin/room-types/:id/translations',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const translation = await catalogService.upsertRoomTypeTranslation(req.params.id, req.body);
      res.status(200).json(translation);
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/admin/amenities/:id/translations  body: { language_code, name, category }
router.post(
  '/admin/amenities/:id/translations',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const translation = await catalogService.upsertAmenityTranslation(req.params.id, req.body);
      res.status(200).json(translation);
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/admin/room-types/:id/images  body: { image_url, alt_text?, display_order?, is_cover? }
router.post(
  '/admin/room-types/:id/images',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const image = await catalogService.addRoomTypeImage(req.params.id, req.body);
      res.status(201).json(image);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /v1/admin/room-types/:id/images/:imageId  body: any subset of { alt_text, display_order, is_cover }
router.patch(
  '/admin/room-types/:id/images/:imageId',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const image = await catalogService.updateRoomTypeImage(
        req.params.id,
        req.params.imageId,
        req.body
      );
      res.json(image);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /v1/admin/room-types/:id/images/:imageId
router.delete(
  '/admin/room-types/:id/images/:imageId',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      await catalogService.deleteRoomTypeImage(req.params.id, req.params.imageId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/admin/room-types/:id/images/:imageId/translations  body: { language_code, alt_text }
router.post(
  '/admin/room-types/:id/images/:imageId/translations',
  requireAuth,
  requireRole('hq_admin'),
  async (req, res, next) => {
    try {
      const translation = await catalogService.upsertImageAltTranslation(
        req.params.id,
        req.params.imageId,
        req.body
      );
      res.status(200).json(translation);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
