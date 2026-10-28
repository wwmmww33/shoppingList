const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Jimp } = require('jimp');
const { run, get, all } = require('../db');
const { requireListAccess } = require('../middleware/listAccess');
const { nextWeekdayAfter, todayDateOnlyString, WEEKDAY_NAMES_AR, nowOmanString, formatDateArabic } = require('../utils/dates');
const { STORE_CATEGORIES, itemCategoryOrder, itemCategoryMapFrom, CUSTOM_CATEGORY_ICONS, nextCategoryColor } = require('../utils/categories');
const { UNITS } = require('../utils/units');
const { askAI, getAIProvider } = require('../utils/ai');

const router = express.Router();

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
// whole "mark as bought" action — the photo is optional, so a bad upload
// should just be skipped instead of blocking the purchase.
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

// Best-effort AI read of a brand photo's name/variant (via the configured AI
// provider, see utils/ai.js), offered purely as a pre-fill: the brand/detail
// fields stay plain editable text, so the person can always correct or
// replace whatever this suggests, or skip it and type everything manually.
// Sent much larger than the stored 200px thumbnail: at that size the small
// print (size, weight, variant) is unreadable, so specs never came back.
const BRAND_AI_MAX_DIM = 768;
const analyzeBrandImageWithAI = async (file) => {
  if (!file || !getAIProvider()) return { brand: null, detail: null };
  try {
    const image = await Jimp.read(file.buffer);
    image.scaleToFit({ w: BRAND_AI_MAX_DIM, h: BRAND_AI_MAX_DIM });
    const buffer = await image.getBuffer('image/jpeg', { quality: 80 });
    const result = await askAI({
      prompt:
        'هذه صورة لمنتج أو بطاقة سعر من محل بقالة. استخرج:\n' +
        '1) brand: اسم البراند/الماركة التجارية كما هو مكتوب.\n' +
        '2) detail: مواصفات المنتج المكتوبة عليه باختصار — الحجم أو الوزن أو السعة (مثل 1 لتر، 500 جرام، 12 حبة) ' +
        'والنوع أو النكهة (مثل قليل الدسم، بالفراولة) — بدون تكرار اسم البراند.\n' +
        'كل واحد مستقل عن الآخر: إذا ظهرت المواصفات ولم يظهر البراند فأعد المواصفات، والعكس.\n' +
        'أجب فقط بصيغة JSON مضغوطة بدون أي نص آخر: {"brand": "...", "detail": "..."}، وضع null لما لا يظهر.',
      imageBase64: buffer.toString('base64'),
      maxTokens: 200,
      timeoutMs: 20000,
    });
    if (!result.ok) return { brand: null, detail: null };
    const text = result.text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { brand: null, detail: null };
    const parsed = JSON.parse(match[0]);
    const clean = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim().slice(0, 120) : null);
    return { brand: clean(parsed.brand), detail: clean(parsed.detail) };
  } catch (err) {
    console.error('brand image AI analysis failed:', err.message);
    return { brand: null, detail: null };
  }
};

// Best-effort AI guess at an item's category from its plain name, offered as
// a pre-fill only (see client-side: it never overwrites a category the
// person already set, by hand or from a previous suggestion).
const classifyItemCategoryWithAI = async (name, categories) => {
  if (!name) return { category: null, reason: 'no_name' };
  const categoryList = categories.map((c) => `${c.key}: ${c.label}`).join('\n');
  const result = await askAI({
    prompt:
      'صنّف اسم الغرض التالي ضمن إحدى هذه الفئات فقط. أجب برمز الفئة (key) فقط بدون أي نص إضافي، أو بكلمة none إذا لم تنطبق أي فئة بوضوح:\n' +
      categoryList +
      '\n\nاسم الغرض: ' +
      name,
    maxTokens: 20,
    timeoutMs: 10000,
  });
  if (!result.ok) return { category: null, reason: result.reason };
  // Keep digits: custom category keys look like "custom_mvoo003s_h2kah3"
  // (stripping them made custom categories impossible to match).
  const text = result.text.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const category = itemCategoryMapFrom(categories)[text] ? text : null;
  return { category, reason: category ? null : 'no_match' };
};

// "إضافة غرض" from a photo: one AI call that names the item generically (the
// kind of product — "حليب", not its brand), picks its category from the
// existing ones and the unit it's usually bought in. Pre-fill only; every
// field stays editable. The photo itself is not stored. Sent larger than
// brand thumbnails since recognizing the product needs more detail than
// reading a label.
const ITEM_PHOTO_MAX_DIM = 512;
const analyzeItemImageWithAI = async (file, categories) => {
  const empty = { name: null, category: null, unit: null, details: null };
  if (!file) return { ...empty, reason: 'no_image' };
  if (!getAIProvider()) return { ...empty, reason: 'no_api_key' };
  let base64;
  try {
    const image = await Jimp.read(file.buffer);
    image.scaleToFit({ w: ITEM_PHOTO_MAX_DIM, h: ITEM_PHOTO_MAX_DIM });
    base64 = (await image.getBuffer('image/jpeg', { quality: 75 })).toString('base64');
  } catch (err) {
    console.error('item photo processing failed:', err.message);
    return { ...empty, reason: 'bad_image' };
  }
  const categoryList = categories.map((c) => `${c.key}: ${c.label}`).join('\n');
  const unitList = UNITS.map((u) => `${u.key}: ${u.label}`).join('\n');
  const result = await askAI({
    prompt:
      'هذه صورة غرض أريد إضافته لقائمة مشتريات منزلية. ' +
      'ما هو الغرض؟ اكتب اسمه العام بالعربية كما يُكتب في قائمة مشتريات (نوع المنتج، مثل: حليب، أرز، صابون صحون) ' +
      'وليس اسم الماركة أو الحجم. ثم اختر تصنيفه من هذه الفئات فقط (رمز الفئة key)، أو none إذا لم تنطبق أي فئة:\n' +
      categoryList +
      '\n\nواختر الوحدة التي يُشترى بها هذا الغرض عادةً من هذه الوحدات فقط (رمز الوحدة key)، أو none إذا لم تكن واضحة:\n' +
      unitList +
      '\n\nوأضف تفاصيل قصيرة إن ظهرت في الصورة بوضوح (النوع أو النكهة أو الحجم، مثل: قليل الدسم، 1 لتر، بالفراولة) ' +
      'بدون اسم الماركة، أو null إذا لم تظهر.' +
      '\n\nأجب فقط بصيغة JSON مضغوطة بدون أي نص آخر: {"name": "...", "category": "...", "unit": "...", "details": "..."}. ' +
      'إذا لم تستطع التعرف على الغرض ضع null للاسم.',
    imageBase64: base64,
    maxTokens: 160,
    timeoutMs: 20000,
  });
  if (!result.ok) return { ...empty, reason: result.reason };
  try {
    const match = result.text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : null;
    const catKey = String(parsed.category || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const category = itemCategoryMapFrom(categories)[catKey] ? catKey : null;
    const unitKey = String(parsed.unit || '').trim().toLowerCase();
    const unit = UNITS.some((u) => u.key === unitKey) ? unitKey : null;
    const details = typeof parsed.details === 'string' && parsed.details.trim() && parsed.details.trim() !== 'null'
      ? parsed.details.trim().slice(0, 120)
      : null;
    return { name, category, unit, details, reason: name ? null : 'not_recognized' };
  } catch (err) {
    console.error('item photo AI reply unreadable:', err.message);
    return { ...empty, reason: 'not_recognized' };
  }
};

// Loaded fresh per request (not cached in memory) so a category someone just
// added shows up immediately for everyone, including in the same request that
// created it (e.g. after /categories redirects back here).
const loadItemCategories = () => all('SELECT * FROM item_categories ORDER BY sort_order ASC, id ASC');

const generateCategoryKey = () => 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

// Sends the uncategorized active items in a list to the AI provider and asks
// it to propose a small number of NEW categories (distinct from the ones that
// already exist) to group them under. Returns [] on any failure — this is a
// convenience suggestion, never something the rest of the app depends on.
const suggestCategoriesWithAI = async (itemNames, existingCategories) => {
  if (!getAIProvider() || itemNames.length === 0) return [];
  try {
    const existingList = existingCategories.map((c) => c.label).join('، ') || 'لا يوجد';
    const iconList = CUSTOM_CATEGORY_ICONS.join(', ');
    const result = await askAI({
      prompt:
        'لدي الأغراض التالية بدون تصنيف في قائمة مشتريات منزلية:\n' +
        itemNames.join('، ') +
        '\n\nالتصنيفات الموجودة حاليًا (لا تقترح تصنيفات مشابهة لها): ' +
        existingList +
        '\n\nاقترح حتى 3 تصنيفات جديدة ومفيدة لتجميع بعض هذه الأغراض تحتها (تجاهل أي غرض لا يستحق تصنيفًا خاصًا به). ' +
        'أجب فقط بـ JSON صالح على هذا الشكل بدون أي نص إضافي:\n' +
        '[{"label": "اسم التصنيف بالعربية", "icon": "اسم أيقونة من هذه القائمة فقط: ' +
        iconList +
        '", "items": ["اسم الغرض كما ورد بالضبط", "..."]}]',
      maxTokens: 500,
      timeoutMs: 15000,
    });
    if (!result.ok) return [];
    let text = result.text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const validIcons = new Set(CUSTOM_CATEGORY_ICONS);
    const validItemNames = new Set(itemNames);
    return parsed
      .filter((s) => s && typeof s.label === 'string' && s.label.trim() && Array.isArray(s.items))
      .map((s) => ({
        label: s.label.trim().slice(0, 60),
        icon: validIcons.has(s.icon) ? s.icon : 'package',
        items: s.items.filter((n) => validItemNames.has(n)),
      }))
      .filter((s) => s.items.length > 0)
      .slice(0, 3);
  } catch (err) {
    console.error('AI category suggestion failed:', err.message);
    return [];
  }
};

// Lazily flips any due weekly item back to 'active'. Mirrors the
// "compute on read" pattern used for the rest of this app's time-based state.
const syncDueWeeklyItems = (listId) =>
  run(
    "UPDATE list_items SET status = 'active' WHERE list_id = ? AND is_weekly = 1 AND status = 'bought' AND next_due_date <= ?",
    [listId, todayDateOnlyString()]
  );

// Per item, one entry per distinct (brand, detail, store) combination ever
// bought — not just per brand name. The same brand can be sold in different
// packaging/variants and bought from different stores at different prices
// (e.g. "جبن سالم / كرتون / محل أ" vs "جبن سالم / كرتون / محل ب"), so each
// such profile is its own selectable option, pre-filling detail/price/photo
// AND store from exactly that profile's last purchase.
// Keyed by the item's NAME (scoped to lists this user owns or is shared on),
// not by this specific list_items row id — an item bought once, then bought
// out and re-added later as a brand-new row (rather than reopened from the
// archive), would otherwise look like it had never been bought before, and
// every past brand profile for it would be invisible.
const attachPastBrands = async (items, userId) => {
  if (items.length === 0) return items;
  const names = [...new Set(items.map((i) => i.name))];
  const placeholders = names.map(() => '?').join(', ');
  const rows = await all(
    `SELECT li2.name AS item_name, ip.brand, ip.brand_detail, ip.price, ip.purchased_qty, ip.brand_image, ip.store_id, s.name AS store_name, ip.bought_at
     FROM item_purchases ip
     JOIN list_items li2 ON li2.id = ip.item_id
     LEFT JOIN stores s ON s.id = ip.store_id
     INNER JOIN (
       SELECT MAX(ip2.id) AS max_id
       FROM item_purchases ip2
       JOIN list_items li3 ON li3.id = ip2.item_id
       WHERE li3.name IN (${placeholders})
         AND li3.list_id IN (
           SELECT id FROM lists WHERE owner_id = ?
           UNION
           SELECT list_id FROM list_shares WHERE user_id = ?
         )
         AND ((ip2.brand IS NOT NULL AND ip2.brand != '') OR (ip2.brand_detail IS NOT NULL AND ip2.brand_detail != ''))
       GROUP BY li3.name, ip2.brand, ip2.brand_detail, ip2.store_id
     ) latest ON latest.max_id = ip.id
     ORDER BY ip.bought_at DESC`,
    [...names, userId, userId]
  );
  const byName = {};
  rows.forEach((r) => {
    if (!byName[r.item_name]) byName[r.item_name] = [];
    byName[r.item_name].push({
      brand: r.brand,
      detail: r.brand_detail,
      price: r.price,
      qty: r.purchased_qty,
      image: r.brand_image,
      storeId: r.store_id,
      storeName: r.store_name,
    });
  });
  return items.map((i) => ({ ...i, pastBrands: byName[i.name] || [] }));
};

const byCategory = (categories) => (a, b) => itemCategoryOrder(a.category, categories) - itemCategoryOrder(b.category, categories);
// Most recently bought first; items never bought (no date to rank by) sink to the end.
const byRecency = (a, b) => {
  if (!a.last_bought_at && !b.last_bought_at) return 0;
  if (!a.last_bought_at) return 1;
  if (!b.last_bought_at) return -1;
  return b.last_bought_at.localeCompare(a.last_bought_at);
};

const loadItemsForList = async (listId, { isOwner, cancelledSort, categories, hiddenFilter, storeFilter, userId }) => {
  const hiddenClause = isOwner ? '' : 'AND li.hidden_from_shared = 0';
  const rows = await all(
    `SELECT li.*, u.name AS added_by_name,
            lp.bought_at AS last_bought_at,
            lp.brand AS last_brand,
            lp.brand_detail AS last_brand_detail,
            lp.brand_image AS last_brand_image,
            lp.price AS last_price,
            lp.purchased_qty AS last_purchased_qty,
            ls.name AS last_store_name,
            ps.name AS planned_store_name
     FROM list_items li
     LEFT JOIN users u ON u.id = li.added_by
     LEFT JOIN (
       SELECT ip.* FROM item_purchases ip
       INNER JOIN (SELECT item_id, MAX(id) AS max_id FROM item_purchases GROUP BY item_id) latest
         ON latest.item_id = ip.item_id AND latest.max_id = ip.id
     ) lp ON lp.item_id = li.id
     LEFT JOIN stores ls ON ls.id = lp.store_id
     LEFT JOIN stores ps ON ps.id = li.planned_store_id
     WHERE li.list_id = ? ${hiddenClause}
     ORDER BY li.created_at ASC`,
    [listId]
  );
  const items = await attachPastBrands(rows, userId);
  const secondarySort = cancelledSort === 'category' ? byCategory(categories) : byRecency;

  let active = items.filter((i) => i.status === 'active').sort(byCategory(categories));
  if (hiddenFilter === 'hide') active = active.filter((i) => !i.hidden_from_shared);
  else if (hiddenFilter === 'only') active = active.filter((i) => i.hidden_from_shared);
  if (storeFilter) active = active.filter((i) => i.planned_store_id === storeFilter);
  const bought = items.filter((i) => i.status === 'bought');
  const cancelled = items.filter((i) => i.status === 'cancelled');
  // The archive drawer also lists every active item (marked "في القائمة"),
  // so restoring an item leaves it in place, highlighted, instead of making
  // it vanish — and anyone browsing it can see what's already on the list.
  // Unfiltered by the active list's hidden/store filters on purpose.
  const allActive = items.filter((i) => i.status === 'active');
  const archived = bought.concat(cancelled, allActive).sort(secondarySort);

  return { active, archived };
};

const loadAvailableListsFor = (userId, excludeListId) =>
  all(
    `SELECT id, title FROM (
       SELECT id, title FROM lists WHERE owner_id = ?
       UNION
       SELECT l.id, l.title FROM lists l JOIN list_shares s ON s.list_id = l.id WHERE s.user_id = ?
     ) WHERE id != ? ORDER BY title ASC`,
    [userId, userId, excludeListId]
  );

// Every past purchase recorded under this specific list, grouped by calendar
// day (most recent day first) — a shopping-trip log shown at the top of the
// list page, separate from any single item's own "سجل الشراء" page.
const loadShoppingHistoryByDate = async (listId) => {
  const rows = await all(
    `SELECT substr(ip.bought_at, 1, 10) AS date, ip.id, ip.store_id, ip.brand_image, li.name AS item_name, ip.brand, ip.brand_detail,
            ip.price, ip.purchased_qty, s.name AS store_name, ip.bought_at
     FROM item_purchases ip
     JOIN list_items li ON li.id = ip.item_id
     LEFT JOIN stores s ON s.id = ip.store_id
     WHERE li.list_id = ?
     ORDER BY ip.bought_at DESC`,
    [listId]
  );
  const byDate = [];
  const indexByDate = {};
  rows.forEach((r) => {
    if (!(r.date in indexByDate)) {
      indexByDate[r.date] = byDate.length;
      byDate.push({ date: r.date, items: [] });
    }
    byDate[indexByDate[r.date]].items.push({
      purchaseId: r.id,
      storeId: r.store_id,
      image: r.brand_image,
      name: r.item_name,
      brand: r.brand,
      detail: r.brand_detail,
      price: r.price,
      qty: r.purchased_qty,
      storeName: r.store_name,
      boughtAt: r.bought_at,
    });
  });
  // price is always a single unit's price — quantity defaults to 1 when not
  // given — so each day's total is the sum of price × qty across its items.
  byDate.forEach((day) => {
    day.dateLabel = formatDateArabic(day.date);
    day.total = day.items.reduce((sum, it) => (it.price !== null ? sum + it.price * (it.qty !== null ? it.qty : 1) : sum), 0);
  });
  return byDate;
};

// Distinct item names the user has ever added across every list they can see
// (own + shared, any status — active or already bought), used to power the
// "اسم الغرض" autocomplete when adding a new item.
// One entry per distinct item name the person has ever added (own + shared
// lists), carrying the CATEGORY from the most recent instance of that name —
// so picking a known name from the autocomplete can fill in its category too,
// without an AI call (this is exact history, not a guess).
const loadKnownItemNames = async (userId) => {
  const rows = await all(
    `SELECT li.name, li.category
     FROM list_items li
     INNER JOIN (
       SELECT name, MAX(id) AS max_id
       FROM list_items
       WHERE list_id IN (
         SELECT id FROM lists WHERE owner_id = ?
         UNION
         SELECT list_id FROM list_shares WHERE user_id = ?
       )
       GROUP BY name
     ) latest ON latest.name = li.name AND latest.max_id = li.id
     ORDER BY li.name ASC`,
    [userId, userId]
  );
  return rows.map((r) => ({ name: r.name, category: r.category || '' }));
};

// People a list is shared with (shown in the owner's share modal).
const loadListShares = (listId) =>
  all(
    `SELECT u.id, u.name, u.email FROM list_shares s JOIN users u ON u.id = s.user_id WHERE s.list_id = ? ORDER BY u.name`,
    [listId]
  );

// Only same-site relative paths are honored as a post-action return target
// (blocks "//evil.com"-style open redirects); anything else gets `fallback`.
const localRedirectTarget = (target, fallback) =>
  typeof target === 'string' && /^\/(?![\/\\])/.test(target) ? target : fallback;

router.get('/', async (req, res) => {
  const itemCategories = await loadItemCategories();

  let pinnedList = null;
  let pinnedItems = null;
  let pinnedIsOwner = false;
  let pinnedIsShared = false;
  let pinnedShares = [];
  let pinnedHistory = [];
  if (req.user.default_list_id) {
    pinnedList = await get('SELECT * FROM lists WHERE id = ?', [req.user.default_list_id]);
    if (pinnedList) {
      pinnedIsOwner = pinnedList.owner_id === req.user.id;
      if (!pinnedIsOwner) {
        const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [pinnedList.id, req.user.id]);
        if (!share) pinnedList = null;
      }
    }
    if (pinnedList) {
      await syncDueWeeklyItems(pinnedList.id);
      pinnedItems = await loadItemsForList(pinnedList.id, { isOwner: pinnedIsOwner, cancelledSort: req.query.sort, categories: itemCategories, hiddenFilter: ['hide','only'].includes(req.query.hidden) ? req.query.hidden : 'all', storeFilter: req.query.store ? Number(req.query.store) : null, userId: req.user.id });
      // A list a person only sees through being shared with them is inherently
      // "shared"; for the owner, it's shared only if someone else was added.
      pinnedShares = pinnedIsOwner ? await loadListShares(pinnedList.id) : [];
      pinnedIsShared = pinnedIsOwner ? pinnedShares.length > 0 : true;
      pinnedHistory = await loadShoppingHistoryByDate(pinnedList.id);
    }
  }

  const stores = pinnedList ? await all('SELECT * FROM stores ORDER BY name ASC') : [];
  const availableLists = pinnedList ? await loadAvailableListsFor(req.user.id, pinnedList.id) : [];
  const knownItemNames = pinnedList ? await loadKnownItemNames(req.user.id) : [];

  res.render('dashboard', {
    pinnedList,
    pinnedItems,
    pinnedIsOwner,
    pinnedIsShared,
    pinnedShares,
    pinnedHistory,
    stores,
    availableLists,
    knownItemNames,
    weekdayNames: WEEKDAY_NAMES_AR,
    itemCategories,
    customCategoryIcons: CUSTOM_CATEGORY_ICONS,
    storeCategories: STORE_CATEGORIES,
    units: UNITS,
    cancelledSort: req.query.sort === 'category' ? 'category' : 'date',
    hiddenFilter: ['hide','only'].includes(req.query.hidden) ? req.query.hidden : 'all',
    storeFilter: req.query.store ? Number(req.query.store) : null,
  });
});

router.post('/lists', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/');
  const { lastID } = await run('INSERT INTO lists (owner_id, title) VALUES (?, ?)', [req.user.id, title]);
  res.redirect(`/lists/${lastID}`);
});

router.post('/lists/:id/pin', requireListAccess, async (req, res) => {
  await run('UPDATE users SET default_list_id = ? WHERE id = ?', [req.list.id, req.user.id]);
  res.redirect(req.body.from === 'home' ? '/' : `/lists/${req.list.id}`);
});

router.post('/lists/unpin', async (req, res) => {
  await run('UPDATE users SET default_list_id = NULL WHERE id = ?', [req.user.id]);
  res.redirect(req.body.from === 'home' ? '/' : '/');
});

router.get('/lists/:id', requireListAccess, async (req, res) => {
  await syncDueWeeklyItems(req.list.id);
  const itemCategories = await loadItemCategories();
  const { active, archived } = await loadItemsForList(req.list.id, { isOwner: req.isListOwner, cancelledSort: req.query.sort, categories: itemCategories, hiddenFilter: ['hide','only'].includes(req.query.hidden) ? req.query.hidden : 'all', storeFilter: req.query.store ? Number(req.query.store) : null, userId: req.user.id });
  const shares = req.isListOwner ? await loadListShares(req.list.id) : [];
  const stores = await all('SELECT * FROM stores ORDER BY name ASC');
  const availableLists = await loadAvailableListsFor(req.user.id, req.list.id);
  const knownItemNames = await loadKnownItemNames(req.user.id);
  const shoppingHistory = await loadShoppingHistoryByDate(req.list.id);

  // A list a person only sees through being shared with them is inherently
  // "shared"; for the owner, it's shared only once someone else was added.
  const isSharedList = req.isListOwner ? shares.length > 0 : true;

  res.render('list', {
    list: req.list,
    isOwner: req.isListOwner,
    isSharedList,
    activeItems: active,
    archivedItems: archived,
    shares,
    stores,
    availableLists,
    knownItemNames,
    shoppingHistory,
    weekdayNames: WEEKDAY_NAMES_AR,
    itemCategories,
    customCategoryIcons: CUSTOM_CATEGORY_ICONS,
    storeCategories: STORE_CATEGORIES,
    units: UNITS,
    isPinned: req.user.default_list_id === req.list.id,
    cancelledSort: req.query.sort === 'category' ? 'category' : 'date',
    hiddenFilter: ['hide','only'].includes(req.query.hidden) ? req.query.hidden : 'all',
    storeFilter: req.query.store ? Number(req.query.store) : null,
  });
});

router.post('/lists/:id/rename', requireListAccess, async (req, res) => {
  if (!req.isListOwner) return res.status(403).send('غير مصرح');
  const title = (req.body.title || '').trim();
  if (title) await run('UPDATE lists SET title = ? WHERE id = ?', [title, req.list.id]);
  res.redirect(`/lists/${req.list.id}`);
});

router.post('/lists/:id/delete', requireListAccess, async (req, res) => {
  if (!req.isListOwner) return res.status(403).send('غير مصرح');
  const itemIds = (await all('SELECT id FROM list_items WHERE list_id = ?', [req.list.id])).map((r) => r.id);
  for (const itemId of itemIds) {
    await run('DELETE FROM item_purchases WHERE item_id = ?', [itemId]);
  }
  await run('DELETE FROM list_items WHERE list_id = ?', [req.list.id]);
  await run('DELETE FROM list_shares WHERE list_id = ?', [req.list.id]);
  await run('UPDATE users SET default_list_id = NULL WHERE default_list_id = ?', [req.list.id]);
  await run('DELETE FROM lists WHERE id = ?', [req.list.id]);
  res.redirect('/');
});

router.post('/lists/:id/share', requireListAccess, async (req, res) => {
  if (!req.isListOwner) return res.status(403).send('غير مصرح');
  const email = (req.body.email || '').trim().toLowerCase();
  const target = await get('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (target && target.id !== req.list.owner_id) {
    await run('INSERT OR IGNORE INTO list_shares (list_id, user_id) VALUES (?, ?)', [req.list.id, target.id]);
  }
  res.redirect(localRedirectTarget(req.body.redirect_to, `/lists/${req.list.id}`));
});

router.post('/lists/:id/unshare', requireListAccess, async (req, res) => {
  if (!req.isListOwner) return res.status(403).send('غير مصرح');
  await run('DELETE FROM list_shares WHERE list_id = ? AND user_id = ?', [req.list.id, Number(req.body.user_id)]);
  res.redirect(localRedirectTarget(req.body.redirect_to, `/lists/${req.list.id}`));
});

// --- Items ---

// Multipart only when a specified-brand photo is attached (field "brand_image");
// otherwise a plain urlencoded form, which the multer step just passes through.
router.post('/lists/:id/items', requireListAccess, uploadBrandImage, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect(`/lists/${req.list.id}`);
  const quantity = (req.body.quantity || '').trim() || null;
  const unit = (req.body.unit || '').trim() || null;
  const category = (req.body.category || '').trim() || null;
  const isWeekly = req.body.is_weekly === 'on' ? 1 : 0;
  const weekday = isWeekly && req.body.weekly_weekday !== '' ? Number(req.body.weekly_weekday) : null;
  const plannedStoreId = req.body.planned_store_id ? Number(req.body.planned_store_id) : null;
  const details = (req.body.details || '').trim().slice(0, 120) || null;
  const planned = readPlannedBrand(req.body);
  // The photo only matters when a brand was actually specified.
  const plannedImage = planned.brand || planned.detail ? await saveBrandImage(req.file) : null;

  await run(
    'INSERT INTO list_items (list_id, name, quantity, unit, category, is_weekly, weekly_weekday, planned_store_id, details, planned_brand, planned_brand_detail, planned_brand_image, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.list.id, name, quantity, unit, category, isWeekly, weekday, plannedStoreId, details, planned.brand, planned.detail, plannedImage, req.user.id]
  );
  res.redirect(req.body.redirect_to || `/lists/${req.list.id}`);
});

// The "specified brand" fields shared by the add-item and edit-item forms.
function readPlannedBrand(body) {
  return {
    brand: (body.planned_brand || '').trim().slice(0, 80) || null,
    detail: (body.planned_brand_detail || '').trim().slice(0, 120) || null,
  };
}

const getItemWithAccess = async (req) => {
  const item = await get('SELECT * FROM list_items WHERE id = ?', [Number(req.params.itemId)]);
  if (!item) return null;
  const list = await get('SELECT * FROM lists WHERE id = ?', [item.list_id]);
  if (!list) return null;
  const isOwner = list.owner_id === req.user.id;
  if (!isOwner) {
    const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [list.id, req.user.id]);
    if (!share) return null;
  }
  return { item, list, isOwner };
};

const redirectBackTo = (req, res, fallbackListId) => {
  res.redirect(req.body.redirect_to || `/lists/${fallbackListId}`);
};

// Pre-fill helper: analyzes a just-picked brand photo and returns a guessed
// {brand, detail} for the buy form's fields before the purchase is actually
// submitted. Always responds 200 with nulls on any failure (no key set, API
// error, timeout, bad response) so the client can fall back to manual entry
// without special-casing errors.
router.post('/brand-image/analyze', uploadBrandImage, async (req, res) => {
  const result = await analyzeBrandImageWithAI(req.file);
  res.json(result);
});

router.post('/items/classify-category', async (req, res) => {
  const name = (req.body.name || '').trim();
  const categories = await loadItemCategories();
  const result = await classifyItemCategoryWithAI(name, categories);
  res.json(result);
});

// Photo in the "إضافة غرض" modal -> suggested item name + category (JSON).
// Reuses the brand-photo upload middleware (field "brand_image").
router.post('/items/analyze-image', uploadBrandImage, async (req, res) => {
  const categories = await loadItemCategories();
  res.json(await analyzeItemImageWithAI(req.file, categories));
});

// Manually add a custom item category. The key is an internal id, never
// shown — people only ever see/choose the label.
router.post('/categories', async (req, res) => {
  const label = (req.body.label || '').trim().slice(0, 60);
  const icon = CUSTOM_CATEGORY_ICONS.includes(req.body.icon) ? req.body.icon : 'package';
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : null;
  if (!label) return res.redirect(req.body.redirect_to || '/');
  const existingCount = (await get('SELECT COUNT(*) AS c FROM item_categories')).c;
  await run('INSERT INTO item_categories (key, label, icon, color, created_by, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM item_categories))', [
    generateCategoryKey(),
    label,
    icon,
    color || nextCategoryColor(existingCount),
    req.user.id,
  ]);
  res.redirect(req.body.redirect_to || '/');
});

router.post('/categories/:id/delete', async (req, res) => {
  const categoryId = Number(req.params.id);
  const category = await get('SELECT * FROM item_categories WHERE id = ?', [categoryId]);
  if (category) {
    await run('UPDATE list_items SET category = NULL WHERE category = ?', [category.key]);
    await run('DELETE FROM item_categories WHERE id = ?', [categoryId]);
  }
  res.redirect(req.body.redirect_to || '/');
});

router.post('/categories/:id/edit', async (req, res) => {
  const categoryId = Number(req.params.id);
  const label = (req.body.label || '').trim().slice(0, 60);
  const icon = CUSTOM_CATEGORY_ICONS.includes(req.body.icon) ? req.body.icon : 'package';
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : null;
  if (label && color) {
    await run('UPDATE item_categories SET label = ?, icon = ?, color = ? WHERE id = ?', [label, icon, color, categoryId]);
  }
  res.redirect(req.body.redirect_to || '/account');
});

// Drag-and-drop reorder from the account page: body { ids: [...] } is the
// full category list in its new order. Categories are shared by everyone,
// so this sets the order everywhere they're grouped (lists, archive drawer).
router.post('/categories/reorder', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  const existing = await all('SELECT id FROM item_categories');
  const known = new Set(existing.map((c) => c.id));
  // Only accept a complete permutation of the current categories, so a stale
  // page (a category added/deleted meanwhile) can't scramble the order.
  if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    return res.status(409).json({ ok: false });
  }
  await run('BEGIN');
  try {
    for (let i = 0; i < ids.length; i++) {
      await run('UPDATE item_categories SET sort_order = ? WHERE id = ?', [i + 1, ids[i]]);
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
  res.json({ ok: true });
});

// Same idea as the per-list suggestion below, but scanning every list this
// user owns or is shared on at once — meant for the settings page, where
// there's no single "current list" to scope it to.
router.post('/categories/suggest', async (req, res) => {
  const uncategorized = await all(
    `SELECT li.id, li.name FROM list_items li
     WHERE li.status = 'active' AND (li.category IS NULL OR li.category = '')
       AND li.list_id IN (
         SELECT id FROM lists WHERE owner_id = ?
         UNION
         SELECT list_id FROM list_shares WHERE user_id = ?
       )`,
    [req.user.id, req.user.id]
  );
  if (uncategorized.length === 0) return res.json({ suggestions: [] });
  const categories = await loadItemCategories();
  // AI matching works on names (it doesn't need to see ids), but duplicate
  // names across different lists must still resolve back to every matching
  // item id so applying a suggestion catches all of them, not just one.
  const uniqueNames = [...new Set(uncategorized.map((i) => i.name))];
  const suggestions = await suggestCategoriesWithAI(uniqueNames, categories);
  const idsByName = {};
  uncategorized.forEach((i) => {
    (idsByName[i.name] = idsByName[i.name] || []).push(i.id);
  });
  const withIds = suggestions.map((s) => ({
    ...s,
    itemIds: s.items.flatMap((name) => idsByName[name] || []),
  }));
  res.json({ suggestions: withIds });
});

// Creates the suggested category and assigns it to specific item ids —
// verified against this user's own accessible lists first, so a suggestion
// can never be used to tag an item in someone else's list.
router.post('/categories/apply-suggestion', async (req, res) => {
  const label = (req.body.label || '').trim().slice(0, 60);
  const icon = CUSTOM_CATEGORY_ICONS.includes(req.body.icon) ? req.body.icon : 'package';
  const itemIds = (Array.isArray(req.body.itemIds) ? req.body.itemIds : [req.body.itemIds])
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
  if (!label || itemIds.length === 0) return res.status(400).json({ error: 'بيانات ناقصة' });

  const placeholders = itemIds.map(() => '?').join(', ');
  const accessible = await all(
    `SELECT li.id FROM list_items li
     WHERE li.id IN (${placeholders}) AND li.status = 'active'
       AND li.list_id IN (
         SELECT id FROM lists WHERE owner_id = ?
         UNION
         SELECT list_id FROM list_shares WHERE user_id = ?
       )`,
    [...itemIds, req.user.id, req.user.id]
  );
  if (accessible.length === 0) return res.status(400).json({ error: 'لا توجد أغراض صالحة' });

  const existingCount = (await get('SELECT COUNT(*) AS c FROM item_categories')).c;
  const key = generateCategoryKey();
  await run('INSERT INTO item_categories (key, label, icon, color, created_by, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM item_categories))', [
    key,
    label,
    icon,
    nextCategoryColor(existingCount),
    req.user.id,
  ]);
  const accessiblePlaceholders = accessible.map(() => '?').join(', ');
  await run(`UPDATE list_items SET category = ? WHERE id IN (${accessiblePlaceholders})`, [
    key,
    ...accessible.map((i) => i.id),
  ]);
  res.json({ ok: true, key, label, icon });
});

// Looks at this list's currently-uncategorized active items and asks the AI
// for up to 3 new category suggestions. Read-only — nothing is created until
// the person picks one via /categories/apply-suggestion.
router.post('/lists/:id/categories/suggest', requireListAccess, async (req, res) => {
  const uncategorized = await all(
    "SELECT name FROM list_items WHERE list_id = ? AND status = 'active' AND (category IS NULL OR category = '')",
    [req.list.id]
  );
  if (uncategorized.length === 0) return res.json({ suggestions: [] });
  const categories = await loadItemCategories();
  const suggestions = await suggestCategoriesWithAI(uncategorized.map((i) => i.name), categories);
  res.json({ suggestions });
});

// Creates the suggested category and assigns it to the named items in one
// step, so accepting a suggestion is a single click from the review list.
router.post('/lists/:id/categories/apply-suggestion', requireListAccess, async (req, res) => {
  const label = (req.body.label || '').trim().slice(0, 60);
  const icon = CUSTOM_CATEGORY_ICONS.includes(req.body.icon) ? req.body.icon : 'package';
  const itemNames = Array.isArray(req.body.items) ? req.body.items : [req.body.items].filter(Boolean);
  if (!label || itemNames.length === 0) return res.status(400).json({ error: 'بيانات ناقصة' });

  const existingCount = (await get('SELECT COUNT(*) AS c FROM item_categories')).c;
  const key = generateCategoryKey();
  await run('INSERT INTO item_categories (key, label, icon, color, created_by, sort_order) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM item_categories))', [
    key,
    label,
    icon,
    nextCategoryColor(existingCount),
    req.user.id,
  ]);
  const placeholders = itemNames.map(() => '?').join(', ');
  await run(
    `UPDATE list_items SET category = ? WHERE list_id = ? AND status = 'active' AND name IN (${placeholders})`,
    [key, req.list.id, ...itemNames]
  );
  res.json({ ok: true, key, label, icon });
});

router.post('/items/:itemId/buy', uploadBrandImage, async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  const { item } = ctx;

  const storeId = req.body.store_id ? Number(req.body.store_id) : null;
  // brand_select is a flag ("__custom__" from the brand modal, whether opened
  // blank or pre-filled from a past brand; empty from a plain buy) — the
  // brand name actually saved always comes from brand_custom. A past purchase
  // that only ever had a detail/size noted, with no separate brand name,
  // still works as a reusable "profile".
  const brand = (req.body.brand_select || '').trim() ? (req.body.brand_custom || '').trim() || null : null;
  const brandDetail = (req.body.brand_detail || '').trim() || null;
  // No new photo picked? Fall back to whichever existing thumbnail the client
  // carried over from selecting a past brand.
  const brandImage = (await saveBrandImage(req.file)) || validExistingBrandImage(req.body.existing_brand_image);
  const priceRaw = (req.body.price || '').trim();
  // Rounded to 3 decimals server-side too, since the AJAX item-action handler
  // submits via fetch and bypasses the input's native step-based validation.
  const price = priceRaw !== '' && Number.isFinite(Number(priceRaw)) ? Math.round(Number(priceRaw) * 1000) / 1000 : null;
  const qtyRaw = (req.body.purchased_qty || '').trim();
  const purchasedQty = qtyRaw !== '' && Number.isFinite(Number(qtyRaw)) && Number(qtyRaw) > 0 ? Number(qtyRaw) : null;

  await run(
    'INSERT INTO item_purchases (item_id, store_id, brand, brand_detail, brand_image, price, purchased_qty, bought_by, bought_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [item.id, storeId, brand, brandDetail, brandImage, price, purchasedQty, req.user.id, nowOmanString()]
  );

  if (item.is_weekly && item.weekly_weekday !== null) {
    const nextDue = nextWeekdayAfter(item.weekly_weekday);
    await run("UPDATE list_items SET status = 'bought', next_due_date = ? WHERE id = ?", [nextDue, item.id]);
  } else {
    await run("UPDATE list_items SET status = 'bought' WHERE id = ?", [item.id]);
  }

  redirectBackTo(req, res, item.list_id);
});

// Undo a purchase just made (offered as a short-lived "تراجع" toast on the
// client, auto-dismissed after a few seconds): removes the purchase record
// that was just created and puts the item back to active. Always targets the
// single most recent purchase for this item, which is correct for the
// "undo my last action" use case this exists for.
router.post('/items/:itemId/undo-buy', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  const latest = await get('SELECT id FROM item_purchases WHERE item_id = ? ORDER BY id DESC LIMIT 1', [ctx.item.id]);
  if (latest) await run('DELETE FROM item_purchases WHERE id = ?', [latest.id]);
  await run("UPDATE list_items SET status = 'active' WHERE id = ?", [ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/cancel', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  await run("UPDATE list_items SET status = 'cancelled' WHERE id = ?", [ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/reopen', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  await run("UPDATE list_items SET status = 'active' WHERE id = ?", [ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

// "تراجع" on an archive-drawer row marked "في القائمة": takes the item back
// off the active list. The client sends the status the row had right before
// it was restored (prev_status); without one (e.g. the page was refreshed
// since), it falls back to "bought" if the item was ever bought, otherwise
// "cancelled".
router.post('/items/:itemId/unrestore', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  if (ctx.item.status === 'active') {
    let status = ['bought', 'cancelled'].includes(req.body.prev_status) ? req.body.prev_status : null;
    if (!status) {
      const bought = await get('SELECT 1 FROM item_purchases WHERE item_id = ? LIMIT 1', [ctx.item.id]);
      status = bought ? 'bought' : 'cancelled';
    }
    await run('UPDATE list_items SET status = ? WHERE id = ?', [status, ctx.item.id]);
  }
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/toggle-hidden', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  if (!ctx.isOwner) return res.status(403).send('غير مصرح');
  await run('UPDATE list_items SET hidden_from_shared = CASE WHEN hidden_from_shared = 1 THEN 0 ELSE 1 END WHERE id = ?', [ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/move', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');

  const targetListId = Number(req.body.target_list_id);
  const targetList = await get('SELECT * FROM lists WHERE id = ?', [targetListId]);
  if (!targetList) return res.status(404).send('القائمة الهدف غير موجودة');
  const targetIsOwner = targetList.owner_id === req.user.id;
  if (!targetIsOwner) {
    const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [targetListId, req.user.id]);
    if (!share) return res.status(403).send('غير مصرح بالنقل لهذه القائمة');
  }

  await run('UPDATE list_items SET list_id = ? WHERE id = ?', [targetListId, ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/copy', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');

  const targetListId = Number(req.body.target_list_id);
  const targetList = await get('SELECT * FROM lists WHERE id = ?', [targetListId]);
  if (!targetList) return res.status(404).send('القائمة الهدف غير موجودة');
  const targetIsOwner = targetList.owner_id === req.user.id;
  if (!targetIsOwner) {
    const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [targetListId, req.user.id]);
    if (!share) return res.status(403).send('غير مصرح بالنسخ لهذه القائمة');
  }

  // A fresh copy: same descriptive fields, but starts as a brand new active
  // item in the target list — the original (and its purchase history) stays
  // exactly where it was, untouched.
  const { item } = ctx;
  await run(
    'INSERT INTO list_items (list_id, name, quantity, unit, category, is_weekly, weekly_weekday, planned_store_id, details, planned_brand, planned_brand_detail, planned_brand_image, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [targetListId, item.name, item.quantity, item.unit, item.category, item.is_weekly, item.weekly_weekday, item.planned_store_id, item.details, item.planned_brand, item.planned_brand_detail, item.planned_brand_image, req.user.id]
  );
  redirectBackTo(req, res, ctx.item.list_id);
});

// Multipart when a new specified-brand photo is attached (see the add route).
router.post('/items/:itemId/edit', uploadBrandImage, async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');

  const name = (req.body.name || '').trim();
  if (!name) return redirectBackTo(req, res, ctx.item.list_id);
  const quantity = (req.body.quantity || '').trim() || null;
  const unit = (req.body.unit || '').trim() || null;
  const category = (req.body.category || '').trim() || null;
  const isWeekly = req.body.is_weekly === 'on' ? 1 : 0;
  const weekday = isWeekly && req.body.weekly_weekday !== '' ? Number(req.body.weekly_weekday) : null;
  const plannedStoreId = req.body.planned_store_id ? Number(req.body.planned_store_id) : null;
  const details = (req.body.details || '').trim().slice(0, 120) || null;
  // Specified brand: a new photo replaces the old one, "remove" clears it,
  // otherwise it's kept; clearing both name and specs drops the whole brand.
  const planned = readPlannedBrand(req.body);
  let plannedImage = null;
  if (planned.brand || planned.detail) {
    plannedImage = (await saveBrandImage(req.file)) || (req.body.remove_planned_brand_image ? null : ctx.item.planned_brand_image);
  }

  await run(
    'UPDATE list_items SET name = ?, quantity = ?, unit = ?, category = ?, is_weekly = ?, weekly_weekday = ?, planned_store_id = ?, details = ?, planned_brand = ?, planned_brand_detail = ?, planned_brand_image = ? WHERE id = ?',
    [name, quantity, unit, category, isWeekly, weekday, plannedStoreId, details, planned.brand, planned.detail, plannedImage, ctx.item.id]
  );
  redirectBackTo(req, res, ctx.item.list_id);
});

// Set / change / clear just the specified brand of an item (the 🏷 popup on
// an active item), leaving its other fields alone. Photo: a new upload, or a
// past brand's photo picked from the popup's chips (validated), or else the
// current one unless removed. clear=1 (or empty name + specs) drops it.
router.post('/items/:itemId/planned-brand', uploadBrandImage, async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  const planned = req.body.clear ? { brand: null, detail: null } : readPlannedBrand(req.body);
  let image = null;
  if (planned.brand || planned.detail) {
    image =
      (await saveBrandImage(req.file)) ||
      validExistingBrandImage(req.body.existing_brand_image) ||
      (req.body.remove_planned_brand_image ? null : ctx.item.planned_brand_image);
  }
  await run('UPDATE list_items SET planned_brand = ?, planned_brand_detail = ?, planned_brand_image = ? WHERE id = ?', [
    planned.brand,
    planned.detail,
    image,
    ctx.item.id,
  ]);
  redirectBackTo(req, res, ctx.item.list_id);
});

router.post('/items/:itemId/delete', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  await run('DELETE FROM item_purchases WHERE item_id = ?', [ctx.item.id]);
  await run('DELETE FROM list_items WHERE id = ?', [ctx.item.id]);
  redirectBackTo(req, res, ctx.item.list_id);
});

// Price comparison for the item history page: purchases of the exact same
// product — same brand AND same details; only the price may differ — grouped
// together, then compared across stores and over time. Text is normalized
// (spacing, أ/إ/آ→ا, ة→ه, ى→ي, case) so trivial typing differences don't
// split a product in two. Purchases without a price or without any brand
// info can't be compared and are skipped.
const normalizeProductText = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();

const buildPriceComparison = (purchases) => {
  const groups = new Map();
  const chronological = purchases
    .filter((p) => p.price !== null && (p.brand || p.brand_detail))
    .sort((a, b) => String(a.bought_at).localeCompare(String(b.bought_at)) || a.id - b.id);
  chronological.forEach((p) => {
    const key = normalizeProductText(p.brand) + '|' + normalizeProductText(p.brand_detail);
    if (!groups.has(key)) groups.set(key, { brand: p.brand, detail: p.brand_detail, purchases: [] });
    const g = groups.get(key);
    // Show the most recent spelling as the group's label.
    g.brand = p.brand;
    g.detail = p.brand_detail;
    g.purchases.push(p);
  });

  return [...groups.values()]
    .map((g) => {
      const byStore = new Map();
      g.purchases.forEach((p) => {
        const storeKey = p.store_id || 0;
        const s = byStore.get(storeKey) || { storeName: p.store_name || 'بدون محل', count: 0, minPrice: Infinity };
        s.count++;
        s.minPrice = Math.min(s.minPrice, p.price);
        s.lastPrice = p.price; // chronological, so the last one wins
        s.lastDate = String(p.bought_at).slice(0, 10);
        byStore.set(storeKey, s);
      });
      const stores = [...byStore.values()].sort((a, b) => a.lastPrice - b.lastPrice);
      // "Cheapest" only means something when there's more than one store.
      if (stores.length > 1 && stores[0].lastPrice < stores[stores.length - 1].lastPrice) stores[0].cheapest = true;

      let prev = null;
      const timeline = g.purchases.map((p) => {
        const entry = { date: String(p.bought_at).slice(0, 10), storeName: p.store_name || 'بدون محل', price: p.price };
        if (prev !== null && prev > 0) entry.changePct = Math.round(((p.price - prev) / prev) * 100);
        prev = p.price;
        return entry;
      });
      return { brand: g.brand, detail: g.detail, stores, timeline, lastAt: g.purchases[g.purchases.length - 1].bought_at };
    })
    // Most recently bought product first.
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
};

router.get('/items/:itemId/history', async (req, res) => {
  const ctx = await getItemWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  // Newest first by default; ?order=asc flips it (the cheapest purchase is
  // still highlighted in the view, whatever the order).
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  const purchases = await all(
    `SELECT p.*, s.name AS store_name, u.name AS buyer_name
     FROM item_purchases p
     LEFT JOIN stores s ON s.id = p.store_id
     LEFT JOIN users u ON u.id = p.bought_by
     WHERE p.item_id = ?
     ORDER BY p.bought_at ${order === 'asc' ? 'ASC' : 'DESC'}, p.id ${order === 'asc' ? 'ASC' : 'DESC'}`,
    [ctx.item.id]
  );
  const stores = await all('SELECT * FROM stores ORDER BY name ASC');
  const comparison = buildPriceComparison(purchases);
  res.render('item-history', { item: ctx.item, list: ctx.list, purchases, stores, order, comparison });
});

// Looks up a purchase plus its item, only if the current user owns or is
// shared on that item's list (same rule as getItemWithAccess).
const getPurchaseWithAccess = async (req) => {
  const purchase = await get('SELECT * FROM item_purchases WHERE id = ?', [Number(req.params.purchaseId)]);
  if (!purchase) return null;
  const item = await get('SELECT * FROM list_items WHERE id = ?', [purchase.item_id]);
  if (!item) return null;
  const list = await get('SELECT * FROM lists WHERE id = ?', [item.list_id]);
  if (!list) return null;
  if (list.owner_id !== req.user.id) {
    const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [list.id, req.user.id]);
    if (!share) return null;
  }
  return { purchase, item };
};

// Purchases can be edited from an item's history page or a list's history
// modal (list page or home page); falls back to the item's history page.
const purchaseRedirect = (req, res, item) => {
  res.redirect(localRedirectTarget(req.body.redirect_to, `/items/${item.id}/history`));
};

// A purchase record entered with a mistake (wrong price, store, brand name,
// detail, date, photo) can be corrected after the fact — previously the only
// option was "undo", which only ever targets the single most recent purchase.
router.post('/purchases/:purchaseId/edit', uploadBrandImage, async (req, res) => {
  const ctx = await getPurchaseWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  const { purchase, item } = ctx;

  const storeId = req.body.store_id ? Number(req.body.store_id) : null;
  const brand = (req.body.brand || '').trim() || null;
  const brandDetail = (req.body.brand_detail || '').trim() || null;
  const priceRaw = (req.body.price || '').trim();
  const price = priceRaw !== '' && Number.isFinite(Number(priceRaw)) ? Math.round(Number(priceRaw) * 1000) / 1000 : null;
  const qtyRaw = (req.body.purchased_qty || '').trim();
  const purchasedQty = qtyRaw !== '' && Number.isFinite(Number(qtyRaw)) && Number(qtyRaw) > 0 ? Number(qtyRaw) : null;

  // Date/time are optional overrides: anything missing or malformed keeps
  // the corresponding part of the original timestamp.
  const original = String(purchase.bought_at || nowOmanString());
  const dateRaw = (req.body.bought_date || '').trim();
  const timeRaw = (req.body.bought_time || '').trim();
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : original.slice(0, 10);
  const timePart = /^\d{2}:\d{2}$/.test(timeRaw) ? `${timeRaw}:00` : original.slice(11, 19) || '00:00:00';
  const boughtAt = `${datePart} ${timePart}`;

  // A new photo replaces the old one; otherwise it's kept unless explicitly
  // removed. Old files aren't deleted since other purchases may share them.
  let brandImage = await saveBrandImage(req.file);
  if (!brandImage) brandImage = req.body.remove_brand_image ? null : purchase.brand_image;

  await run(
    'UPDATE item_purchases SET store_id = ?, brand = ?, brand_detail = ?, brand_image = ?, price = ?, purchased_qty = ?, bought_at = ? WHERE id = ?',
    [storeId, brand, brandDetail, brandImage, price, purchasedQty, boughtAt, purchase.id]
  );
  purchaseRedirect(req, res, item);
});

// Removes a single (e.g. duplicate or mistaken) purchase record from history.
router.post('/purchases/:purchaseId/delete', async (req, res) => {
  const ctx = await getPurchaseWithAccess(req);
  if (!ctx) return res.status(404).send('غير موجود');
  await run('DELETE FROM item_purchases WHERE id = ?', [ctx.purchase.id]);
  purchaseRedirect(req, res, ctx.item);
});

module.exports = router;
