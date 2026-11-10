const { get, all } = require('../db');

const attachUser = async (req, res, next) => {
  req.user = null;
  if (req.session && req.session.userId) {
    const user = await get('SELECT id, name, email, is_admin, is_suspended, default_list_id FROM users WHERE id = ?', [req.session.userId]);
    if (user && !user.is_suspended) {
      req.user = user;
    } else {
      // Account deleted or suspended since the session was created.
      req.session.destroy(() => {});
    }
  }
  res.locals.user = req.user;
  next();
};

// The side drawer (partials/nav) lists the person's own and shared lists on
// every page, not just the home page — so load them for any signed-in GET
// (page renders, plus the AJAX refreshes that re-fetch whole pages).
const attachNavLists = async (req, res, next) => {
  if (!req.user || req.method !== 'GET') return next();
  res.locals.navOwnedLists = await all('SELECT * FROM lists WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.locals.navSharedLists = await all(
    `SELECT l.*, u.name AS owner_name
     FROM lists l
     JOIN list_shares s ON s.list_id = l.id
     JOIN users u ON u.id = l.owner_id
     WHERE s.user_id = ?
     ORDER BY l.created_at DESC`,
    [req.user.id]
  );
  // Fed into theme-init.ejs (included on every page) so the nearby-task
  // check runs app-wide on open/resume, not just on a dedicated tasks page.
  // A task's location is its store's — stores without a saved lat/lng
  // (name-only) just never trigger a nearby check, same as they don't for
  // the shopping store-locator.
  res.locals.activeTasksForLocationCheck = await all(
    `SELECT t.id, t.title, s.lat, s.lng
     FROM tasks t
     JOIN stores s ON s.id = t.store_id
     WHERE t.owner_id = ? AND t.is_done = 0 AND s.lat IS NOT NULL AND s.lng IS NOT NULL`,
    [req.user.id]
  );
  next();
};

const requireAuth = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!req.user.is_admin) return res.status(403).send('غير مصرح لك بالدخول لهذه الصفحة');
  next();
};

module.exports = { attachUser, attachNavLists, requireAuth, requireAdmin };
