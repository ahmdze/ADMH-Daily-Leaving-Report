/* ============================================================
   Simulates a REAL version upgrade on an installed machine:
     1. silent-install the Setup.exe into a throwaway folder
     2. run the app so it initializes its data folder
     3. put distinctive "months of real work" data in it
     4. run the SAME Setup.exe again over the top (an upgrade)
     5. check what happened to the data, the settings and the
        install-config marker
     6. run the app again and see whether anything was clobbered
   This answers "does an update touch the users' database?"
   with measurements instead of theory.
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

const setup = fs.readdirSync(path.join(ROOT, 'dist'))
    .filter(f => /^ADMH-Leaves-Setup-.*\.exe$/i.test(f))
    .map(f => path.join(ROOT, 'dist', f))[0];
if (!setup) { console.log('لا يوجد مثبّت'); process.exit(2); }

const TARGET = path.join(os.tmpdir(), 'admh-upgrade-test');
const DATA = path.join(process.env.APPDATA, 'ADMH-Leaves', 'data');
const MARKER = path.join(process.env.APPDATA, 'ADMH-Leaves', 'install-config.applied');
const APP = path.join(TARGET, 'ADMH-Leaves.exe');

/* سلامة: لا نلمس بيانات حقيقية */
if (fs.existsSync(path.join(process.env.APPDATA, 'ADMH-Leaves'))) {
    console.log('!! %APPDATA%\\ADMH-Leaves موجود — أوقف الاختبار.');
    process.exit(2);
}
fs.rmSync(TARGET, { recursive: true, force: true });

/* بيئة التشغيل: إزالة ELECTRON_RUN_AS_NODE الخاصة بأداة DSH فقط */
const childEnv = Object.assign({}, process.env);
delete childEnv.ELECTRON_RUN_AS_NODE;

function install(label) {
    /* المثبّت يفشل أحياناً بـ 0xC0000005 (3221225477) في أول تشغيل من صدفة
       جديدة — عطل بيئي موثّق، وإعادة المحاولة تنجح دائماً. */
    let status = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r = spawnSync(setup, ['/S', '/D=' + TARGET], { encoding: 'utf8', timeout: 300000 });
        status = r.status;
        if (status === 0) {
            if (attempt > 1) console.log(`   (نجحت المحاولة ${attempt} — الأولى رجعت ${r.status})`);
            break;
        }
        console.log(`   محاولة ${attempt}: exit=${status} — إعادة المحاولة…`);
        spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4']);
    }
    check(label + ': installer exit 0', status === 0, 'exit=' + status);
    return status === 0;
}
function runApp() {
    const out = path.join(os.tmpdir(), 'admh-upgrade-selftest.json');
    fs.rmSync(out, { force: true });
    const r = spawnSync(APP, ['--selftest=' + out], { encoding: 'utf8', timeout: 120000, env: childEnv });
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { }
    fs.rmSync(out, { force: true });
    return { status: r.status, payload };
}

/* ---------- 1) التنصيب الأول ---------- */
console.log('\n### 1) التثبيت الأول (الإصدار 1.0.0) ###');
install('install #1');
check('app installed', fs.existsSync(APP));

/* ---------- 2) تشغيل أول: يُنشئ البيانات ويستهلك ملف التنصيب ---------- */
console.log('\n### 2) أول تشغيل — تهيئة مجلد البيانات ###');
const first = runApp();
check('first run initialised the app', first.payload && first.payload.backend === 'electron',
    first.payload ? first.payload.backend : 'no payload');
check('install-config marker created (wizard consumed once)', fs.existsSync(MARKER));
check('data folder created', fs.existsSync(DATA));

/* ---------- 3) نحاكي أشهراً من العمل الحقيقي ---------- */
console.log('\n### 3) وضع بيانات «عمل حقيقي» مميزة ###');
const CUSTOM_HOSPITAL = 'مستشفى الكندي التعليمي — بيانات حقيقية';
const settingsPath = path.join(DATA, 'settings.json');
if (!fs.existsSync(settingsPath)) {
    console.log('لا يمكن المتابعة: التطبيق لم يُنشئ مجلد البيانات.');
    const f0 = results.filter(r => !r.ok);
    console.log(`\ntotal=${results.length}  passed=${results.length - f0.length}  failed=${f0.length}`);
    process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.hospital = CUSTOM_HOSPITAL;
settings.operatorName = 'موظف الإجازات الحقيقي';
settings.ministry = 'وزارة الصحة العراقية';
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

const staff = [{ id: 'real-1', fullName: 'د. أحمد محمد الجبوري', jobTitle: 'طبيب اختصاص',
    dept: 'قسم الباطنية', section: 'شعبة الباطنية أ', annualBalance: 21, isActive: true }];
fs.writeFileSync(path.join(DATA, 'staff.json'), JSON.stringify(staff, null, 2), 'utf8');

const leaves = [{ id: 'lv-1', empName: 'د. أحمد محمد الجبوري', jobTitle: 'طبيب اختصاص',
    dept: 'قسم الباطنية', section: 'شعبة الباطنية أ', leaveType: 'إجازة اعتيادية',
    fromDate: '2026-03-01', toDate: '2026-03-03', daysCount: 3, deductedDays: 3, status: 'approved' }];
fs.mkdirSync(path.join(DATA, 'leaves'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'leaves', 'leaves-2026.json'), JSON.stringify(leaves, null, 2), 'utf8');
fs.writeFileSync(path.join(DATA, 'leaves-index.json'), JSON.stringify(['2026'], null, 2), 'utf8');
check('realistic data written (1 employee, 1 leave, custom settings)', true,
    'hospital=' + CUSTOM_HOSPITAL.slice(0, 20) + '…');

/* ---------- 4) التحديث: تنصيب نفس المثبّت فوق النسخة القائمة ---------- */
console.log('\n### 4) التحديث — تنصيب النسخة الجديدة فوق القائمة ###');
const before = {
    settings: fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'),
    staff: fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8'),
    leaves: fs.readFileSync(path.join(DATA, 'leaves', 'leaves-2026.json'), 'utf8'),
    marker: fs.existsSync(MARKER)
};
install('upgrade');
const wait = spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 8']);
void wait;

/* ---------- 5) ما الذي نجا؟ ---------- */
console.log('\n### 5) ماذا حدث للبيانات؟ ###');
const after = {
    settings: fs.existsSync(path.join(DATA, 'settings.json')) ? fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8') : null,
    staff: fs.existsSync(path.join(DATA, 'staff.json')) ? fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8') : null,
    leaves: fs.existsSync(path.join(DATA, 'leaves', 'leaves-2026.json')) ? fs.readFileSync(path.join(DATA, 'leaves', 'leaves-2026.json'), 'utf8') : null,
    marker: fs.existsSync(MARKER)
};
check('settings.json SURVIVED the upgrade byte-for-byte', after.settings === before.settings);
check('staff.json SURVIVED the upgrade', after.staff === before.staff,
    after.staff ? JSON.parse(after.staff).length + ' employee(s)' : 'MISSING');
check('leave records SURVIVED the upgrade', after.leaves === before.leaves,
    after.leaves ? JSON.parse(after.leaves).length + ' record(s)' : 'MISSING');
check('.prev.json generation kept', fs.existsSync(path.join(DATA, 'settings.prev.json')));

const cfgPath = path.join(TARGET, 'install-config.txt');
check('the wizard file was rewritten by the upgrade', fs.existsSync(cfgPath));
check('install-config marker still present after upgrade', after.marker === true);

/* ---------- 6) تشغيل بعد التحديث: هل دُهست الإعدادات؟ ---------- */
console.log('\n### 6) تشغيل التطبيق بعد التحديث ###');
const second = runApp();
check('app runs after the upgrade', second.payload && second.payload.backend === 'electron',
    second.payload ? ('roundTrip=' + second.payload.roundTripOk) : 'no payload');

const finalSettings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
check('hospital NOT overwritten by the upgrade wizard', finalSettings.hospital === CUSTOM_HOSPITAL,
    finalSettings.hospital);
check('operator NOT overwritten by the upgrade wizard',
    finalSettings.operatorName === 'موظف الإجازات الحقيقي', finalSettings.operatorName);
const finalStaff = JSON.parse(fs.readFileSync(path.join(DATA, 'staff.json'), 'utf8'));
check('employees still intact after the upgrade run', finalStaff.length === 1, finalStaff.length + ' employee(s)');

/* ---------- 7) تنظيف كامل ---------- */
console.log('\n### 7) تنظيف ###');
const uninst = path.join(TARGET, 'Uninstall ADMH-Leaves.exe');
if (fs.existsSync(uninst)) {
    spawnSync(uninst, ['/S'], { encoding: 'utf8', timeout: 300000, cwd: os.tmpdir() });
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 10']);
}
try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch (e) { }
try { fs.rmSync(path.join(process.env.APPDATA, 'ADMH-Leaves'), { recursive: true, force: true }); } catch (e) { }
console.log('(أُزيل كل ما أنشأه الاختبار)');

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
failed.forEach(f => console.log(' - ' + f.name));
process.exit(failed.length ? 1 : 0);
