const express = require('express');
const { run, all, get } = require('../db');

const router = express.Router();

router.get('/admin/users', async (req, res) => {
  const users = await all('SELECT id, name, email, is_admin, is_suspended, created_at FROM users ORDER BY created_at ASC');
  res.render('admin-users', { users });
});

router.post('/admin/users/:id/suspend', async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).send('لا يمكنك إيقاف نفسك');
  await run('UPDATE users SET is_suspended = 1 WHERE id = ?', [targetId]);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/activate', async (req, res) => {
  await run('UPDATE users SET is_suspended = 0 WHERE id = ?', [Number(req.params.id)]);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/delete', async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).send('لا يمكنك حذف نفسك');

  const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
  if (!target) return res.redirect('/admin/users');

  // Cascade: fully delete lists this user OWNS (their items + purchase history).
  // For everything else they merely touched on OTHER people's lists (items they
  // added, purchases they logged, stores they created), keep the shared data and
  // just anonymize the reference, since the household still relies on it.
  const ownedLists = await all('SELECT id FROM lists WHERE owner_id = ?', [targetId]);
  for (const l of ownedLists) {
    const itemIds = (await all('SELECT id FROM list_items WHERE list_id = ?', [l.id])).map((r) => r.id);
    for (const itemId of itemIds) {
      await run('DELETE FROM item_purchases WHERE item_id = ?', [itemId]);
    }
    await run('DELETE FROM list_items WHERE list_id = ?', [l.id]);
    await run('DELETE FROM list_shares WHERE list_id = ?', [l.id]);
    await run('DELETE FROM lists WHERE id = ?', [l.id]);
  }
  await run('DELETE FROM list_shares WHERE user_id = ?', [targetId]);
  await run('UPDATE item_purchases SET bought_by = NULL WHERE bought_by = ?', [targetId]);
  await run('UPDATE list_items SET added_by = NULL WHERE added_by = ?', [targetId]);
  await run('UPDATE stores SET created_by = NULL WHERE created_by = ?', [targetId]);
  await run('DELETE FROM users WHERE id = ?', [targetId]);

  res.redirect('/admin/users');
});

module.exports = router;
