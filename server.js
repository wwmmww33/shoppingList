require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

const { init } = require('./db');
const { attachUser, requireAuth, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const listsRoutes = require('./routes/lists');
const storesRoutes = require('./routes/stores');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new FileStore({ path: path.join(__dirname, 'sessions'), logFn: () => {} }),
    secret: process.env.SESSION_SECRET || 'dukan-list-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 90 * 24 * 60 * 60 * 1000 }, // 90 days
  })
);

app.use(attachUser);

app.use('/', authRoutes);
app.use('/', requireAuth, listsRoutes);
app.use('/', requireAuth, storesRoutes);
app.use('/', requireAuth, requireAdmin, adminRoutes);

app.use((req, res) => res.status(404).send('الصفحة غير موجودة'));

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`dukan-list server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
