const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { BUILTIN_ITEM_CATEGORIES } = require('./utils/categories');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbPath);
db.run('PRAGMA foreign_keys = ON');

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

const init = async () => {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_suspended INTEGER NOT NULL DEFAULT 0,
    default_list_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL,
    lng REAL,
    category TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS list_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(list_id, user_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES lists(id),
    name TEXT NOT NULL,
    quantity TEXT,
    category TEXT,
    is_weekly INTEGER NOT NULL DEFAULT 0,
    weekly_weekday INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    next_due_date TEXT,
    hidden_from_shared INTEGER NOT NULL DEFAULT 0,
    added_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Lightweight, idempotent migrations for columns added after the initial release
  // (safe to re-run: sqlite3 errors on a duplicate column, which we simply ignore).
  const safeAlter = async (sql) => {
    try {
      await run(sql);
    } catch (err) {
      // ignore "duplicate column" errors from re-running on an already-migrated DB
    }
  };
  await safeAlter('ALTER TABLE users ADD COLUMN default_list_id INTEGER');
  await safeAlter('ALTER TABLE stores ADD COLUMN category TEXT');
  await safeAlter('ALTER TABLE list_items ADD COLUMN category TEXT');
  await safeAlter('ALTER TABLE list_items ADD COLUMN hidden_from_shared INTEGER NOT NULL DEFAULT 0');
  await safeAlter('ALTER TABLE list_items ADD COLUMN unit TEXT');
  await safeAlter('ALTER TABLE list_items ADD COLUMN planned_store_id INTEGER REFERENCES stores(id)');
  // Free-text note on the item itself ("قليل الدسم", "الحجم الكبير"...).
  await safeAlter('ALTER TABLE list_items ADD COLUMN details TEXT');
  // A brand chosen for the item up front (before buying): name, its specs and
  // an optional photo. Offered first in the buy panel; buying it records an
  // ordinary purchase, so it then shows up in history/price comparison and
  // the past-brand buttons like any other brand.
  await safeAlter('ALTER TABLE list_items ADD COLUMN planned_brand TEXT');
  await safeAlter('ALTER TABLE list_items ADD COLUMN planned_brand_detail TEXT');
  await safeAlter('ALTER TABLE list_items ADD COLUMN planned_brand_image TEXT');

  await run(`CREATE TABLE IF NOT EXISTS item_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES list_items(id),
    store_id INTEGER REFERENCES stores(id),
    brand TEXT,
    price REAL,
    bought_by INTEGER REFERENCES users(id),
    bought_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await safeAlter('ALTER TABLE item_purchases ADD COLUMN brand_detail TEXT');
  await safeAlter('ALTER TABLE item_purchases ADD COLUMN brand_image TEXT');
  await safeAlter('ALTER TABLE item_purchases ADD COLUMN purchased_qty REAL');

  // One-time backfill: purchases recorded before the brand-matching fix often
  // had the actual brand name typed into "detail" only, leaving "brand"
  // empty — which made them invisible as reusable past-brand profiles. This
  // copies detail into brand wherever brand is still empty; idempotent since
  // a row only ever matches this WHERE once (brand is non-empty after), and
  // the detail field itself is left untouched so nothing is lost — anyone
  // can still edit the brand name down to just the product name via the
  // purchase-history edit button.
  await run(
    "UPDATE item_purchases SET brand = brand_detail WHERE (brand IS NULL OR brand = '') AND brand_detail IS NOT NULL AND brand_detail != ''"
  );

  // Item categories used to be a fixed in-code list; they now live here so
  // people can add their own (manually or via an AI suggestion) alongside
  // the built-in set, which is seeded once on first run.
  await run(`CREATE TABLE IF NOT EXISTS item_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const categoryCount = await get('SELECT COUNT(*) AS c FROM item_categories');
  if (categoryCount.c === 0) {
    for (const cat of BUILTIN_ITEM_CATEGORIES) {
      await run('INSERT INTO item_categories (key, label, icon, color) VALUES (?, ?, ?, ?)', [cat.key, cat.label, cat.icon, cat.color]);
    }
  }
  // Display order of categories (drag-and-drop on the account page). Rows
  // from before this column existed keep their old order (by id).
  await safeAlter('ALTER TABLE item_categories ADD COLUMN sort_order INTEGER');
  await run('UPDATE item_categories SET sort_order = id WHERE sort_order IS NULL');

  // One-time icon/color for custom categories created back when no fitting
  // icon was offered (they all got the default "package" in the same green).
  // Only touches a category still on that default, so a hand-picked icon is
  // never overwritten; a no-op once applied or on a DB without them.
  const CUSTOM_CATEGORY_ICON_FIXES = [
    { label: 'منتجات العناية بالسيارة', icon: 'car', color: '#3949ab' },
    { label: 'مواد بناء وتشييد', icon: 'hammer', color: '#f4511e' },
    { label: 'منتجات زراعية', icon: 'sprout', color: '#7cb342' },
    { label: 'مستلزمات شخصية', icon: 'shirt', color: '#8e24aa' },
  ];
  for (const fix of CUSTOM_CATEGORY_ICON_FIXES) {
    await run("UPDATE item_categories SET icon = ?, color = ? WHERE label = ? AND icon = 'package'", [fix.icon, fix.color, fix.label]);
  }
};

module.exports = { db, run, get, all, init };
