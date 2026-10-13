/* ============================================================
   preload.js — الجسر الآمن بين الواجهة (renderer) ونواة Electron
   ------------------------------------------------------------
   يُحمَّل في سياق معزول (contextIsolation: true) ولا يمنح الصفحة
   أي وصول إلى Node.js. كل ما تفعله الواجهة هو استدعاء دوال IPC
   معلومة الأسماء عبر window.ADMH.

   لا تُضاف هنا أي دالة تقرأ أو تكتب ملفاً بنفسها: كل المنطق في
   main.js، وهذه الطبقة مجرّد غلاف رقيق (thin wrapper).

   ملاحظة: القنوات (channels) ثابتة في هذه القائمة، فلا يمكن
   للواجهة استدعاء قناة عشوائية عبر invoke.
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* ---------- قنوات IPC المسموح بها صراحةً ---------- */
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

/* ---------- حرّاس القيم ---------- */

/** لا نمرّر إلى النواة إلا كائناً فعلياً — يمنع تمرير دوال أو undefined */
function plain(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return fallback;
    }
}

/**
 * استدعاء آمن لقناة IPC: أي فشل يعيد القيمة الافتراضية
 * ولا يرمي خطأً داخل الواجهة أبداً.
 */
function safeInvoke(channel, args, fallback) {
    try {
        return ipcRenderer.invoke(channel, ...args)
            .then(function (v) { return v === undefined ? fallback : v; })
            .catch(function (err) {
                console.error('[ADMH] فشل نداء IPC:', channel, err && err.message ? err.message : err);
                return fallback;
            });
    } catch (err) {
        console.error('[ADMH] تعذّر إرسال نداء IPC:', channel, err && err.message ? err.message : err);
        return Promise.resolve(fallback);
    }
}

/* ---------- الواجهة المكشوفة للصفحة ----------

   العقد المتفق عليه مع src/js/core/electron.js (والنسخة الاحتياطية):

   App.Electron = {
     available(): boolean,
     appVersion: string,
     paths(): Promise<{data, backups}>,
     readAll(): Promise<object|null>,
     writeAll(docs): Promise<boolean>,
     writeDoc(key, value): Promise<boolean>,
     chooseBackupFolder(): Promise<string|null>,
     setBackupFolder(dir): Promise<boolean>,
     getBackupFolder(): Promise<string>,
     writeBackup(payload): Promise<string|null>,
     listBackups(): Promise<string[]>,
     readBackup(name): Promise<object|null>,
     openFolder(which): Promise<boolean>,
     takeInstallConfig(): Promise<object|null>,
     quit(): void
   }
   ------------------------------------------------------------ */

const ADMH = {
    /* إصدار التطبيق كما تراه النواة (متزامن خارج Electron الحقيقي) */
    appVersion: '1.0.0',

    paths: function () {
        return safeInvoke(CH.paths, [], null);
    },

    readAll: function () {
        return safeInvoke(CH.readAll, [], null);
    },

    writeAll: function (docs) {
        return safeInvoke(CH.writeAll, [plain(docs, {})], false);
    },

    writeDoc: function (key, value) {
        return safeInvoke(CH.writeDoc, [String(key || ''), plain(value, null)], false);
    },

    chooseBackupFolder: function () {
        return safeInvoke(CH.chooseBackupFolder, [], null);
    },

    setBackupFolder: function (dir) {
        return safeInvoke(CH.setBackupFolder, [String(dir || '')], false);
    },

    getBackupFolder: function () {
        return safeInvoke(CH.getBackupFolder, [], '');
    },

    writeBackup: function (payload) {
        return safeInvoke(CH.writeBackup, [plain(payload, null)], null);
    },

    listBackups: function () {
        return safeInvoke(CH.listBackups, [], []);
    },

    readBackup: function (name) {
        return safeInvoke(CH.readBackup, [String(name || '')], null);
    },

    openFolder: function (which) {
        return safeInvoke(CH.openFolder, [String(which || 'data')], false);
    },

    takeInstallConfig: function () {
        return safeInvoke(CH.takeInstallConfig, [], null);
    },

    quit: function () {
        try {
            ipcRenderer.send(CH.quit);
        } catch (err) {
            console.error('[ADMH] تعذّر إرسال أمر الإغلاق', err);
        }
    }
};

/**
 * إصدار التطبيق.
 *
 * مهم: contextBridge ينسخ القيم غير الدالية ويجمّدها لحظة الكشف، فأي
 * تحديث لاحق لـ ADMH.appVersion لا يصل إلى الواجهة إطلاقاً. لذلك نحسم
 * القيمة هنا قبل الكشف: نقرأها من package.json الخاص بالمشروع إن وُجد،
 * وإلا نستعمل الإصدار الافتراضي. (قناة admh:app-version تبقى متاحة
 * كمسار احتياطي للمنادين الذين يريدون إصدار النواة نفسه.)
 */
function resolveAppVersion() {
    try {
        const fs = require('fs');
        const path = require('path');
        const root = (app && typeof app.getAppPath === 'function') ? app.getAppPath() : __dirname;
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch (err) {
        /* لا package.json أو غير مقروء — نكمل بالافتراضي */
    }
    return '1.0.0';
}

ADMH.appVersion = resolveAppVersion();

try {
    contextBridge.exposeInMainWorld('ADMH', ADMH);
} catch (err) {
    console.error('[ADMH] تعذّر كشف الجسر في الواجهة', err);
}
