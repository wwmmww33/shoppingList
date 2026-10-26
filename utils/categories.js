// Seed data for the item_categories DB table (see db.js) — only read once,
// to populate the table the first time the app runs against a fresh database.
// After that, item categories are fully DB-driven so people can add their own.
const BUILTIN_ITEM_CATEGORIES = [
  { key: 'produce', label: 'خضروات وفواكه', icon: 'carrot', color: '#43a047' },
  { key: 'meat', label: 'لحوم ودواجن وأسماك', icon: 'drumstick', color: '#e53935' },
  { key: 'dairy', label: 'ألبان وأجبان وبيض', icon: 'egg', color: '#fbc02d' },
  { key: 'bakery', label: 'مخبوزات وخبز', icon: 'croissant', color: '#8d6e63' },
  { key: 'pantry', label: 'بقالة وأساسيات', icon: 'shopping-basket', color: '#fb8c00' },
  { key: 'beverages', label: 'مشروبات', icon: 'cup-soda', color: '#039be5' },
  { key: 'snacks', label: 'وجبات خفيفة وحلويات', icon: 'cookie', color: '#ec407a' },
  { key: 'frozen', label: 'مجمدات', icon: 'snowflake', color: '#00acc1' },
  { key: 'cleaning', label: 'منتجات تنظيف المنزل', icon: 'spray-can', color: '#26a69a' },
  { key: 'personal_care', label: 'العناية الشخصية', icon: 'droplet', color: '#ab47bc' },
  { key: 'baby', label: 'منتجات الأطفال', icon: 'baby', color: '#5c6bc0' },
  { key: 'household', label: 'أدوات منزلية ومطبخ', icon: 'cooking-pot', color: '#78909c' },
  { key: 'other', label: 'أخرى', icon: 'package', color: '#9e9e9e' },
];

const STORE_CATEGORIES = [
  { key: 'supermarket', label: 'سوبرماركت / بقالة عامة', icon: 'shopping-cart' },
  { key: 'produce', label: 'خضار وفواكه', icon: 'carrot' },
  { key: 'meat', label: 'لحوم ودواجن وأسماك', icon: 'drumstick' },
  { key: 'bakery', label: 'مخبز وحلويات', icon: 'croissant' },
  { key: 'pharmacy', label: 'صيدلية', icon: 'pill' },
  { key: 'household', label: 'مستلزمات منزلية وأدوات كهربائية', icon: 'house' },
  { key: 'clothing', label: 'ملابس وأزياء', icon: 'shirt' },
  { key: 'beauty', label: 'مستحضرات تجميل وعناية شخصية', icon: 'sparkles' },
  { key: 'stationery', label: 'مكتبة وأدوات مكتبية', icon: 'book-open' },
  { key: 'other', label: 'أخرى', icon: 'map-pin' },
];

const storeCategoryMap = Object.fromEntries(STORE_CATEGORIES.map((c) => [c.key, c]));

// Icons offered when someone creates a custom item category — a curated subset
// of Lucide icons (the library already loaded via CDN everywhere in the app).
const CUSTOM_CATEGORY_ICONS = [
  'package', 'carrot', 'drumstick', 'egg', 'croissant', 'shopping-basket', 'cup-soda', 'cookie',
  'snowflake', 'spray-can', 'droplet', 'baby', 'cooking-pot', 'pill', 'shirt', 'sparkles',
  'book-open', 'gamepad-2', 'music', 'car', 'plane', 'gift', 'flower-2', 'leaf', 'flame',
  'fish', 'beer', 'pizza', 'wrench', 'heart-pulse', 'paintbrush', 'dumbbell', 'cat', 'dog',
];

// A small rotating accent palette for new categories (manual or AI-suggested),
// distinct enough from each other and from the built-in colors above.
const CATEGORY_COLOR_PALETTE = [
  '#43a047', '#e53935', '#fbc02d', '#8d6e63', '#fb8c00', '#039be5', '#ec407a', '#00acc1',
  '#26a69a', '#ab47bc', '#5c6bc0', '#78909c', '#6d4c41', '#7cb342', '#d81b60', '#3949ab',
];
const nextCategoryColor = (existingCount) => CATEGORY_COLOR_PALETTE[existingCount % CATEGORY_COLOR_PALETTE.length];

const itemCategoryMapFrom = (categories) => Object.fromEntries(categories.map((c) => [c.key, c]));

const itemCategoryOrder = (key, categories) => {
  const idx = categories.findIndex((c) => c.key === key);
  return idx === -1 ? categories.length : idx;
};

module.exports = {
  BUILTIN_ITEM_CATEGORIES,
  STORE_CATEGORIES,
  storeCategoryMap,
  CUSTOM_CATEGORY_ICONS,
  nextCategoryColor,
  itemCategoryMapFrom,
  itemCategoryOrder,
};
