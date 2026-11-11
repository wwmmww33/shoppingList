const express = require('express');
const { run, all, get } = require('../db');

const router = express.Router();

router.get('/tasks', async (req, res) => {
  const stores = await all('SELECT * FROM stores ORDER BY name ASC');
  const tasks = await all(
    `SELECT t.*, s.name AS store_name, s.lat AS store_lat, s.lng AS store_lng
     FROM tasks t
     JOIN stores s ON s.id = t.store_id
     WHERE t.owner_id = ?
     ORDER BY s.name ASC, t.created_at DESC`,
    [req.user.id]
  );
  res.render('tasks', { stores, tasks });
});

// A task always targets a location first: either an existing one (store_id,
// shared with the shopping store list) or a brand new one, picked the same
// way as a shopping store (current position or a map pin) and saved
// straight into `stores` — tasks live at the same places shopping already
// knows about, or anywhere else pinned here.
router.post('/tasks', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/tasks');

  let storeId = req.body.store_id ? Number(req.body.store_id) : null;
  if (storeId) {
    const store = await get('SELECT id FROM stores WHERE id = ?', [storeId]);
    if (!store) return res.redirect('/tasks');
  } else {
    const newName = (req.body.new_store_name || '').trim();
    const lat = req.body.lat ? Number(req.body.lat) : null;
    const lng = req.body.lng ? Number(req.body.lng) : null;
    if (!newName || lat === null || lng === null) return res.redirect('/tasks');
    const { lastID } = await run('INSERT INTO stores (name, lat, lng, created_by) VALUES (?, ?, ?, ?)', [newName, lat, lng, req.user.id]);
    storeId = lastID;
  }

  await run('INSERT INTO tasks (owner_id, store_id, title) VALUES (?, ?, ?)', [req.user.id, storeId, title]);
  res.redirect('/tasks');
});

router.post('/tasks/:id/move', async (req, res) => {
  const task = await get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  const storeId = req.body.store_id ? Number(req.body.store_id) : null;
  if (task && task.owner_id === req.user.id && storeId) {
    const store = await get('SELECT id FROM stores WHERE id = ?', [storeId]);
    if (store) await run('UPDATE tasks SET store_id = ? WHERE id = ?', [storeId, task.id]);
  }
  res.redirect('/tasks');
});

// Also reachable via a plain fetch (no body) from the nearby-tasks panel
// that can pop up on any page, not just /tasks — so this always redirects
// back to /tasks rather than trusting a redirect_to from that caller.
router.post('/tasks/:id/done', async (req, res) => {
  const task = await get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  if (task && task.owner_id === req.user.id) {
    await run("UPDATE tasks SET is_done = 1, done_at = datetime('now') WHERE id = ?", [task.id]);
  }
  res.redirect('/tasks');
});

router.post('/tasks/:id/undone', async (req, res) => {
  const task = await get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  if (task && task.owner_id === req.user.id) {
    await run('UPDATE tasks SET is_done = 0, done_at = NULL WHERE id = ?', [task.id]);
  }
  res.redirect('/tasks');
});

router.post('/tasks/:id/delete', async (req, res) => {
  const task = await get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  if (task && task.owner_id === req.user.id) {
    await run('DELETE FROM tasks WHERE id = ?', [task.id]);
  }
  res.redirect('/tasks');
});

module.exports = router;
