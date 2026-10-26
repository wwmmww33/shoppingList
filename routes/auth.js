const express = require('express');
const bcrypt = require('bcryptjs');
const { run, get, all } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { CUSTOM_CATEGORY_ICONS } = require('../utils/categories');

const router = express.Router();

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

router.get('/account', requireAuth, async (req, res) => {
  const itemCategories = await all('SELECT * FROM item_categories ORDER BY id ASC');
  res.render('account', { error: null, success: null, itemCategories, customCategoryIcons: CUSTOM_CATEGORY_ICONS });
});

router.post('/account/password', requireAuth, async (req, res) => {
  const currentPassword = req.body.current_password || '';
  const newPassword = req.body.new_password || '';
  const confirmPassword = req.body.confirm_password || '';

  const renderAccount = async (error, success) => {
    const itemCategories = await all('SELECT * FROM item_categories ORDER BY id ASC');
    res.render('account', { error, success, itemCategories, customCategoryIcons: CUSTOM_CATEGORY_ICONS });
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

module.exports = router;
