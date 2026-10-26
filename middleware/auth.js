const { get } = require('../db');

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

const requireAuth = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!req.user.is_admin) return res.status(403).send('غير مصرح لك بالدخول لهذه الصفحة');
  next();
};

module.exports = { attachUser, requireAuth, requireAdmin };
