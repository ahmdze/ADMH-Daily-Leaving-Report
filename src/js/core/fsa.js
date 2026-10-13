/* ============================================================
   واجهة الوصول لنظام الملفات (File System Access API)
   متاحة في Chrome و Edge فقط. في Firefox يعمل النظام عبر
   IndexedDB + التصدير/الاستيراد اليدوي.
   ============================================================ */
window.App = window.App || {};

App.FSA = (function () {
    'use strict';

    function supported() {
        try {
            return typeof window.showDirectoryPicker === 'function';
        } catch (e) {
            return false;
        }
    }

    /** يطلب من المستخدم اختيار مجلد البيانات */
    function pickDirectory(opts) {
        if (!supported()) {
            return Promise.reject(new Error('هذا المتصفح لا يدعم اختيار مجلد للحفظ. استخدم Chrome أو Edge.'));
        }
        opts = opts || {};
        return window.showDirectoryPicker({
            id: opts.id || 'admh-leaves-data',
            mode: opts.mode || 'readwrite',
            startIn: opts.startIn || 'documents'
        });
    }

    /** يتحقق من الإذن الحالي دون إظهار نافذة */
    function queryPermission(handle, mode) {
        if (!handle || typeof handle.queryPermission !== 'function') return Promise.resolve('granted');
        return handle.queryPermission({ mode: mode || 'readwrite' }).catch(function () { return 'denied'; });
    }

    /** يطلب الإذن (قد يُظهر نافذة للمستخدم) */
    function requestPermission(handle, mode) {
        if (!handle || typeof handle.requestPermission !== 'function') return Promise.resolve('granted');
        return handle.requestPermission({ mode: mode || 'readwrite' }).catch(function () { return 'denied'; });
    }

    function ensurePermission(handle, mode) {
        return queryPermission(handle, mode).then(function (state) {
            if (state === 'granted') return true;
            return requestPermission(handle, mode).then(function (s2) { return s2 === 'granted'; });
        });
    }

    /* ---------------- عمليات الملفات ---------------- */

    function getFileHandle(dir, name, create) {
        return dir.getFileHandle(name, { create: !!create });
    }

    function getSubDir(dir, name, create) {
        return dir.getDirectoryHandle(name, { create: !!create });
    }

    function writeText(dir, name, text) {
        return getFileHandle(dir, name, true).then(function (fh) {
            return fh.createWritable();
        }).then(function (w) {
            return w.write(text).then(function () { return w.close(); });
        });
    }

    function readText(dir, name) {
        return getFileHandle(dir, name, false).then(function (fh) {
            return fh.getFile();
        }).then(function (file) {
            return file.text();
        });
    }

    function exists(dir, name) {
        return getFileHandle(dir, name, false)
            .then(function () { return true; })
            .catch(function () { return false; });
    }

    function removeFile(dir, name) {
        if (typeof dir.removeEntry !== 'function') return Promise.resolve(false);
        return dir.removeEntry(name)
            .then(function () { return true; })
            .catch(function () { return false; });
    }

    function listFiles(dir) {
        var out = [];
        if (!dir || typeof dir.entries !== 'function') return Promise.resolve(out);
        var it = dir.entries();
        function step() {
            return it.next().then(function (res) {
                if (res.done) return out;
                if (res.value && res.value[1] && res.value[1].kind === 'file') {
                    out.push(res.value[0]);
                }
                return step();
            });
        }
        return step().catch(function () { return out; });
    }

    /**
     * كتابة JSON مع نسخة احتياطية دوّارة:
     * تُنقل النسخة السليمة السابقة إلى <name>.prev قبل الكتابة الجديدة.
     */
    function writeJSON(dir, name, obj) {
        var text = JSON.stringify(obj, null, 2);
        var prevName = name.replace(/\.json$/i, '') + '.prev.json';
        return readText(dir, name).then(function (old) {
            return writeText(dir, prevName, old).catch(function () { return null; });
        }).catch(function () {
            return null;
        }).then(function () {
            return writeText(dir, name, text);
        });
    }

    function readJSON(dir, name) {
        return readText(dir, name).then(function (txt) {
            if (!txt) return null;
            try { return JSON.parse(txt); } catch (e) { return null; }
        }).catch(function () { return null; });
    }

    return {
        supported: supported,
        pickDirectory: pickDirectory,
        queryPermission: queryPermission,
        requestPermission: requestPermission,
        ensurePermission: ensurePermission,
        getSubDir: getSubDir,
        writeText: writeText,
        readText: readText,
        writeJSON: writeJSON,
        readJSON: readJSON,
        exists: exists,
        removeFile: removeFile,
        listFiles: listFiles
    };
})();
