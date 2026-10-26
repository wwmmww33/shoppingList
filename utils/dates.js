const WEEKDAY_NAMES_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const toDateOnly = (d) => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const todayDateOnlyString = () => toDateOnly(new Date()).toISOString().slice(0, 10);

// Next occurrence of `weekday` (0=Sunday..6=Saturday) strictly after `fromDate`.
const nextWeekdayAfter = (weekday, fromDate = new Date()) => {
  const d = toDateOnly(fromDate);
  const diff = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d.toISOString().slice(0, 10);
};

const weekdayNameAr = (weekday) => WEEKDAY_NAMES_AR[weekday] || '';

const ARABIC_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
// `dateStr` is a plain 'YYYY-MM-DD' calendar date. Parsed via UTC components
// specifically so the SERVER's own system timezone can never shift which
// weekday it resolves to (new Date('YYYY-MM-DD') parses as UTC midnight,
// then .getDay() would apply the server's LOCAL offset on top of that).
const formatDateArabic = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY_NAMES_AR[date.getUTCDay()]} ${d} ${ARABIC_MONTHS[m - 1]}`;
};

// Oman (Asia/Muscat) is a fixed UTC+4 offset year-round — no DST to account for.
// Purchases are timestamped with this regardless of the server's own system
// timezone, so "bought_at" always reads correctly for someone in Oman.
const OMAN_UTC_OFFSET_HOURS = 4;
const nowOmanString = () =>
  new Date(Date.now() + OMAN_UTC_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

module.exports = { WEEKDAY_NAMES_AR, todayDateOnlyString, nextWeekdayAfter, weekdayNameAr, nowOmanString, formatDateArabic };
