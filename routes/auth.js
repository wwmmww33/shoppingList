const express = require('express');
const bcrypt = require('bcryptjs');
const { run, get, all } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { CUSTOM_CATEGORY_ICONS } = require('../utils/categories');
const { normalizeProductText } = require('../utils/text');
const { uploadBrandImage, saveBrandImage } = require('../utils/brandImages');

const router = express.Router();

// A list this user can see something from (owner or shared), reused by every
// brands-management query/mutation below so a brand can never be viewed or
// edited through someone else's unrelated list.
const accessibleListsClause = `
  SELECT id FROM lists WHERE owner_id = ?
  UNION
  SELECT list_id FROM list_shares WHERE user_id = ?
`;

// Groups every brand/detail ever recorded (purchase history) by the item
// name it was bought under, then by that item's category — no prices or
// store/date info, just what's needed to recognize and manage the brand
// itself (name, details, photo). Rows are read newest-first, so the first
// time a given (item name, brand, detail) combo is seen, that's already its
// most recent photo and its item's current category.
const loadBrandsByCategory = async (userId) => {
  const rows = await all(
    `SELECT li.name AS item_name, li.category, ip.brand, ip.brand_detail, ip.brand_image
     FROM item_purchases ip
     JOIN list_items li ON li.id = ip.item_id
     WHERE li.list_id IN (${accessibleListsClause})
       AND ((ip.brand IS NOT NULL AND ip.brand != '') OR (ip.brand_detail IS NOT NULL AND ip.brand_detail != ''))
     ORDER BY ip.id DESC`,
    [userId, userId]
  );
  const itemCategory = {};
  const groups = new Map();
  rows.forEach((r) => {
    if (!(r.item_name in itemCategory)) itemCategory[r.item_name] = r.category;
    const key = r.item_name + '|' + normalizeProductText(r.brand) + '|' + normalizeProductText(r.brand_detail);
    if (!groups.has(key)) groups.set(key, { itemName: r.item_name, brand: r.brand, detail: r.brand_detail, image: r.brand_image });
  });
  const byCategory = {};
  for (const g of groups.values()) {
    const cat = itemCategory[g.itemName] || '';
    (byCategory[cat] = byCategory[cat] || []).push(g);
  }
  Object.values(byCategory).forEach((list) => list.sort((a, b) => a.itemName.localeCompare(b.itemName, 'ar')));
  return byCategory;
};

// Every item_purchases row this user can reach whose (item name, brand,
// detail) matches — the same loose match loadBrandsByCategory grouped by —
// used by both the rename and move actions below so they touch exactly the
// rows shown as "this brand" and nothing from another user's list.
const findBrandPurchaseIds = async (userId, itemName, brand, detail) => {
  const rows = await all(
    `SELECT ip.id, ip.brand, ip.brand_detail
     FROM item_purchases ip
     JOIN list_items li ON li.id = ip.item_id
     WHERE li.name = ? AND li.list_id IN (${accessibleListsClause})`,
    [itemName, userId, userId]
  );
  const normBrand = normalizeProductText(brand);
  const normDetail = normalizeProductText(detail);
  return rows
    .filter((r) => normalizeProductText(r.brand) === normBrand && normalizeProductText(r.brand_detail) === normDetail)
    .map((r) => r.id);
};

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const confirmPassword = req.body.confirm_password || '';

  if (!name || !email || !password || !confirmPassword) {
    return res.render('register', { error: 'يرجى تعبئة كل الحقول' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'كلمة المرور وتأكيدها غير متطابقين' });
  }

  const existing = await get('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existing) {
    return res.render('register', { error: 'هذا الإيميل مسجل بالفعل' });
  }

  const userCount = await get('SELECT COUNT(*) AS c FROM users');
  const isFirstUser = userCount.c === 0;

  const passwordHash = await bcrypt.hash(password, 10);
  const { lastID } = await run(
    'INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?)',
    [name, email, passwordHash, isFirstUser ? 1 : 0]
  );

  req.session.userId = lastID;
  res.redirect('/');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  const user = await get('SELECT * FROM users WHERE LOWER(email) = ?', [email]);
  if (!user) return res.render('login', { error: 'الإيميل أو كلمة المرور غير صحيحة' });
  if (user.is_suspended) return res.render('login', { error: 'تم إيقاف هذا الحساب، تواصل مع المدير' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.render('login', { error: 'الإيميل أو كلمة المرور غير صحيحة' });

  req.session.userId = user.id;
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Every distinct item name this user can reach — offered as the "move to"
// target list so a brand's history always lands on a real, existing item.
const loadAllItemNames = async (userId) =>
  (await all(
    `SELECT DISTINCT name FROM list_items WHERE list_id IN (${accessibleListsClause}) ORDER BY name ASC`,
    [userId, userId]
  )).map((r) => r.name);

router.get('/account', requireAuth, async (req, res) => {
  const itemCategories = await all('SELECT * FROM item_categories ORDER BY sort_order ASC, id ASC');
  const brandsByCategory = await loadBrandsByCategory(req.user.id);
  const allItemNames = await loadAllItemNames(req.user.id);
  res.render('account', { error: null, success: null, itemCategories, customCategoryIcons: CUSTOM_CATEGORY_ICONS, brandsByCategory, allItemNames });
});

router.post('/account/password', requireAuth, async (req, res) => {
  const currentPassword = req.body.current_password || '';
  const newPassword = req.body.new_password || '';
  const confirmPassword = req.body.confirm_password || '';

  const renderAccount = async (error, success) => {
    const itemCategories = await all('SELECT * FROM item_categories ORDER BY sort_order ASC, id ASC');
    const brandsByCategory = await loadBrandsByCategory(req.user.id);
    const allItemNames = await loadAllItemNames(req.user.id);
    res.render('account', { error, success, itemCategories, customCategoryIcons: CUSTOM_CATEGORY_ICONS, brandsByCategory, allItemNames });
  };

  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);

  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) {
    return renderAccount('كلمة المرور الحالية غير صحيحة', null);
  }
  if (newPassword.length < 6) {
    return renderAccount('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل', null);
  }
  if (newPassword !== confirmPassword) {
    return renderAccount('تأكيد كلمة المرور غير مطابق', null);
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

  renderAccount(null, 'تم تغيير كلمة المرور بنجاح');
});

// Edits a brand/detail/photo across every purchase it's recorded under (not
// just one) — the brands page groups by exactly this match, so an edit here
// has to apply to the same set or the brand would look unchanged on some of
// its own purchases. The photo is optional per edit (kept as-is if no new
// one is picked).
router.post('/brands/edit', requireAuth, uploadBrandImage, async (req, res) => {
  const itemName = (req.body.item_name || '').trim();
  const brand = (req.body.brand || '').trim();
  const detail = (req.body.detail || '').trim();
  const newBrand = (req.body.new_brand || '').trim().slice(0, 80) || null;
  const newDetail = (req.body.new_detail || '').trim().slice(0, 120) || null;
  if (!itemName) return res.redirect('/account#brands');

  const ids = await findBrandPurchaseIds(req.user.id, itemName, brand, detail);
  if (ids.length > 0) {
    const image = await saveBrandImage(req.file);
    const placeholders = ids.map(() => '?').join(', ');
    if (image) {
      await run(`UPDATE item_purchases SET brand = ?, brand_detail = ?, brand_image = ? WHERE id IN (${placeholders})`, [newBrand, newDetail, image, ...ids]);
    } else {
      await run(`UPDATE item_purchases SET brand = ?, brand_detail = ? WHERE id IN (${placeholders})`, [newBrand, newDetail, ...ids]);
    }
  }
  res.redirect('/account#brands');
});

// Re-points a brand's whole purchase history from one item to another (e.g.
// it was logged under the wrong generic item name) — targets the most
// recently added item row with that name the person can reach; the target
// must already exist (picked from a known list), since a brand's history
// has to land somewhere real, not create a new item implicitly.
router.post('/brands/move', requireAuth, async (req, res) => {
  const itemName = (req.body.item_name || '').trim();
  const brand = (req.body.brand || '').trim();
  const detail = (req.body.detail || '').trim();
  const targetItemName = (req.body.target_item_name || '').trim();
  if (!itemName || !targetItemName || targetItemName === itemName) return res.redirect('/account#brands');

  const target = await get(
    `SELECT li.id FROM list_items li
     WHERE li.name = ? AND li.list_id IN (${accessibleListsClause})
     ORDER BY li.id DESC LIMIT 1`,
    [targetItemName, req.user.id, req.user.id]
  );
  if (!target) return res.redirect('/account#brands');

  const ids = await findBrandPurchaseIds(req.user.id, itemName, brand, detail);
  if (ids.length > 0) {
    await run(`UPDATE item_purchases SET item_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [target.id, ...ids]);
  }
  res.redirect('/account#brands');
});

module.exports = router;
