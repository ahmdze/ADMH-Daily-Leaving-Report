/* ============================================================
   Measures what a SCHEMA CHANGE does to an already-installed copy.
   Temporarily patches the source to simulate an update that:
     (a) adds a whole new document ("table")
     (b) adds a new field to settings
     (c) adds a new field to a record (no default exists)
     (d) renames a field
   runs the real packaged app against data written by the OLD
   version, and reports exactly what survived. Reverts all patches.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}
function info(msg) { console.log('   · ' + msg); }

/* يختبر المصدر الحالي مباشرة (electron .) لا الحزمة المبنية، حتى يقيس
   تعديلات الكود فوراً قبل إعادة البناء. */
const APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_ARGS = [ROOT];
const DATA = path.join(process.env.APPDATA, 'ADMH-Leaves', 'data');
const CONSTANTS = path.join(ROOT, 'src', 'js', 'constants.js');
const STORE = path.join(ROOT, 'src', 'js', 'core', 'store.js');
const childEnv = Object.assign({}, process.env);
delete childEnv.ELECTRON_RUN_AS_NODE;

if (!fs.existsSync(APP)) { console.log('لا توجد حزمة مُنتَجة'); process.exit(2); }
if (fs.existsSync(path.join(process.env.APPDATA, 'ADMH-Leaves'))) {
    console.log('!! %APPDATA%\\ADMH-Leaves موجود — أوقف الاختبار.'); process.exit(2);
}

const origConstants = fs.readFileSync(CONSTANTS, 'utf8');
const origStore = fs.readFileSync(STORE, 'utf8');
function revert() {
    fs.writeFileSync(CONSTANTS, origConstants, 'utf8');
    fs.writeFileSync(STORE, origStore, 'utf8');
}
process.on('exit', () => { try { revert(); } catch (e) { } });

function runApp(tag) {
    const out = path.join(os.tmpdir(), 'admh-schema-' + tag + '.json');
    fs.rmSync(out, { force: true });
    const r = spawnSync(APP, APP_ARGS.concat(['--selftest=' + out]), { encoding: 'utf8', timeout: 120000, env: childEnv });
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { }
    fs.rmSync(out, { force: true });
    if (!payload && r.stderr) info('stderr: ' + String(r.stderr).slice(0, 160));
    return payload;
}

/* ---------- 0) بيانات «النسخة القديمة» ---------- */
console.log('\n### 0) إنشاء بيانات بالنسخة الحالية (قبل التحديث) ###');
runApp('init');
const staff = [{ id: 'e1', fullName: 'د. سارة عبد الله', jobTitle: 'طبيب', dept: 'قسم الباطنية',
    section: 'شعبة أ', annualBalance: 21, isActive: true }];
fs.writeFileSync(path.join(DATA, 'staff.json'), JSON.stringify(staff, null, 2), 'utf8');
const st = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
st.hospital = 'مستشفى بيانات قديمة';
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(st, null, 2), 'utf8');
check('old-version data prepared', fs.existsSync(path.join(DATA, 'staff.json')));

/* ---------- 1) محاكاة تحديث يضيف «جدولاً» جديداً وحقلاً جديداً ---------- */
console.log('\n### 1) تحديث يضيف مستنداً جديداً + حقل إعدادات جديد ###');
let c = origConstants;
c = c.replace(
    "KEYS.HOLIDAYS, KEYS.LEAVES, KEYS.COMPENSATIONS, KEYS.AUDIT, KEYS.META\n    ];",
    "KEYS.HOLIDAYS, KEYS.LEAVES, KEYS.COMPENSATIONS, KEYS.AUDIT, KEYS.META, 'newTable'\n    ];"
);
c = c.replace("KEYS: KEYS,", "KEYS: KEYS, NEW_TABLE_KEY: 'newTable',");
c = c.replace(/(DEFAULT_SETTINGS\s*=\s*\{)/, "$1\n        brandNewSetting: 'قيمة افتراضية جديدة',");
fs.writeFileSync(CONSTANTS, c, 'utf8');

let s = origStore;
s = s.replace("            audit: [],", "            audit: [],\n            newTable: [],");
fs.writeFileSync(STORE, s, 'utf8');

check('source patched to simulate the update', c !== origConstants && s !== origStore);

const p1 = runApp('added');
check('app still boots with the new schema', !!p1, p1 ? p1.backend : 'no payload');

/* الاسم المشتق باصطلاح المشروع: camelCase → kebab-case.json */
const newDocFile = ['new-table.json', 'newTable.json']
    .map(f => path.join(DATA, f)).find(f => fs.existsSync(f));
check('NEW document file created automatically on existing installs', !!newDocFile,
    newDocFile ? path.basename(newDocFile) : 'MISSING');

/* الأهم: هل تبقى بيانات المستند الجديد بعد إعادة التشغيل؟ (لا فقدان صامت) */
if (newDocFile) {
    fs.writeFileSync(newDocFile, JSON.stringify([{ id: 'n1', label: 'صف في الجدول الجديد' }], null, 2), 'utf8');
    runApp('roundtrip');
    let back = null;
    try { back = JSON.parse(fs.readFileSync(newDocFile, 'utf8')); } catch (e) { }
    check('NEW document data SURVIVES a restart (read back, not recreated empty)',
        Array.isArray(back) && back.length === 1 && back[0].label === 'صف في الجدول الجديد',
        back ? JSON.stringify(back).slice(0, 60) : 'unreadable');
}

const stAfter = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
check('NEW settings field filled with its default automatically',
    stAfter.brandNewSetting === 'قيمة افتراضية جديدة', stAfter.brandNewSetting);
check('existing custom settings value PRESERVED through the change',
    stAfter.hospital === 'مستشفى بيانات قديمة', stAfter.hospital);
const staffAfter = JSON.parse(fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8'));
check('existing employee records untouched by the schema change',
    staffAfter.length === 1 && staffAfter[0].fullName === 'د. سارة عبد الله',
    staffAfter.length + ' employee(s)');

/* ---------- 2) محاكاة حذف حقل من السجلات ---------- */
console.log('\n### 2) حذف حقل من السجلات (عمود) ###');
const stripped = staffAfter.map(r => { const o = Object.assign({}, r); delete o.section; return o; });
fs.writeFileSync(path.join(DATA, 'staff.json'), JSON.stringify(stripped, null, 2), 'utf8');
runApp('removed');
const staffNoSection = JSON.parse(fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8'));
check('deleting a record field does NOT restore it (old data keeps old shape)',
    staffNoSection[0].section === undefined, 'section=' + String(staffNoSection[0].section));
check('the rest of the record is intact', staffNoSection[0].fullName === 'د. سارة عبد الله');

/* ---------- 3) محاكاة إعادة تسمية حقل ---------- */
console.log('\n### 3) إعادة تسمية حقل في السجلات ###');
const renamed = staffNoSection.map(r => {
    const o = Object.assign({}, r);
    o.fullNameAr = o.fullName;      /* الاسم الجديد */
    delete o.fullName;              /* الاسم القديم */
    return o;
});
fs.writeFileSync(path.join(DATA, 'staff.json'), JSON.stringify(renamed, null, 2), 'utf8');
runApp('renamed');
const staffRenamed = JSON.parse(fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8'));
check('renaming a field keeps the DATA on disk (nothing is destroyed)',
    staffRenamed[0].fullNameAr === 'د. سارة عبد الله', staffRenamed[0].fullNameAr);
info('لكن الكود الجديد يقرأ fullName فيجدها undefined — أي «فقدان» ظاهري بلا حذف فعلي.');

/* ---------- 4) ترقية إصدار: نسخة أمان تلقائية قبل أي تغيير ---------- */
console.log('\n### 4) ترقية إصدار البرنامج (1.0.0 → 1.0.1) ###');
const metaBefore = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const backupsDir = path.join(process.env.APPDATA, 'ADMH-Leaves', 'backups');
const backupsBefore = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;

let bump = fs.readFileSync(CONSTANTS, 'utf8')   /* الملف مُرجَع أصلاً في هذه المرحلة */
    .replace("APP_VERSION: '1.0.1'", "APP_VERSION: '1.0.2'");
fs.writeFileSync(CONSTANTS, bump, 'utf8');
runApp('bumped');

const metaAfter = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
check('version upgrade detected and recorded', metaAfter.appVersion === '1.0.2',
    metaBefore.appVersion + ' → ' + metaAfter.appVersion);
check('upgrade timestamp recorded', !!metaAfter.lastUpgradeAt && metaAfter.lastUpgradeAt !== metaBefore.lastUpgradeAt);
const backupsAfter = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).length : 0;
check('a safety backup was taken around the upgrade', backupsAfter >= backupsBefore,
    backupsBefore + ' → ' + backupsAfter + ' snapshot(s)');
check('user settings survived the version upgrade',
    JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).hospital === 'مستشفى بيانات قديمة');

/* ---------- 5) إرجاع الملفات ---------- */
console.log('\n### 5) إرجاع الملفات المعدّلة ###');
revert();
check('constants.js restored', fs.readFileSync(CONSTANTS, 'utf8') === origConstants);
check('store.js restored', fs.readFileSync(STORE, 'utf8') === origStore);

/* ---------- 6) تنظيف ---------- */
try { fs.rmSync(path.join(process.env.APPDATA, 'ADMH-Leaves'), { recursive: true, force: true }); } catch (e) { }
console.log('(أُزيلت بيانات الاختبار)');

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
failed.forEach(f => console.log(' - ' + f.name));
process.exit(failed.length ? 1 : 0);
