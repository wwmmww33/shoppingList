const express = require('express');
const { run, all, get } = require('../db');

const router = express.Router();

router.get('/tasks', async (req, res) => {
  const tasks = await all('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.render('tasks', { tasks });
});

router.post('/tasks', async (req, res) => {
  const title = (req.body.title || '').trim();
  const lat = req.body.lat ? Number(req.body.lat) : null;
  const lng = req.body.lng ? Number(req.body.lng) : null;
  if (!title || lat === null || lng === null) return res.redirect('/tasks');
  const placeName = (req.body.place_name || '').trim() || null;
  await run('INSERT INTO tasks (owner_id, title, place_name, lat, lng) VALUES (?, ?, ?, ?, ?)', [req.user.id, title, placeName, lat, lng]);
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
