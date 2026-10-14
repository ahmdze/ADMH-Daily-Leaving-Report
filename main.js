/* ============================================================
   main.js — نواة تطبيق Electron لنظام موقف الإجازات اليومية
   ------------------------------------------------------------
   المسؤوليات:
     1) نافذة واحدة فقط (single instance) — كاتبان على الملفات نفسها
        يعني فقدان بيانات، لذلك نرفض أي تشغيل ثانٍ ونركّز النافذة القائمة.
     2) تخزين الوثائق في <userData>/data، وثيقة لكل ملف، بنفس أسماء
        ملفات نسخة الويب حتى يبقى المجلد قابلاً للتبادل بين النسختين.
     3) كتابة ذرّية (tmp ثم rename) مع الاحتفاظ بالنسخة السابقة .prev.json.
     4) نسخ احتياطية دوّارة في مجلد يحدّده المستخدم (افتراضياً <userData>/backups).
     5) قراءة install-config.txt الذي يكتبه مثبّت NSIS بترميز UTF-16LE
        مع BOM — مرة واحدة فقط لكل تنصيب.
     6) وضع اختبار ذاتي (--selftest=<path>) للتحقق الآلي.

   كل معالج IPC مُغلَّف: أي فشل يعيد قيمة آمنة ويسجّل في الطرفية،
   ولا يرمي خطأً إلى الواجهة أبداً.
   ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/* ============================================================
   ثوابت
   ============================================================ */

const WINDOW_TITLE = 'نظام موقف الإجازات اليومية';
const DATA_DIR_NAME = 'data';
const BACKUPS_DIR_NAME = 'backups';
const LEAVES_DIR_NAME = 'leaves';
const LEAVES_INDEX_FILE = 'leaves-index.json';
const BACKUP_FOLDER_FILE = 'backup-folder.txt';
const INSTALL_CONFIG_FILE = 'install-config.txt';
const INSTALL_APPLIED_FILE = 'install-config.applied';
const META_FILE = 'meta.json';

/* أسماء الملفات الثابتة — مطابقة تماماً لأسماء نسخة الويب */
const FILE_MAP = {
    settings: 'settings.json',
    leaveTypes: 'leave-types.json',
    departments: 'departments.json',
    staff: 'staff.json',
    holidays: 'holidays.json',
    compensations: 'compensations.json',
    audit: 'audit.json',
    meta: META_FILE
};

/* ترتيب كتابة الوثائق (settings أولاً ليكون علامة وجود البيانات) */
const DOC_KEYS = ['settings', 'leaveTypes', 'departments', 'staff',
    'holidays', 'compensations', 'audit', 'meta'];

/* مفاتيح ملف التنصيب المقبولة */
const INSTALL_KEYS = ['ministry', 'directorate', 'hospital', 'departmentUnit',
    'footerHR', 'footerManager', 'operatorName', 'defaultAnnualBalance',
    'backupFolder'];

const MAX_BACKUPS = 30;
const SELFTEST_TIMEOUT_MS = 20000;

/* ============================================================
   القنوات — يجب أن تطابق ما في preload.js حرفياً
   ============================================================ */
const CH = {
    appVersion: 'admh:app-version',
    paths: 'admh:paths',
    readAll: 'admh:read-all',
    writeAll: 'admh:write-all',
    writeDoc: 'admh:write-doc',
    chooseBackupFolder: 'admh:choose-backup-folder',
    setBackupFolder: 'admh:set-backup-folder',
    getBackupFolder: 'admh:get-backup-folder',
    writeBackup: 'admh:write-backup',
    listBackups: 'admh:list-backups',
    readBackup: 'admh:read-backup',
    openFolder: 'admh:open-folder',
    takeInstallConfig: 'admh:take-install-config',
    quit: 'admh:quit'
};

/* ============================================================
   حالة عامة
   ============================================================ */
let mainWindow = null;
let selftestPath = null;   /* مسار ملف نتيجة الاختبار الذاتي إن طُلب */
let selftestRunning = false;

/* ============================================================
   مسارات التخزين
   ============================================================ */

function dataDir() {
    return path.join(app.getPath('userData'), DATA_DIR_NAME);
}

function leavesDir() {
    return path.join(dataDir(), LEAVES_DIR_NAME);
}

function defaultBackupsDir() {
    return path.join(app.getPath('userData'), BACKUPS_DIR_NAME);
}

function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (err) {
        console.error('[ADMH] تعذّر إنشاء المجلد:', dir, err && err.message);
        return false;
    }
}

/* ============================================================
   أدوات ملفات عامة — كلها لا ترمي أخطاءً
   ============================================================ */

function existsFile(p) {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; }
}

function readTextFile(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function readJsonFile(p) {
    try {
        const txt = fs.readFileSync(p, 'utf8');
        if (!txt) return null;
        return JSON.parse(txt);
    } catch (e) {
        return null;
    }
}

function toInt(v, fallback, min, max) {
    const n = parseInt(v, 10);
    if (!isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

/** سنة السجل من fromDate (YYYY-MM-DD) — 'unknown' عند غياب تاريخ صالح */
function yearOf(value) {
    const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(value || ''));
    return m ? m[1] : '';
}

/* ============================================================
   الكتابة الذرّية
   ------------------------------------------------------------
   الخطوات: كتابة <name>.tmp ثم نقل النسخة السليمة السابقة إلى
   <name>.prev.json ثم rename فوق الهدف. بهذا لا يبقى ملف نصف مكتوب
   أبداً حتى لو انقطع التيار في منتصف العملية.
   ============================================================ */

function atomicWriteJson(filePath, obj) {
    const tmp = filePath + '.tmp';
    const prev = filePath.replace(/\.json$/i, '') + '.prev.json';
    const text = JSON.stringify(obj, null, 2);

    ensureDir(path.dirname(filePath));

    /* 1) الكتابة المؤقتة كاملة أولاً */
    fs.writeFileSync(tmp, text, 'utf8');

    /* 2) نحفظ النسخة السابقة قبل الاستبدال */
    if (existsFile(filePath)) {
        try {
            fs.renameSync(filePath, prev);
        } catch (e) {
            /* فشل النقل لا يمنع الكتابة، لكنه يُسجَّل */
            console.error('[ADMH] تعذّر حفظ النسخة السابقة:', prev, e && e.message);
        }
    }

    /* 3) الاستبدال الذرّي */
    fs.renameSync(tmp, filePath);
    return true;
}

/** يحذف ملفاً إن وُجد بلا رمي خطأ */
function removeFileQuiet(p) {
    try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return true;
    } catch (e) {
        return false;
    }
}

/* ============================================================
   الإجازات — ملف لكل سنة + فهرس السنوات
   ============================================================ */

/** يقرأ فهرس السنوات الحالي (مصفوفة نصوص) */
function readLeavesIndex() {
    const idx = readJsonFile(path.join(dataDir(), LEAVES_INDEX_FILE));
    if (!Array.isArray(idx)) return [];
    return idx.map(function (y) { return String(y).trim(); }).filter(Boolean);
}

/** يقرأ كل ملفات الإجازات مجتمعة (يعتمد الفهرس، ثم يتتبّع الملفات كاحتياط) */
function readAllLeaves() {
    const dir = leavesDir();
    const out = [];

    let years = readLeavesIndex();
    if (!years.length) {
        /* احتياط: لا فهرس (مجلد قادم من نسخة قديمة) — نستنتج السنوات من الأسماء */
        try {
            years = fs.readdirSync(dir)
                .map(function (f) { return /^leaves-(.+)\.json$/.exec(f); })
                .filter(Boolean)
                .map(function (m) { return m[1]; });
        } catch (e) {
            years = [];
        }
    }

    years.forEach(function (y) {
        const arr = readJsonFile(path.join(dir, 'leaves-' + y + '.json'));
        if (Array.isArray(arr)) {
            for (let i = 0; i < arr.length; i++) out.push(arr[i]);
        }
    });

    return out;
}

/**
 * كتابة الإجازات مُقسّمة على ملفات السنوات.
 * أي سنة لم تعد تحمل سجلات يُحذف ملفها، ويُحدَّث leaves-index.json.
 */
function writeLeaves(leaves) {
    const dir = leavesDir();
    ensureDir(dir);

    const byYear = {};
    (Array.isArray(leaves) ? leaves : []).forEach(function (rec) {
        const y = yearOf(rec && rec.fromDate) || 'unknown';
        (byYear[y] = byYear[y] || []).push(rec);
    });

    const prevYears = readLeavesIndex();
    const newYears = Object.keys(byYear).sort();

    /* 1) كتابة/استبدال ملفات السنوات الحالية */
    newYears.forEach(function (y) {
        atomicWriteJson(path.join(dir, 'leaves-' + y + '.json'), byYear[y]);
    });

    /* 2) حذف ملفات السنوات التي لم تعد موجودة */
    prevYears.forEach(function (y) {
        if (newYears.indexOf(y) === -1) {
            removeFileQuiet(path.join(dir, 'leaves-' + y + '.json'));
        }
    });

    /* 3) الفهرس يُكتب في مجلد البيانات الرئيسي (مثل نسخة الويب) */
    atomicWriteJson(path.join(dataDir(), LEAVES_INDEX_FILE), newYears);
    return true;
}

/* ============================================================
   قراءة/كتابة الوثائق
   ============================================================ */

/**
 * يقرأ كل الوثائق ويعيد كائناً واحداً بالشكل الذي تتوقّعه الواجهة.
 * يعيد null إذا لم يوجد settings.json (أي لا بيانات محفوظة بعد).
 */
/**
 * اسم ملف مشتق لمفتاح غير معروف في FILE_MAP.
 * يمنع فقدان بيانات مستند جديد أضافه المطوّر في constants.js و store.js
 * ونسي إضافته هنا. التنقية صارمة فلا يمكن الخروج من مجلد البيانات.
 */
function derivedDocName(key) {
    const k = String(key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) return null;
    return k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '.json';
}

/** العكس: اسم ملف → مفتاح camelCase (للمستندات غير المعروفة فقط) */
function derivedDocKey(fileName) {
    const base = String(fileName || '').replace(/\.json$/i, '');
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(base)) return null;
    return base.replace(/-([a-z0-9])/g, function (m, ch) { return ch.toUpperCase(); });
}

/** الملفات المحجوزة التي ليست مستندات */
const INTERNAL_FILES = ['leaves-index.json', 'backup-folder.txt'];

function readAllDocs() {
    const dir = dataDir();
    if (!existsFile(path.join(dir, FILE_MAP.settings))) return null;

    const out = {
        settings: readJsonFile(path.join(dir, FILE_MAP.settings)),
        leaveTypes: readJsonFile(path.join(dir, FILE_MAP.leaveTypes)),
        departments: readJsonFile(path.join(dir, FILE_MAP.departments)),
        staff: readJsonFile(path.join(dir, FILE_MAP.staff)),
        holidays: readJsonFile(path.join(dir, FILE_MAP.holidays)),
        compensations: readJsonFile(path.join(dir, FILE_MAP.compensations)),
        audit: readJsonFile(path.join(dir, FILE_MAP.audit)),
        meta: readJsonFile(path.join(dir, META_FILE)),
        leaves: readAllLeaves()
    };

    /* مستندات أضافها تحديث جديد ولم تُدرج في FILE_MAP بعد — نقرأها أيضاً
       حتى لا يعتبرها التطبيق فارغة فيعيد إنشاءها ويمحو محتواها. */
    try {
        const known = Object.keys(FILE_MAP).map(function (k) { return FILE_MAP[k]; })
            .concat([META_FILE]).concat(INTERNAL_FILES);
        fs.readdirSync(dir).forEach(function (name) {
            if (!/\.json$/i.test(name)) return;
            if (/\.prev\.json$/i.test(name) || /\.tmp$/i.test(name)) return;
            if (known.indexOf(name) !== -1) return;
            const key = derivedDocKey(name);
            if (!key || out[key] !== undefined) return;
            out[key] = readJsonFile(path.join(dir, name));
            console.warn('[ADMH] مستند غير مُدرج في FILE_MAP: ' + name + ' → ' + key +
                ' (أضِفه إلى FILE_MAP و DOC_KEYS لتثبيت اسمه)');
        });
    } catch (e) { /* تجاهل */ }

    /* تنظيف: المفاتيح الغائبة تُعاد فارغة لا null حتى لا تتعطّل الوحدات */
    out.leaveTypes = Array.isArray(out.leaveTypes) ? out.leaveTypes : [];
    out.departments = Array.isArray(out.departments) ? out.departments : [];
    out.staff = Array.isArray(out.staff) ? out.staff : [];
    out.holidays = Array.isArray(out.holidays) ? out.holidays : [];
    out.compensations = Array.isArray(out.compensations) ? out.compensations : [];
    out.audit = Array.isArray(out.audit) ? out.audit : [];
    out.settings = (out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings))
        ? out.settings : {};
    out.meta = (out.meta && typeof out.meta === 'object' && !Array.isArray(out.meta))
        ? out.meta : {};
    out.leaves = Array.isArray(out.leaves) ? out.leaves : [];

    return out;
}

/** يكتب وثيقة واحدة باسم ملفها المطابق */
function writeDocFile(key, value) {
    const k = String(key || '').trim();

    if (k === 'leaves') return writeLeaves(value);

    const fileName = FILE_MAP[k] || derivedDocName(k);
    if (!fileName) {
        console.error('[ADMH] مفتاح وثيقة غير صالح:', k);
        return false;
    }
    if (!FILE_MAP[k]) {
        console.warn('[ADMH] مفتاح غير مُدرج في FILE_MAP: ' + k + ' → ' + fileName +
            ' — أضِفه إلى FILE_MAP و DOC_KEYS لتثبيت اسم ملفه.');
    }

    ensureDir(dataDir());
    atomicWriteJson(path.join(dataDir(), fileName), value);
    return true;
}

/** يكتب كل الوثائق — الإجازات تُقسَّم على ملفات السنوات */
function writeAllDocs(docs) {
    if (!docs || typeof docs !== 'object') return false;

    ensureDir(dataDir());

    /* meta ليست ضمن مفاتيح الواجهة المعروفة لكنها مفيدة؛ تُكتب إن وُجدت */
    const keys = DOC_KEYS.concat(Object.keys(docs).filter(function (k) {
        return DOC_KEYS.indexOf(k) === -1 && k !== 'leaves';
    }));

    let ok = true;
    keys.forEach(function (k) {
        if (docs[k] === undefined) return;      /* لا نمحو وثيقة لم تُمرَّر */
        if (k === 'leaves') return;             /* تُعالَج في النهاية */
        if (!writeDocFile(k, docs[k])) ok = false;
    });

    /* الإجازات آخراً: ملف settings.json يُكتب أولاً فيبقى دليلاً على وجود بيانات */
    if (docs.leaves !== undefined) {
        if (!writeLeaves(docs.leaves)) ok = false;
    }

    return ok;
}

/* ============================================================
   مجلد النسخ الاحتياطية
   ============================================================ */

/** يقرأ المجلد المحفوظ من ملف صغير داخل مجلد البيانات */
function savedBackupFolder() {
    const txt = readTextFile(path.join(dataDir(), BACKUP_FOLDER_FILE));
    if (!txt) return '';
    return String(txt).replace(/^\uFEFF/, '').trim();
}

function backupFolder() {
    const saved = savedBackupFolder();
    return saved || defaultBackupsDir();
}

/** يثبّت المجلد ويحفظه ليبقى بعد إعادة التشغيل */
function persistBackupFolder(dir) {
    const d = String(dir || '').trim();
    if (!d) return false;
    if (!ensureDir(d)) return false;

    ensureDir(dataDir());
    try {
        fs.writeFileSync(path.join(dataDir(), BACKUP_FOLDER_FILE), d, 'utf8');
    } catch (err) {
        console.error('[ADMH] تعذّر حفظ مسار النسخ الاحتياطية', err && err.message);
        return false;
    }

    return true;
}

/* اسم نسخة احتياطية بصيغة snapshot-YYYY-MM-DD_HHMM.json مع تفادي التكرار */
function backupFileName(now) {
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
        '_' + pad(now.getHours()) + pad(now.getMinutes());
    const base = 'snapshot-' + stamp;
    const dir = backupFolder();

    let name = base + '.json';
    let i = 2;
    while (existsFile(path.join(dir, name))) {
        name = base + '_' + i + '.json';
        i++;
        if (i > 200) break;      /* حماية من حلقة لا نهائية */
    }
    return name;
}

/** ملفات النسخ الحقيقية فقط — تُستثنى ملفات .prev.json الداخلية */
function isSnapshotName(name) {
    return /^snapshot-.*\.json$/.test(name) && !/\.prev\.json$/.test(name);
}

/** يُبقي أحدث MAX_BACKUPS نسخة فقط */
function rotateBackups(dir) {
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(isSnapshotName).sort();
    } catch (e) {
        return;
    }
    const excess = files.length - MAX_BACKUPS;
    for (let i = 0; i < excess; i++) {
        removeFileQuiet(path.join(dir, files[i]));
    }
}

/* ============================================================
   ملف تنصيب NSIS — install-config.txt
   ------------------------------------------------------------
   الترميز UTF-16LE مع BOM (FF FE)، والقيم عربية. نكتشف الـ BOM
   ولا نفترض utf8 أبداً. يُطبَّق مرة واحدة لكل تنصيب عبر ملف
   <userData>/install-config.applied.
   ============================================================ */

/** يفكّ نص الملف بحسب BOM: FF FE → utf16le ، غير ذلك → utf8 */
function decodeInstallConfig(buf) {
    if (!buf || !buf.length) return '';
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        /* نتجاهل أول بايتين (BOM) ونفكّ الباقي كـ UTF-16LE */
        return buf.slice(2).toString('utf16le');
    }
    return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** يبحث عن ملف التنصيب في مجلد الـ exe ثم في مجلد الموارد */
function findInstallConfig() {
    const candidates = [
        path.join(path.dirname(process.execPath), INSTALL_CONFIG_FILE),
        path.join(process.resourcesPath || '', INSTALL_CONFIG_FILE),
        path.join(app.getAppPath(), INSTALL_CONFIG_FILE)
    ];
    for (let i = 0; i < candidates.length; i++) {
        if (candidates[i] && existsFile(candidates[i])) return candidates[i];
    }
    return null;
}

/** يحلّل الملف: سطر لكل مفتاح=قيمة، والتقسيم على أول = فقط */
function parseInstallConfig(text) {
    const out = {};
    const lines = String(text || '').split(/\r\n|\r|\n/);

    lines.forEach(function (line) {
        if (!line) return;
        const raw = line.replace(/^\uFEFF/, '');
        const eq = raw.indexOf('=');
        if (eq <= 0) return;                       /* سطر بلا = أو يبدأ بـ = : نتجاهله */

        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        if (INSTALL_KEYS.indexOf(key) === -1) return;

        out[key] = value;
    });

    return out;
}

/* ============================================================
   معالجات IPC — كلها مُغلَّفة بقيمة آمنة عند الفشل
   ============================================================ */

/** يغلّف معالجاً غير متزامن: أي رمي → قيمة آمنة + تسجيل */
function safeHandle(channel, fallback, fn) {
    ipcMain.handle(channel, async function (event, ...args) {
        try {
            const out = await fn(...args);
            return out === undefined ? fallback : out;
        } catch (err) {
            console.error('[ADMH] فشل المعالج', channel, err && err.stack ? err.stack : err);
            return fallback;
        }
    });
}

function registerHandlers() {
    safeHandle(CH.appVersion, '1.0.0', function () {
        return app.getVersion();
    });

    safeHandle(CH.paths, { data: '', backups: '' }, function () {
        ensureDir(dataDir());
        return { data: dataDir(), backups: backupFolder() };
    });

    safeHandle(CH.readAll, null, function () {
        return readAllDocs();
    });

    safeHandle(CH.writeAll, false, function (docs) {
        return writeAllDocs(docs);
    });

    safeHandle(CH.writeDoc, false, function (key, value) {
        return writeDocFile(key, value);
    });

    safeHandle(CH.chooseBackupFolder, null, async function () {
        const res = await dialog.showOpenDialog(mainWindow || undefined, {
            title: 'اختر مجلد النسخ الاحتياطية',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: backupFolder()
        });
        if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return null;

        const dir = res.filePaths[0];
        persistBackupFolder(dir);
        return dir;
    });

    safeHandle(CH.setBackupFolder, false, function (dir) {
        const d = String(dir || '').trim();
        if (!d) return false;
        /* نتحقق من القابلية للكتابة قبل الادّعاء بالنجاح */
        try {
            ensureDir(d);
            fs.accessSync(d, fs.constants.W_OK);
        } catch (err) {
            console.error('[ADMH] مجلد نسخ غير قابل للكتابة:', d);
            return false;
        }
        return persistBackupFolder(d);
    });

    safeHandle(CH.getBackupFolder, '', function () {
        return backupFolder();
    });

    safeHandle(CH.writeBackup, null, function (payload) {
        /* المجلد غير متاح (قرص USB مُزال مثلاً): نعيد null ولا نرمي */
        const dir = backupFolder();
        try {
            ensureDir(dir);
            fs.accessSync(dir, fs.constants.W_OK);
        } catch (err) {
            console.error('[ADMH] مجلد النسخ الاحتياطية غير متاح:', dir);
            return null;
        }

        let name;
        try {
            name = backupFileName(new Date());
            atomicWriteJson(path.join(dir, name), payload);
        } catch (err) {
            console.error('[ADMH] فشل كتابة النسخة الاحتياطية:', err && err.message);
            return null;
        }

        try { rotateBackups(dir); } catch (e) { /* التدوير ليس حرجاً */ }
        return name;
    });

    safeHandle(CH.listBackups, [], function () {
        const dir = backupFolder();
        try {
            return fs.readdirSync(dir).filter(isSnapshotName).sort().reverse();
        } catch (e) {
            return [];
        }
    });

    safeHandle(CH.readBackup, null, function (name) {
        const n = String(name || '');
        /* حماية من الخروج من المجلد: الاسم يجب أن يطابق نمط النسخ فقط */
        if (!isSnapshotName(n) || n.indexOf('/') !== -1 || n.indexOf('\\') !== -1) return null;
        return readJsonFile(path.join(backupFolder(), n));
    });

    safeHandle(CH.openFolder, false, async function (which) {
        const w = String(which || 'data');
        const dir = (w === 'backups') ? backupFolder() : dataDir();
        ensureDir(dir);
        const err = await shell.openPath(dir);
        if (err) {
            console.error('[ADMH] تعذّر فتح المجلد:', dir, err);
            return false;
        }
        return true;
    });

    safeHandle(CH.takeInstallConfig, null, function () {
        /* مرة واحدة لكل تنصيب */
        if (existsFile(path.join(app.getPath('userData'), INSTALL_APPLIED_FILE))) return null;

        const file = findInstallConfig();
        if (!file) return null;

        let text = '';
        try {
            text = decodeInstallConfig(fs.readFileSync(file));
        } catch (err) {
            console.error('[ADMH] تعذّر قراءة ملف التنصيب:', err && err.message);
            return null;
        }

        const parsed = parseInstallConfig(text);
        if (!Object.keys(parsed).length) return null;

        /* نطبع المفاتيح فقط بلا قيم حساسة */
        console.log('[ADMH] ملف تنصيب مقروء من:', file, '| المفاتيح:', Object.keys(parsed).join(', '));

        /* وسم التطبيق — لا يُعاد التسليم بعده أبداً */
        try {
            ensureDir(app.getPath('userData'));
            fs.writeFileSync(path.join(app.getPath('userData'), INSTALL_APPLIED_FILE),
                JSON.stringify({ appliedAt: new Date().toISOString(), source: path.basename(file) }, null, 2),
                'utf8');
        } catch (err) {
            console.error('[ADMH] تعذّر وسم ملف التنصيب كمُطبَّق:', err && err.message);
        }

        return parsed;
    });

    /* quit أمر بلا رد (send) — نسجّله كمعالج حدث لا كـ handle */
    ipcMain.on(CH.quit, function () {
        try { app.quit(); } catch (e) { /* تجاهل */ }
    });
}

/* ============================================================
   النافذة
   ============================================================ */

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        show: false,
        title: WINDOW_TITLE,
        autoHideMenuBar: true,
        backgroundColor: '#f1f5f9',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            /* مهم لمحرّك الطباعة: القياس يجب أن يعمل حتى لو كانت النافذة خلفية */
            backgroundThrottling: false,
            spellcheck: false
        }
    });

    mainWindow.once('ready-to-show', function () {
        try { mainWindow.show(); } catch (e) { /* تجاهل */ }
    });

    mainWindow.on('closed', function () { mainWindow = null; });

    /* لا نسمح بأي تنقّل خارج ملفات التطبيق */
    mainWindow.webContents.on('will-navigate', function (event, url) {
        if (!/^file:\/\//i.test(String(url || ''))) {
            event.preventDefault();
        }
    });

    /* ولا بفتح نوافذ جديدة: الروابط الخارجية تُفتح في متصفح النظام */
    mainWindow.webContents.setWindowOpenHandler(function (details) {
        const url = String((details && details.url) || '');
        if (/^https?:\/\//i.test(url)) {
            try { shell.openExternal(url); } catch (e) { /* تجاهل */ }
        }
        return { action: 'deny' };
    });

    /* لا حاجة لأي إذن متصفح في تطبيق مكتبي */
    try {
        mainWindow.webContents.session.setPermissionRequestHandler(function (wc, permission, callback) {
            callback(false);
        });
    } catch (e) { /* متاح في كل الإصدارات المدعومة — نتجاهل الفشل */ }

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    return mainWindow;
}

function focusMainWindow() {
    if (!mainWindow) {
        createWindow();
        return;
    }
    try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    } catch (e) { /* تجاهل */ }
}

/* ============================================================
   وضع الاختبار الذاتي
   ------------------------------------------------------------
   عند وجود --selftest=<path> ننتظر جاهزية الواجهة، نُنفّذ فحوصاً
   مكتوبة، نكتب النتيجة JSON في الملف ثم نُغلق. لا يعمل في الاستعمال
   العادي إطلاقاً.
   ============================================================ */

function readSelftestArg(argv) {
    const list = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < list.length; i++) {
        const a = String(list[i] || '');
        if (a.indexOf('--selftest=') === 0) return a.slice('--selftest='.length);
    }
    return null;
}

/** كود الاختبار الذي يُنفَّذ داخل الواجهة ويعيد كائناً قابلاً للتسلسل */
function selftestScript() {
    return `(async function () {
  var result = {
    electronAvailable: false,
    backend: null,
    dataDir: null,
    backupFolder: null,
    roundTripOk: false,
    printEngine: false,
    pageCount: 0,
    errors: []
  };

  var probeId = 'selftest-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  /* التقاط أي خطأ في الواجهة أثناء الفحص */
  window.addEventListener('error', function (e) {
    try { result.errors.push(String((e && e.message) || 'error')); } catch (x) { }
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      result.errors.push('unhandledrejection: ' + String((r && r.message) || r || ''));
    } catch (x) { }
  });

  try { result.electronAvailable = !!(window.App && App.Electron && App.Electron.available()); } catch (e) { }

  try {
    if (window.App && App.Store && typeof App.Store.backend === 'function') {
      result.backend = App.Store.backend();
    }
  } catch (e) { }

  try {
    if (window.App && App.Electron && App.Electron.paths) {
      var p = await App.Electron.paths();
      if (p) { result.dataDir = p.data || null; result.backupFolder = p.backups || null; }
    }
  } catch (e) { }

  /* فحص الذهاب والإياب: نكتب وثيقة اختبار عبر Store ثم نقرأها من القرص */
  try {
    var audit = App.Store.get.audit();
    if (Array.isArray(audit) && typeof App.Store.save === 'function') {
      audit.push({
        id: probeId,
        at: new Date().toISOString(),
        action: 'system',
        entity: 'selftest',
        label: 'فحص ذاتي آلي',
        user: 'selftest'
      });
      await App.Store.save(['audit']);
      if (typeof App.Store.flush === 'function') { await App.Store.flush(); }
      await new Promise(function (r) { setTimeout(r, 900); });

      var docs = await App.Electron.readAll();
      if (docs && Array.isArray(docs.audit)) {
        result.roundTripOk = docs.audit.some(function (r) { return r && r.id === probeId; });
      }

      /* تنظيف: نُزيل سجل الفحص ونكتب مرة أخرى */
      var idx = audit.findIndex(function (r) { return r && r.id === probeId; });
      if (idx !== -1) audit.splice(idx, 1);
      await App.Store.save(['audit']);
      if (typeof App.Store.flush === 'function') { await App.Store.flush(); }
    }
  } catch (e) {
    result.errors.push('roundTrip: ' + String((e && e.message) || e));
  }

  /* محرّك الطباعة: التوافر ثم ترقيم مستند صغير */
  try {
    if (App.PrintLayout && typeof App.PrintLayout.available === 'function') {
      result.printEngine = !!App.PrintLayout.available();
    }
    if (App.PrintLayout && typeof App.PrintLayout.paginate === 'function') {
      var tmp = document.createElement('div');
      tmp.setAttribute('data-selftest', '1');
      tmp.innerHTML =
        '<div data-print-header><h2>موقف الإجازات اليومي</h2><p data-print-pageno></p></div>' +
        '<table class="print-table"><thead><tr><th>ت</th><th>الاسم</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>اختبار</td></tr>' +
        '<tr><td>2</td><td>اختبار</td></tr></tbody></table>';
      document.body.appendChild(tmp);

      var res = await App.PrintLayout.paginate(tmp, {});
      result.pageCount = (res && res.total) ? res.total : 0;

      try { App.PrintLayout.cleanup(); } catch (e2) { }
      if (tmp.parentNode) tmp.parentNode.removeChild(tmp);
    }
  } catch (e) {
    result.errors.push('print: ' + String((e && e.message) || e));
  }

  /* ملخّص النجاح كما يقرأه المشغّل الآلي */
  result.ok = !!(result.electronAvailable && result.roundTripOk && result.pageCount >= 1);

  try { document.title = 'SELFTEST-DONE'; } catch (e) { }
  return result;
})()`;
}

/** ينتظر جاهزية App.Store.isReady() بحلقة استقصاء داخل الواجهة */
async function waitForRendererReady(win, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!win || win.isDestroyed()) return false;
        let ready = false;
        try {
            ready = await win.webContents.executeJavaScript(
                '!!(window.App && App.Store && typeof App.Store.isReady === "function" && App.Store.isReady())',
                true);
        } catch (e) {
            ready = false;
        }
        if (ready) return true;
        await new Promise(function (r) { setTimeout(r, 300); });
    }
    return false;
}

/** يكتب نتيجة الاختبار ثم يغلق التطبيق */
function finishSelftest(outPath, result, code) {
    try {
        let text;
        try { text = JSON.stringify(result, null, 2); }
        catch (e) { text = JSON.stringify({ ok: false, error: 'unserializable-result' }); }
        fs.writeFileSync(outPath, text, 'utf8');
    } catch (err) {
        console.error('[ADMH] تعذّر كتابة نتيجة الاختبار الذاتي:', err && err.message);
    }
    try { app.exit(code); } catch (e) { app.quit(); }
}

async function runSelftest(win, outPath) {
    const result = {
        ok: false,
        electronAvailable: false,
        backend: null,
        dataDir: null,
        backupFolder: null,
        roundTripOk: false,
        printEngine: false,
        pageCount: 0,
        errors: [],
        ready: false
    };

    try {
        result.ready = await waitForRendererReady(win, SELFTEST_TIMEOUT_MS);
        if (!result.ready) {
            result.errors.push('renderer-not-ready');
            finishSelftest(outPath, result, 1);
            return;
        }

        let out = null;
        try {
            out = await win.webContents.executeJavaScript(selftestScript(), true);
        } catch (err) {
            result.errors.push('script: ' + String((err && err.message) || err));
        }

        if (out && typeof out === 'object') {
            Object.keys(result).forEach(function (k) {
                if (out[k] !== undefined) result[k] = out[k];
            });
        }

        /* النجاح = الجسر متاح + الذهاب والإياب نجح + ترقيم صفحات صحيح */
        result.ok = !!(result.electronAvailable && result.roundTripOk && result.pageCount >= 1);
        finishSelftest(outPath, result, result.ok ? 0 : 1);
    } catch (err) {
        result.errors.push('selftest: ' + String((err && err.message) || err));
        finishSelftest(outPath, result, 1);
    }
}

/* ============================================================
   دورة حياة التطبيق
   ============================================================ */

/* نافذة واحدة فقط: تشغيل ثانٍ = كاتبان على الملفات نفسها = فقدان بيانات */
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    selftestPath = readSelftestArg(process.argv);

    app.on('second-instance', function () {
        focusMainWindow();
    });

    app.on('window-all-closed', function () {
        /* على ويندوز: الإغلاق التام. وضع الاختبار الذاتي يُغلق نفسه. */
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.whenReady().then(function () {
        /* مجلد البيانات يُنشأ عند الطلب (on demand) لا هنا،
           لكن نضمن وجوده مرة واحدة ليسهل فتحه من الإعدادات. */
        try { ensureDir(dataDir()); } catch (e) { /* تجاهل */ }

        registerHandlers();

        const win = createWindow();

        if (selftestPath) {
            selftestRunning = true;
            win.webContents.once('did-finish-load', function () {
                runSelftest(win, selftestPath);
            });
        }
    }).catch(function (err) {
        console.error('[ADMH] فشل تهيئة التطبيق', err);
    });
}

/* لا نُسقط التطبيق بسبب خطأ غير مُلتقَط */
process.on('uncaughtException', function (err) {
    console.error('[ADMH] خطأ غير مُلتقَط في النواة:', err && err.stack ? err.stack : err);
});
