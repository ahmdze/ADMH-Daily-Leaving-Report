/* ============================================================
   جسر Electron في الواجهة — App.Electron
   ------------------------------------------------------------
   غلاف رقيق حول window.ADMH الذي يكشفه preload.js عبر
   contextBridge. الوظيفة الوحيدة هنا هي:
     1) إعطاء الوحدات واجهة واحدة ثابتة الأسماء.
     2) التأكد أن كل نداء آمن: في المتصفح العادي (file:// بلا
        Electron) يكون available() = false وكل الدوال تعيد قيماً
        محايدة بلا رمي أي خطأ، فلا يتغيّر أي مسار قائم في النظام.

   هذا ملف سكربت كلاسيكي (بلا ES modules) ويعرّف App.Electron فقط.
   ============================================================ */
window.App = window.App || {};

App.Electron = (function () {
    'use strict';

    /* الجسر المكشوف من preload.js — قد يكون غائباً تماماً في المتصفح */
    var bridge = null;
    try {
        bridge = (typeof window !== 'undefined' && window.ADMH) ? window.ADMH : null;
    } catch (e) {
        bridge = null;
    }

    /** هل يعمل النظام داخل Electron فعلاً؟ */
    function available() {
        try {
            return !!(bridge && typeof bridge.paths === 'function' && typeof bridge.writeAll === 'function');
        } catch (e) {
            return false;
        }
    }

    /**
     * نداء آمن: يتحقق من وجود الدالة ومن كونها دالة، ويعيد
     * القيمة الافتراضية عند أي فشل (بلا رمي).
     */
    function call(name, args, fallback) {
        try {
            if (!bridge || typeof bridge[name] !== 'function') {
                return Promise.resolve(fallback);
            }
            var out = bridge[name].apply(bridge, args || []);
            if (out && typeof out.then === 'function') {
                return out.then(function (v) {
                    return (v === undefined) ? fallback : v;
                }, function (err) {
                    console.error('[Electron] فشل نداء ' + name, err && err.message ? err.message : err);
                    return fallback;
                });
            }
            return Promise.resolve(out === undefined ? fallback : out);
        } catch (err) {
            console.error('[Electron] تعذّر تنفيذ ' + name, err && err.message ? err.message : err);
            return Promise.resolve(fallback);
        }
    }

    /* إصدار التطبيق — نص دائماً، ويُقرأ من الجسر إن توفّر */
    var appVersion = '1.0.0';
    try {
        if (bridge && typeof bridge.appVersion === 'string' && bridge.appVersion) {
            appVersion = bridge.appVersion;
        }
    } catch (e) {
        appVersion = '1.0.0';
    }

    return {
        available: available,

        appVersion: appVersion,

        /* مجلدات البيانات والنسخ الاحتياطية */
        paths: function () {
            return call('paths', [], null);
        },

        /* كل الوثائق دفعة واحدة، أو null إذا لا بيانات محفوظة بعد */
        readAll: function () {
            return call('readAll', [], null);
        },

        writeAll: function (docs) {
            return call('writeAll', [docs], false);
        },

        writeDoc: function (key, value) {
            return call('writeDoc', [key, value], false);
        },

        /* نوافذ اختيار المجلدات */
        chooseBackupFolder: function () {
            return call('chooseBackupFolder', [], null);
        },

        setBackupFolder: function (dir) {
            return call('setBackupFolder', [dir], false);
        },

        getBackupFolder: function () {
            return call('getBackupFolder', [], '');
        },

        /* النسخ الاحتياطية */
        writeBackup: function (payload) {
            return call('writeBackup', [payload], null);
        },

        listBackups: function () {
            return call('listBackups', [], []);
        },

        readBackup: function (name) {
            return call('readBackup', [name], null);
        },

        /* فتح مجلد في مستكشف الملفات: 'data' أو 'backups' */
        openFolder: function (which) {
            return call('openFolder', [which || 'data'], false);
        },

        /* إعدادات التنصيب — تُسلَّم مرة واحدة فقط لكل تنصيب */
        takeInstallConfig: function () {
            return call('takeInstallConfig', [], null);
        },

        /* إغلاق التطبيق */
        quit: function () {
            try {
                if (bridge && typeof bridge.quit === 'function') bridge.quit();
            } catch (err) {
                console.error('[Electron] تعذّر إغلاق التطبيق', err);
            }
        }
    };
})();
