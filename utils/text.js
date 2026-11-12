// Shared text normalization for matching brand/product text loosely (spacing,
// أ/إ/آ→ا, ة→ه, ى→ي, case) so trivial typing differences don't split what's
// really the same brand/product into separate groups.
const normalizeProductText = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();

module.exports = { normalizeProductText };
