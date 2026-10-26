const express = require('express');
const { run, all, get } = require('../db');
const { STORE_CATEGORIES } = require('../utils/categories');

const router = express.Router();

router.get('/stores', async (req, res) => {
  const stores = await all('SELECT * FROM stores ORDER BY name ASC');
  res.render('stores', { stores, storeCategories: STORE_CATEGORIES });
});

router.post('/stores', async (req, res) => {
  const redirectTo = req.body.redirect_to || '/stores';
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(redirectTo);
  const lat = req.body.lat ? Number(req.body.lat) : null;
  const lng = req.body.lng ? Number(req.body.lng) : null;
  const category = (req.body.category || '').trim() || null;
  const { lastID } = await run('INSERT INTO stores (name, lat, lng, category, created_by) VALUES (?, ?, ?, ?, ?)', [name, lat, lng, category, req.user.id]);
  // Carried back as query params so the store-locator (if that's where this
  // came from) can auto-set the just-added store as "current" without the
  // person having to click "تحديد الموقع" a second time to find it again.
  // Harmless/unused on any page that isn't listening for them (e.g. /stores).
  const sep = redirectTo.includes('?') ? '&' : '?';
  res.redirect(redirectTo + sep + 'new_store_id=' + lastID + '&new_store_name=' + encodeURIComponent(name));
});

router.post('/stores/:id/edit', async (req, res) => {
  const storeId = Number(req.params.id);
  const store = await get('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (store && (store.created_by === req.user.id || req.user.is_admin)) {
    const name = (req.body.name || '').trim();
    const category = (req.body.category || '').trim() || null;
    if (name) {
      await run('UPDATE stores SET name = ?, category = ? WHERE id = ?', [name, category, storeId]);
    }
  }
  res.redirect('/stores');
});

router.post('/stores/:id/delete', async (req, res) => {
  const storeId = Number(req.params.id);
  const store = await get('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (store && (store.created_by === req.user.id || req.user.is_admin)) {
    await run('UPDATE item_purchases SET store_id = NULL WHERE store_id = ?', [storeId]);
    await run('DELETE FROM stores WHERE id = ?', [storeId]);
  }
  res.redirect('/stores');
});

module.exports = router;
