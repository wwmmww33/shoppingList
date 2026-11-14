const express = require('express');
const { run, all, get } = require('../db');
const { STORE_CATEGORIES } = require('../utils/categories');

const router = express.Router();

router.get('/stores', async (req, res) => {
  const stores = await all('SELECT * FROM stores ORDER BY name ASC');
  res.render('stores', { stores, storeCategories: STORE_CATEGORIES });
});

// What this person has bought from this store before — stores are a shared
// directory (anyone can see the list), but purchase history stays scoped to
// their own accessible lists (owner or shared), same privacy rule as
// everywhere else. One row per distinct item name, its latest brand/detail
// bought here, and how many times.
router.get('/stores/:id', async (req, res) => {
  const storeId = Number(req.params.id);
  const store = await get('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (!store) return res.status(404).send('غير موجود');

  const purchases = await all(
    `SELECT li.id AS item_id, li.name AS item_name, li.category, ip.brand, ip.brand_detail, ip.price, ip.purchased_qty, ip.bought_at, cnt.purchase_count
     FROM item_purchases ip
     JOIN list_items li ON li.id = ip.item_id
     JOIN (
       SELECT li2.name AS name, COUNT(*) AS purchase_count, MAX(ip2.id) AS max_id
       FROM item_purchases ip2
       JOIN list_items li2 ON li2.id = ip2.item_id
       WHERE ip2.store_id = ?
         AND li2.list_id IN (
           SELECT id FROM lists WHERE owner_id = ?
           UNION
           SELECT list_id FROM list_shares WHERE user_id = ?
         )
       GROUP BY li2.name
     ) cnt ON cnt.name = li.name AND cnt.max_id = ip.id
     ORDER BY ip.bought_at DESC`,
    [storeId, req.user.id, req.user.id]
  );
  const itemCategories = await all('SELECT * FROM item_categories ORDER BY sort_order ASC, id ASC');
  res.render('store-detail', { store, purchases, itemCategories });
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
