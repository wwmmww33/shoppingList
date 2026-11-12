const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Jimp } = require('jimp');

// Optional brand photo on a purchase: kept deliberately tiny (resized to a
// 200px-max thumbnail, re-encoded as JPEG) since it's only ever shown as a
// small thumbnail, not a full image — this keeps per-upload disk usage low.
const BRAND_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'brands');
const BRAND_THUMB_MAX_DIM = 200;

const brandImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Swallows upload errors (bad type, too large, etc.) rather than failing the
// whole action — a brand photo is optional, so a bad upload should just be
// skipped instead of blocking whatever it's attached to.
const uploadBrandImage = (req, res, next) => {
  brandImageUpload.single('brand_image')(req, res, () => next());
};

const saveBrandImage = async (file) => {
  if (!file) return null;
  try {
    fs.mkdirSync(BRAND_UPLOAD_DIR, { recursive: true });
    const image = await Jimp.read(file.buffer);
    image.scaleToFit({ w: BRAND_THUMB_MAX_DIM, h: BRAND_THUMB_MAX_DIM });
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    await image.write(path.join(BRAND_UPLOAD_DIR, filename), { quality: 70 });
    return `/uploads/brands/${filename}`;
  } catch (err) {
    console.error('brand image processing failed:', err.message);
    return null;
  }
};

// A brand photo path the client carried over (e.g. from a past brand) —
// only accepted if it's one of our own uploads that actually exists, never
// trusted blindly. Returns the path or null.
const validExistingBrandImage = (p) =>
  typeof p === 'string' &&
  /^\/uploads\/brands\/[A-Za-z0-9._-]+$/.test(p) &&
  fs.existsSync(path.join(BRAND_UPLOAD_DIR, path.basename(p)))
    ? p
    : null;

module.exports = { BRAND_UPLOAD_DIR, BRAND_THUMB_MAX_DIM, brandImageUpload, uploadBrandImage, saveBrandImage, validExistingBrandImage };
