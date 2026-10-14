/* ============================================================
   Verifies the REAL installer artifact end to end:
   1. Silent-installs it into a throwaway folder (NSIS /S /D=).
   2. Reads the install-config.txt the NSIS script actually wrote:
      BOM, encoding, all 9 keys, Arabic intact.
   3. Runs the real uninstaller and checks the machine is clean while
      the user's data and backup folder survive.
   Nothing here is simulated — it runs the shipped Setup.exe.
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

/* المعالج في dist/ */
const setup = fs.readdirSync(path.join(ROOT, 'dist'))
    .filter(f => /^ADMH-Leaves-Setup-.*\.exe$/i.test(f))
    .map(f => path.join(ROOT, 'dist', f))[0];
if (!setup) { console.log('لا يوجد مثبّت في dist/'); process.exit(2); }
console.log('=== installer: ' + path.basename(setup) + ' ===');
console.log('sha256: ' + (spawnSync('certutil', ['-hashfile', setup, 'SHA256'], { encoding: 'utf8' }).stdout || '').split('\n')[1] || '');

const TARGET = path.join(os.tmpdir(), 'admh-inst-test');
const BACKUP_DEFAULT = path.join(os.homedir(), 'Documents', 'ADMH-Leaves-Backups');
const backupExistedBefore = fs.existsSync(BACKUP_DEFAULT);
const appDataDir = path.join(process.env.APPDATA, 'ADMH-Leaves');
const appDataExistedBefore = fs.existsSync(appDataDir);
const backupMarker = path.join(BACKUP_DEFAULT, 'test-marker.txt');

console.log('target dir      : ' + TARGET);
console.log('backup default  : ' + BACKUP_DEFAULT + (backupExistedBefore ? ' (موجود مسبقاً)' : ' (غير موجود)'));

/* نُبقي علامة داخل مجلد النسخ لنثبت أن إلغاء التثبيت لا يمسّه */
fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(BACKUP_DEFAULT, { recursive: true });
fs.writeFileSync(backupMarker, 'verification marker', 'utf8');

/* ---------- 1) تنصيب صامت فعلي ---------- */
const inst = spawnSync(setup, ['/S', '/D=' + TARGET], { encoding: 'utf8', timeout: 300000 });
check('silent install completed (exit 0)', inst.status === 0, 'exit=' + inst.status);

/* electron-builder قد يُلحق اسم المنتج بالمجلد المختار — نبحث في الموضعين */
const candidates = [TARGET, path.join(TARGET, 'ADMH-Leaves')];
const installDir = candidates.find(d => fs.existsSync(path.join(d, 'ADMH-Leaves.exe'))) ||
    candidates.find(d => fs.existsSync(d));
check('app installed (ADMH-Leaves.exe present)',
    !!installDir && fs.existsSync(path.join(installDir, 'ADMH-Leaves.exe')), installDir);

/* ---------- 2) ملف إعدادات التنصيب الذي كتبه NSIS فعلاً ---------- */
const cfgPath = installDir ? path.join(installDir, 'install-config.txt') : null;
const cfgExists = !!cfgPath && fs.existsSync(cfgPath);
check('install-config.txt written next to the exe by the installer', cfgExists, cfgPath);

let cfg = {};
if (cfgExists) {
    const buf = fs.readFileSync(cfgPath);
    check('UTF-16LE BOM present (FF FE)', buf[0] === 0xFF && buf[1] === 0xFE,
        'first bytes: ' + buf[0] + ',' + buf[1]);
    let text = '';
    try { text = new TextDecoder('utf-16le').decode(buf.slice(2)); } catch (e) { }
    text.split(/\r?\n/).forEach(line => {
        const i = line.indexOf('=');
        if (i > 0) cfg[line.slice(0, i).trim()] = line.slice(i + 1);
    });
    const keys = ['ministry', 'directorate', 'hospital', 'departmentUnit', 'footerHR',
        'footerManager', 'operatorName', 'defaultAnnualBalance', 'backupFolder'];
    const missing = keys.filter(k => !cfg[k]);
    check('all 9 wizard keys present with values', missing.length === 0,
        missing.length ? 'مفقود: ' + missing.join(', ') : Object.keys(cfg).length + ' keys');
    console.log('--- install-config.txt (as written by NSIS) ---');
    console.log(JSON.stringify(cfg, null, 1));

    /* العربية سليمة: أي مربّعات أو ؟ تعني عطب ترميز */
    const arabicOk = /[\u0600-\u06FF]/.test(cfg.hospital || '') &&
        !/\uFFFD/.test(JSON.stringify(cfg));
    check('Arabic values intact (no mojibake, no replacement chars)', arabicOk, cfg.hospital);
    check('annual balance is a plain integer',
        /^\d+$/.test(String(cfg.defaultAnnualBalance || '')), cfg.defaultAnnualBalance);
    check('backup folder path is a real absolute path',
        /^[A-Za-z]:\\/.test(cfg.backupFolder || ''), cfg.backupFolder);
}

/* ---------- 3) إلغاء التثبيت الحقيقي ---------- */
const uninst = installDir ? path.join(installDir, 'Uninstall ADMH-Leaves.exe') : null;
let unExit = null;
if (uninst && fs.existsSync(uninst)) {
    const r = spawnSync(uninst, ['/S'], { encoding: 'utf8', timeout: 300000, cwd: os.tmpdir() });
    unExit = r.status;
    /* NSIS uninstaller ينسخ نفسه لمجلد مؤقت ويعود فوراً — ننتظر قليلاً */
    const wait = spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 12']);
    void wait;
}
check('uninstaller ran (exit 0)', unExit === 0, 'exit=' + unExit);

check('app files removed by the uninstaller',
    !installDir || !fs.existsSync(path.join(installDir, 'ADMH-Leaves.exe')),
    installDir);
check('install-config.txt removed by the uninstaller',
    !cfgPath || !fs.existsSync(cfgPath));

/* الأهم للمستخدم: لا تُمسح بياناته ولا نسخه الاحتياطية */
check('backup folder SURVIVED the uninstall', fs.existsSync(BACKUP_DEFAULT) &&
    fs.existsSync(backupMarker));
check('user data folder SURVIVED the uninstall',
    appDataExistedBefore ? fs.existsSync(appDataDir) : true,
    appDataExistedBefore ? appDataDir : 'لم يكن موجوداً قبل الاختبار');

/* ---------- 4) تنظيف ما أنشأه الاختبار ---------- */
try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch (e) { }
try { fs.rmSync(backupMarker, { force: true }); } catch (e) { }
if (!backupExistedBefore) {
    /* نُزيل المجلد فقط إن أنشأناه نحن وكان فارغاً بعد إزالة العلامة */
    try {
        if (fs.readdirSync(BACKUP_DEFAULT).length === 0) fs.rmdirSync(BACKUP_DEFAULT);
    } catch (e) { }
    console.log('(أُزيل مجلد النسخ الافتراضي لأنه لم يكن موجوداً قبل الاختبار)');
} else {
    console.log('(مجلد النسخ كان موجوداً قبل الاختبار — أُبقيت محتوياته كما هي)');
}
if (!appDataExistedBefore) {
    try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch (e) { }
}

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
failed.forEach(f => console.log(' - ' + f.name));
process.exit(failed.length ? 1 : 0);
