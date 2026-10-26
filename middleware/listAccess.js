const { get } = require('../db');

// Loads the list for :id, verifies the current user is the owner or a shared
// member, and attaches `req.list` + `req.isListOwner`. 404s otherwise so a
// user can't tell the difference between "doesn't exist" and "not yours".
const requireListAccess = async (req, res, next) => {
  const listId = Number(req.params.id);
  if (!Number.isInteger(listId)) return res.status(404).send('غير موجود');

  const list = await get('SELECT * FROM lists WHERE id = ?', [listId]);
  if (!list) return res.status(404).send('القائمة غير موجودة');

  if (list.owner_id === req.user.id) {
    req.list = list;
    req.isListOwner = true;
    return next();
  }

  const share = await get('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?', [listId, req.user.id]);
  if (!share) return res.status(404).send('القائمة غير موجودة');

  req.list = list;
  req.isListOwner = false;
  next();
};

module.exports = { requireListAccess };
