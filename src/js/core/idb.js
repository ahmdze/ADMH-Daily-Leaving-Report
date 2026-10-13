/* ============================================================
   غلاف IndexedDB — يخزّن كل وثيقة بيانات تحت مفتاح واحد.
   IndexedDB أوسع وأمتن من localStorage (لا حد 5 ميجابايت،
   ويقبل تخزين مقابض المجلدات FileSystemDirectoryHandle).
   ============================================================ */
window.App = window.App || {};

App.IDB = (function () {
    'use strict';

    var DB_NAME = 'admh_leaves_db';
    var DB_VERSION = 1;
    var STORE = 'docs';
    var _db = null;
    var _opening = null;

    function supported() {
        try {
            return typeof indexedDB !== 'undefined' && indexedDB !== null;
        } catch (e) {
            return false;
        }
    }

    function openDB() {
        if (_db) return Promise.resolve(_db);
        if (_opening) return _opening;

        _opening = new Promise(function (resolve, reject) {
            if (!supported()) {
                reject(new Error('IndexedDB غير مدعومة في هذا المتصفح'));
                return;
            }
            var req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                reject(e);
                return;
            }
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            req.onsuccess = function () {
                _db = req.result;
                _db.onversionchange = function () {
                    try { _db.close(); } catch (e) { }
                    _db = null;
                };
                resolve(_db);
            };
            req.onerror = function () { reject(req.error || new Error('فشل فتح قاعدة البيانات المحلية')); };
            req.onblocked = function () { reject(new Error('قاعدة البيانات المحلية مشغولة في نافذة أخرى')); };
        });

        _opening.catch(function () { _opening = null; });
        return _opening;
    }

    function run(mode, fn) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, mode);
                var store = t.objectStore(STORE);
                var out;
                try {
                    out = fn(store);
                } catch (e) {
                    reject(e);
                    return;
                }
                t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
                t.onerror = function () { reject(t.error); };
                t.onabort = function () { reject(t.error || new Error('أُلغيت العملية')); };
            });
        });
    }

    function get(key) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, 'readonly');
                var req = t.objectStore(STORE).get(key);
                req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function set(key, value) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).put(value, key);
                t.oncomplete = function () { resolve(true); };
                t.onerror = function () { reject(t.error); };
                t.onabort = function () { reject(t.error || new Error('فشل الحفظ المحلي')); };
            });
        });
    }

    function del(key) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).delete(key);
                t.oncomplete = function () { resolve(true); };
                t.onerror = function () { reject(t.error); };
            });
        });
    }

    function keys() {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, 'readonly');
                var req = t.objectStore(STORE).getAllKeys();
                req.onsuccess = function () { resolve(req.result || []); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function clear() {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).clear();
                t.oncomplete = function () { resolve(true); };
                t.onerror = function () { reject(t.error); };
            });
        });
    }

    return {
        supported: supported,
        get: get,
        set: set,
        del: del,
        keys: keys,
        clear: clear
    };
})();
