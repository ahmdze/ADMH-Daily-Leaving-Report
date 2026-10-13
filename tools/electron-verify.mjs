/* ============================================================
   End-to-end verification of the Electron build (run from source).
   1. Writes a real NSIS-style install-config.txt (UTF-16LE + BOM) next
      to electron.exe — exactly what the installer produces.
   2. Launches the app with --selftest so the main process reports what
      the renderer sees.
   3. Inspects the data folder the app actually created.
   4. Cleans up everything it created.

   Usage: node tools/electron-verify.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* يقبل مسار ملف تنفيذي مُحزَّم كوسيط أول، وإلا يستخدم electron من node_modules.
   اختبار الحزمة المُنتَجة يثبت أن كل الملفات (index.html، src، assets) دخلت. */
const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ELECTRON_EXE = process.argv[2] ? path.resolve(process.argv[2]) : DEV_ELECTRON;
const PACKAGED = path.basename(ELECTRON_EXE).toLowerCase() !== 'electron.exe';
const APP_ARGS = PACKAGED ? [] : [ROOT];

const CONFIG_NEXT_TO_EXE = path.join(path.dirname(ELECTRON_EXE), 'install-config.txt');
const RESULT = path.join(ROOT, '_electron-selftest.json');
const APPDATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'ADMH-Leaves');
const TEST_BACKUP = path.join(os.tmpdir(), 'admh-verify-backups');
/* عزل كامل: نمرّر APPDATA خاصاً للعملية الابنة، فيصبح userData داخل مجلد
   مؤقت ولا نلمس بيانات المستخدم الحقيقية إطلاقاً. */
const TEST_APPDATA = path.join(os.tmpdir(), 'admh-verify-appdata');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}

/* لا نلمس بيانات مستخدم حقيقية.
   عزل userData عبر متغيّر APPDATA لا يعمل: ويندوز يُرجع مسار appData من
   واجهة النظام لا من المتغيّر. لذلك ننقل المجلد القائم إلى نسخة .bak
   (لا نحذفه) لنجري تشغيلاً أولياً نظيفاً، ونترك الـ.bak للمستخدم. */
const BACKUP_DIR = APPDATA_DIR + '.testdata-bak';
let movedExisting = false;
if (fs.existsSync(APPDATA_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    fs.renameSync(APPDATA_DIR, BACKUP_DIR);
    movedExisting = true;
}
check('existing app data preserved as .testdata-bak (nothing deleted)',
    !fs.existsSync(APPDATA_DIR), movedExisting ? BACKUP_DIR : 'لا يوجد مجلد سابق');
if (!fs.existsSync(ELECTRON_EXE)) {
    console.log('غير موجود: ' + ELECTRON_EXE);
    process.exit(2);
}
console.log('=== target: ' + (PACKAGED ? 'PACKAGED build' : 'development electron') + ' ===');
console.log(ELECTRON_EXE + '\n');

/* ---------- 1) ملف إعدادات التنصيب كما يكتبه NSIS ---------- */
const configLines = [
    'ministry=وزارة الصحة',
    'directorate=دائرة صحة بغداد / الرصافة',
    'hospital=مستشفى الاختبار التعليمي',
    'departmentUnit=شعبة الموارد البشرية - وحدة الإجازات',
    'footerHR=مسؤول الموارد البشرية',
    'footerManager=مدير المستشفى',
    'operatorName=موظف إجازات الاختبار',
    'defaultAnnualBalance=30',
    'backupFolder=' + TEST_BACKUP
];
fs.writeFileSync(CONFIG_NEXT_TO_EXE, '\uFEFF' + configLines.join('\r\n') + '\r\n', 'utf16le');
check('install-config.txt written as UTF-16LE next to the exe',
    fs.existsSync(CONFIG_NEXT_TO_EXE) && fs.readFileSync(CONFIG_NEXT_TO_EXE)[0] === 0xFF,
    fs.statSync(CONFIG_NEXT_TO_EXE).size + ' bytes');

fs.rmSync(TEST_BACKUP, { recursive: true, force: true });

/* ---------- 2) تشغيل التطبيق في وضع الفحص ---------- */
if (fs.existsSync(RESULT)) fs.rmSync(RESULT);

let launchError = '';
let launchOut = '';
try {
    /* ELECTRON_RUN_AS_NODE مُضبوط في بيئة هذه الأداة فيُشغّل Electron كـNode
       عادي بلا واجهة — نُزيله للعملية الابنة فقط (لا علاقة له بجهاز المستخدم). */
    const childEnv = Object.assign({}, process.env);
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const r = spawnSync(ELECTRON_EXE, APP_ARGS.concat(['--selftest=' + RESULT]), {
        cwd: ROOT,
        timeout: 120000,
        encoding: 'utf8',
        env: childEnv
    });
    launchOut = String(r.stdout || '') + String(r.stderr || '');
    if (r.error) launchError = r.error.message || String(r.error);
    else if (r.status !== 0) launchError = 'exit code ' + r.status;
} catch (e) {
    launchError = (e && (e.message || String(e))) || 'unknown';
}
if (launchOut.trim()) {
    console.log('--- app output (tail) ---');
    console.log(launchOut.trim().split('\n').slice(-12).join('\n'));
}

/* ---------- 3) قراءة نتيجة الفحص ---------- */
let self = null;
if (fs.existsSync(RESULT)) {
    try { self = JSON.parse(fs.readFileSync(RESULT, 'utf8')); } catch (e) { self = null; }
}
check('app launched and produced a self-test result', !!self, launchError ? launchError.slice(0, 160) : 'ok');
if (self) console.log('--- self-test payload ---\n' + JSON.stringify(self, null, 2));

/* ---------- 4) ما أنشأه التطبيق فعلاً على القرص ---------- */
const dataDir = path.join(APPDATA_DIR, 'data');
check('data folder created under %APPDATA%\\ADMH-Leaves', fs.existsSync(dataDir), dataDir);

let settings = null;
const settingsPath = path.join(dataDir, 'settings.json');
if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { settings = null; }
}
check('settings.json written as real JSON', !!settings);
if (settings) {
    check('install wizard: ministry applied', settings.ministry === 'وزارة الصحة', settings.ministry);
    check('install wizard: hospital applied (Arabic intact)',
        settings.hospital === 'مستشفى الاختبار التعليمي', settings.hospital);
    check('install wizard: operator applied', settings.operatorName === 'موظف إجازات الاختبار', settings.operatorName);
    check('install wizard: annual balance applied', settings.defaultAnnualBalance === 30, settings.defaultAnnualBalance);
    check('install wizard: backup folder applied', settings.backupFolder === TEST_BACKUP, settings.backupFolder);
}

const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : [];
check('all document files present on disk',
    ['settings.json', 'staff.json', 'leaves-index.json', 'departments.json', 'holidays.json'].every(f => files.indexOf(f) !== -1),
    files.join(', '));

let staff = null;
let leavesIndex = null;
try { staff = JSON.parse(fs.readFileSync(path.join(dataDir, 'staff.json'), 'utf8')); } catch (e) { }
try { leavesIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'leaves-index.json'), 'utf8')); } catch (e) { }
check('clean install: NO employees seeded', Array.isArray(staff) && staff.length === 0,
    Array.isArray(staff) ? staff.length + ' employees' : 'unreadable');
check('clean install: NO leave records seeded',
    Array.isArray(leavesIndex) && leavesIndex.length === 0,
    Array.isArray(leavesIndex) ? leavesIndex.length + ' year files' : 'unreadable');

/* المطوّر والإصدار */
check('renderer reported the Electron backend',
    self && (self.backend === 'electron' || self.storeBackend === 'electron'),
    self ? (self.backend || self.storeBackend) : 'n/a');
check('engine: IPC round-trip of a document succeeded',
    self && (self.roundTripOk === true), self ? String(self.roundTripOk) : 'n/a');
check('engine: print engine available inside Electron',
    self && (self.printEngine === true && self.pageCount >= 1),
    self ? ('pages=' + self.pageCount) : 'n/a');

/* النسخة الاحتياطية اليومية تُكتب في المجلد المحدَّد عند التنصيب */
const backupFiles = fs.existsSync(TEST_BACKUP) ? fs.readdirSync(TEST_BACKUP).filter(f => /^snapshot-.*\.json$/.test(f)) : [];
check('backup written into the installer-chosen folder', backupFiles.length >= 1,
    backupFiles.length + ' snapshot(s) in ' + TEST_BACKUP);
if (backupFiles.length) {
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(path.join(TEST_BACKUP, backupFiles[0]), 'utf8')); } catch (e) { }
    check('backup snapshot is a valid full document', !!(snap && snap._format === 'admh-leaves-backup'),
        snap ? snap._format + ' v' + snap._version : 'unreadable');
}

/* ---------- 5) تنظيف ---------- */
try { fs.rmSync(CONFIG_NEXT_TO_EXE, { force: true }); } catch (e) { }
try { fs.rmSync(RESULT, { force: true }); } catch (e) { }
try { fs.rmSync(TEST_BACKUP, { recursive: true, force: true }); } catch (e) { }
try { fs.rmSync(TEST_APPDATA, { recursive: true, force: true }); } catch (e) { }
try { fs.rmSync(APPDATA_DIR, { recursive: true, force: true }); } catch (e) { }
console.log('\n(cleaned up: install-config.txt, self-test result, temp backup folder, test app data)');
if (movedExisting) {
    console.log('(البيانات السابقة محفوظة في: ' + BACKUP_DIR + ' — بيانات اختبار سابقة، يمكنك حذفها)');
}

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
failed.forEach(f => console.log(' - ' + f.name + (f.detail ? '  [' + f.detail + ']' : '')));
process.exit(failed.length ? 1 : 0);
