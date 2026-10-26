// Predefined measurement units, grouped the way retail standards (and
// Shopify/New Zealand unit-pricing references) classify them — weight,
// volume, and count/packaging — with a few added for how groceries are
// actually sold in Gulf/Omani stores (gallon, sack, egg tray).
const UNITS = [
  // Weight
  { key: 'kg', label: 'كيلوجرام' },
  { key: 'g', label: 'جرام' },
  // Volume
  { key: 'l', label: 'لتر' },
  { key: 'ml', label: 'مليلتر' },
  { key: 'gallon', label: 'جالون' },
  // Count / packaging
  { key: 'piece', label: 'قطعة' },
  { key: 'dozen', label: 'دستة' },
  { key: 'pack', label: 'عبوة' },
  { key: 'box', label: 'علبة' },
  { key: 'carton', label: 'كرتون' },
  { key: 'bottle', label: 'زجاجة' },
  { key: 'bag', label: 'كيس' },
  { key: 'bundle', label: 'ربطة' },
  { key: 'sack', label: 'جوال' },
  { key: 'tray', label: 'طبق (مثل طبق البيض)' },
];

const unitMap = Object.fromEntries(UNITS.map((u) => [u.key, u]));

module.exports = { UNITS, unitMap };
