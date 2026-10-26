// One-time seed: creates a starter list with the household's commonly-bought items.
// Usage: node seed.js <owner_email>
const { run, get, init } = require('./db');

const ITEMS = [
  ['سمك', null],
  ['عوال', null],
  ['كرواسون بالجبن', '٣ كراتين'],
  ['كرواسون بالكوفي', 'كرتونين'],
  ['بسكويت سبادا', 'كرتون'],
  ['شيبس', null],
  ['سمطان', null],
  ['كلينكس', 'قواطي'],
  ['خس', null],
  ['فلفل صغير', null],
  ['زيت', null],
  ['ليمون', null],
  ['بيض', null],
  ['تفاح', null],
  ['برتقال', null],
  ['خيار', null],
  ['فواكه', null],
  ['فلفل كبير', null],
  ['رمان', null],
  ['فلاش حمامات', null],
  ['أقفال خزانة (كبت)', '٥'],
  ['عبايا مارية', null],
  ['ماء صحة', 'كرتون'],
  ['مكتب جيناكم', null],
  ['بطاطس', 'كيستين'],
  ['أعواد أذن', null],
  ['M&M', null],
  ['شامبو', null],
  ['حليب المدهش (قواطي)', 'كرتون'],
  ['روتي', null],
  ['روتي برجر', null],
  ['طحينة تمر', null],
  ['بصل', null],
  ['ثوم', null],
  ['حليب المدهش (كيسة)', null],
  ['طماطم', null],
  ['جزر', null],
  ['باذنجان', null],
  ['دجاج ظفار', 'كرتون'],
  ['صابون ديتول', null],
  ['صلصة', null],
  ['جبن', null],
  ['زبادي', '٣'],
  ['كورن فليكس بالشوكولاتة', null],
  ['كيس بطاطس مختلفات', 'كيستين'],
  ['قهوة (كوفي)', 'كرتونين'],
  ['كيك', 'كرتون'],
  ['حليب طويل الأجل', null],
  ['ديتول', null],
  ['محوّل كهرباء', null],
  ['عيش', 'كبير'],
  ['سكر', 'كيس'],
  ['ملح', 'كيس'],
  ['سائل عباية', null],
  ['خبز برجر', null],
  ['صابون ملابس', null],
  ['معجون أسنان', null],
  ['طحين رقم ١ الذهبي', null],
  ['كاتشب', null],
  ['كيكة الزهراء', null],
  ['سنتوب', 'كرتون'],
  ['عسل', 'دبة (نوع أول)'],
  ['طية كلينكس', null],
  ['عصير مانجو وبرتقال', 'دبتين'],
  ['ملمع زجاج', null],
  ['بخاخ', null],
  ['كيس زبالة صغير', null],
  ['كيس زبالة كبير', null],
  ['ملف مارية', null],
];

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node seed.js <owner_email>');
    process.exit(1);
  }

  await init();
  const owner = await get('SELECT id FROM users WHERE LOWER(email) = ?', [email.toLowerCase()]);
  if (!owner) {
    console.error('No user found with email:', email);
    process.exit(1);
  }

  const { lastID: listId } = await run('INSERT INTO lists (owner_id, title) VALUES (?, ?)', [owner.id, 'القائمة الأساسية']);

  for (const [name, quantity] of ITEMS) {
    await run(
      'INSERT INTO list_items (list_id, name, quantity, added_by) VALUES (?, ?, ?, ?)',
      [listId, name, quantity, owner.id]
    );
  }

  console.log(`Seeded list #${listId} "القائمة الأساسية" with ${ITEMS.length} items for ${email}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
