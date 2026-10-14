/* ============================================================
   طبقة التخزين المركزية
   مصدر الحقيقة الوحيد في الذاكرة، مع كتابة إلى:
     1) IndexedDB  — دائماً (لا تحتاج إذناً)
     2) مجلد على القرص — إن ربطه المستخدم (Chrome/Edge)
   وعند التحويل لاحقاً إلى تطبيق .exe تُضاف واجهة ثالثة (IPC)
   دون تغيير أي وحدة من وحدات الواجهة.
   ============================================================ */
window.App = window.App || {};

App.Store = (function () {
    'use strict';

    const C = App.Constants;
    const IDB = App.IDB;
    const FSA = App.FSA;

    /* اسم ملف كل وثيقة داخل مجلد البيانات */
    const FILE_MAP = {
        settings: 'settings.json',
        leaveTypes: 'leave-types.json',
        departments: 'departments.json',
        staff: 'staff.json',
        holidays: 'holidays.json',
        compensations: 'compensations.json',
        audit: 'audit.json'
    };

    const HANDLE_KEY = '__dirHandle';
    const DIR_NAME = 'ADMH-Leaves-Data';

    /* ---------------- الحالة ---------------- */
    const state = {
        settings: {},
        leaveTypes: [],
        departments: [],
        staff: [],
        holidays: [],
        leaves: [],
        compensations: [],
        audit: [],
        meta: {}
    };

    const listeners = {};
    const writeTimers = {};
    let dirHandle = null;
    let connected = false;
    let backend = 'memory';
    let ready = false;
    let folderName = '';
    let dataPath = '';       /* مسار مجلد البيانات داخل Electron */
    let backupPath = '';     /* مسار مجلد النسخ الاحتياطي داخل Electron */

    /* ---------------- أدوات ---------------- */
    function nowIso() { return new Date().toISOString(); }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function normalizeName(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function on(evt, cb) {
        (listeners[evt] = listeners[evt] || []).push(cb);
        return function off() {
            listeners[evt] = (listeners[evt] || []).filter(f => f !== cb);
        };
    }

    function emit(evt, payload) {
        (listeners[evt] || []).slice().forEach(cb => {
            try { cb(payload); } catch (e) { console.error('[Store] listener error', e); }
        });
    }

    /* ============================================================
       الترحيل من النسخة القديمة
       ============================================================ */

    function migrateSettings(old) {
        const s = Object.assign({}, C.DEFAULT_SETTINGS, old || {});
        if (s.defaultStatus === undefined) s.defaultStatus = 'approved';
        if (s.countWeekend === undefined) s.countWeekend = true;
        if (s.holidayMode === undefined) s.holidayMode = 'inside';
        return s;
    }

    /** أنواع الإجازات: قد تأتي كمصفوفة نصوص أو كائنات */
    function migrateLeaveTypes(old) {
        if (!Array.isArray(old) || !old.length) return clone(C.DEFAULT_LEAVE_TYPES);
        return old.map((t, i) => {
            if (typeof t === 'string') {
                const known = C.DEFAULT_LEAVE_TYPES.find(d => d.name === t);
                if (known) return clone(known);
                return {
                    id: 'lt-mig-' + i + '-' + Date.now().toString(36),
                    name: t,
                    isHourly: /زمنية/.test(t),
                    deductsBalance: /اعتيادية/.test(t),
                    color: '#0284c7',
                    isActive: true
                };
            }
            return {
                id: t.id || C.uid('lt'),
                name: normalizeName(t.name),
                isHourly: !!t.isHourly,
                deductsBalance: t.deductsBalance !== false,
                color: t.color || '#0284c7',
                isActive: t.isActive !== false
            };
        });
    }

    /** الأقسام: قد تأتي {name, sections:[نصوص]} أو الشكل الجديد */
    function migrateDepartments(old) {
        if (!Array.isArray(old) || !old.length) return clone(C.DEFAULT_DEPARTMENTS);
        return old.map((d, i) => {
            if (typeof d === 'string') {
                return { id: 'd-mig-' + i, name: d, sections: [] };
            }
            return {
                id: d.id || 'd-mig-' + i + '-' + Date.now().toString(36),
                name: normalizeName(d.name),
                sections: (d.sections || []).map((s, j) => {
                    if (typeof s === 'string') {
                        return { id: (d.id || 'd-mig-' + i) + '-s' + j, name: normalizeName(s) };
                    }
                    return { id: s.id || 's-mig-' + i + '-' + j, name: normalizeName(s.name) };
                })
            };
        });
    }

    function migrateStaff(old) {
        if (!Array.isArray(old) || !old.length) return [];
        const out = [];
        const seen = {};
        old.forEach((p, i) => {
            if (!p) return;
            const name = normalizeName(p.name || p.empName);
            if (!name || seen[name]) return;
            seen[name] = true;
            out.push({
                id: p.id || C.uid('emp'),
                name: name,
                jobTitle: normalizeName(p.jobTitle || p.title),
                dept: normalizeName(p.dept),
                section: normalizeName(p.section),
                employeeNumber: normalizeName(p.employeeNumber),
                annualBalance: App.Security.toInt(p.annualBalance, C.DEFAULT_SETTINGS.defaultAnnualBalance, 0, 365),
                isActive: p.isActive !== false
            });
        });
        return out;
    }

    /** السجلات القديمة: نصوص مسطّحة بلا معرّفات */
    function migrateLeaves(old) {
        if (!Array.isArray(old) || !old.length) return [];
        return old.map((r, i) => {
            const isHourly = !!(r.hoursCount && !r.daysCount) || r.leaveType === 'إجازة زمنية';
            const calendarDays = isHourly ? 1 : App.Security.toInt(r.daysCount, 1, 1, 4000);
            const ltype = (state.leaveTypes || []).find(t => t.name === r.leaveType);
            return {
                id: r.id || C.uid('lv'),
                empId: r.empId || null,
                empName: normalizeName(r.empName),
                jobTitle: normalizeName(r.jobTitle),
                dept: normalizeName(r.dept),
                section: normalizeName(r.section),
                leaveTypeId: r.leaveTypeId || (ltype ? ltype.id : null),
                leaveType: r.leaveType || (ltype ? ltype.name : ''),
                leaveTypeIsHourly: isHourly,
                fromDate: App.Security.isIsoDate(r.fromDate) ? r.fromDate : '',
                toDate: App.Security.isIsoDate(r.toDate) ? r.toDate : (App.Security.isIsoDate(r.fromDate) ? r.fromDate : ''),
                fromTime: App.Security.isTime(r.fromTime) ? r.fromTime : '',
                toTime: App.Security.isTime(r.toTime) ? r.toTime : '',
                calendarDays: calendarDays,
                daysCount: calendarDays,
                deductedDays: isHourly ? 0 : calendarDays,
                hoursCount: App.Security.toInt(r.hoursCount, 0, 0, 24),
                compensatoryDays: 0,
                excludedHolidays: [],
                notes: App.Security.clean(r.notes, 500),
                status: r.status || C.STATUS.APPROVED,
                createdAt: r.createdAt || nowIso(),
                updatedAt: r.updatedAt || nowIso(),
                createdBy: r.createdBy || 'ترحيل'
            };
        });
    }

    /** يبني كائن بيانات كامل من ملف نسخة احتياطية (قديم أو جديد) */
    function fromBackupObject(obj) {
        if (!obj || typeof obj !== 'object') throw new Error('ملف غير صالح');

        const out = {};
        out.settings = migrateSettings(obj.settings);
        out.leaveTypes = migrateLeaveTypes(obj.leaveTypes || obj.types);
        out.departments = migrateDepartments(obj.departments || obj.depts);
        out.staff = migrateStaff(obj.staff || obj.staffList);
        out.leaves = migrateLeaves(obj.leaves || obj.leavesList);

        out.holidays = Array.isArray(obj.holidays)
            ? obj.holidays.filter(h => h && App.Security.isIsoDate(h.date)).map(h => ({
                id: h.id || C.uid('hol'),
                date: h.date,
                name: normalizeName(h.name) || 'عطلة رسمية',
                recurring: !!h.recurring,
                excluded: h.excluded === true ? true : (h.excluded === false ? false : null)
            }))
            : seedHolidays(new Date().getFullYear());

        out.compensations = Array.isArray(obj.compensations) ? obj.compensations : [];
        out.audit = Array.isArray(obj.audit) ? obj.audit : [];
        out.meta = Object.assign({}, obj.meta || {}, {
            schemaVersion: C.SCHEMA_VERSION,
            importedAt: nowIso()
        });

        /* ربط السجلات بالموظفين بالاسم */
        linkEmployees(out.staff, out.leaves);
        return out;
    }

    /** يربط كل سجل إجازة بمعرّف الموظف عبر مطابقة الاسم */
    function linkEmployees(staff, leaves) {
        const byName = {};
        (staff || []).forEach(p => { byName[normalizeName(p.name)] = p.id; });
        (leaves || []).forEach(r => {
            if (!r.empId && byName[normalizeName(r.empName)]) r.empId = byName[normalizeName(r.empName)];
        });
    }

    /**
     * يعيد ربط السجلات القديمة بمعرّفات أنواع الإجازات عبر الاسم.
     * السجلات المُرحَّلة من النسخة الأولى تحمل اسم النوع نصاً بلا معرّف،
     * وهذا يُفقد النظام معرفة إن كان النوع يخصم من الرصيد أم لا.
     */
    function backfillLeaveTypeIds() {
        const types = state.leaveTypes || [];
        if (!types.length) return 0;

        const byName = {};
        const byId = {};
        types.forEach(t => {
            if (t && t.name) byName[t.name] = t;
            if (t && t.id) byId[t.id] = t;
        });

        let changed = 0;
        (state.leaves || []).forEach(l => {
            let t = l.leaveTypeId ? byId[l.leaveTypeId] : null;
            if (!t && l.leaveType) {
                t = byName[l.leaveType];
                if (t) { l.leaveTypeId = t.id; changed++; }
            }
            if (t) l.leaveTypeIsHourly = !!t.isHourly;
        });
        return changed;
    }

    /** يولّد العطل الرسمية الثابتة لسنة معينة من القالب */
    function seedHolidays(year) {
        return C.IRAQ_HOLIDAY_TEMPLATE.map((h, i) => ({
            id: 'hol-' + year + '-' + (i + 1),
            date: year + '-' + App.Dates.pad2(h.month) + '-' + App.Dates.pad2(h.day),
            name: h.name,
            recurring: true,
            excluded: null
        }));
    }

    /** حالة فارغة تماماً بالبيانات الافتراضية */
    function freshState() {
        const settings = migrateSettings({});
        return {
            settings: settings,
            leaveTypes: clone(C.DEFAULT_LEAVE_TYPES),
            departments: clone(C.DEFAULT_DEPARTMENTS),
            staff: [],
            leaves: [],
            holidays: seedHolidays(new Date().getFullYear()),
            compensations: [],
            audit: [],
            meta: {
                schemaVersion: C.SCHEMA_VERSION,
                appVersion: C.APP_VERSION,
                createdAt: nowIso(),
                updatedAt: nowIso(),
                lastBackupDate: '',
                installId: C.uid('install')
            }
        };
    }

    /* ============================================================
       التهيئة
       ============================================================ */
    /* ============================================================
       واجهة Electron (تطبيق .exe)
       عند التشغيل داخل Electron يكون ملف البيانات على القرص هو المصدر
       الرسمي، وتُتجاوز IndexedDB و File System Access تماماً.
       ============================================================ */
    function electronBridge() {
        try {
            const e = window.App && App.Electron;
            return (e && e.available && e.available()) ? e : null;
        } catch (err) {
            return null;
        }
    }

    /**
     * يطبّق بيانات معالج التنصيب على الإعدادات — مرة واحدة فقط لكل تنصيب.
     * الجسر يُرجع الكائن مرة واحدة ثم يعيد null.
     */
    async function applyInstallConfig() {
        const el = electronBridge();
        if (!el) return false;

        let cfg = null;
        try { cfg = await el.takeInstallConfig(); } catch (e) { cfg = null; }
        if (!cfg || typeof cfg !== 'object') return false;

        const s = state.settings || (state.settings = {});
        const textFields = ['ministry', 'directorate', 'hospital', 'departmentUnit',
            'footerHR', 'footerManager', 'operatorName'];
        let applied = 0;
        textFields.forEach(function (k) {
            const v = App.Security.clean(cfg[k], 200);
            if (v) { s[k] = v; applied++; }
        });

        const bal = parseInt(cfg.defaultAnnualBalance, 10);
        if (!isNaN(bal) && bal >= 0 && bal <= 365) {
            s.defaultAnnualBalance = bal;
            applied++;
        }

        const backup = App.Security.clean(cfg.backupFolder, 400);
        if (backup) {
            try { await el.setBackupFolder(backup); } catch (e) { /* تجاهل */ }
            s.backupFolder = backup;
            applied++;
        }

        state.meta = state.meta || {};
        state.meta.installConfigApplied = true;
        state.meta.installConfigAt = new Date().toISOString();

        if (applied) {
            App.Audit.log({
                action: 'system', entity: 'settings',
                label: 'تطبيق إعدادات معالج التنصيب (' + applied + ' حقلاً)'
            });
        }
        return applied > 0;
    }

    async function init() {
        let loaded = false;
        const el = electronBridge();

        /* 0) داخل Electron: ملفات على القرص هي المصدر الرسمي */
        if (el) {
            try {
                const docs = await el.readAll();
                if (docs) {
                    C.ALL_KEYS.forEach(function (key) {
                        if (docs[key] !== undefined && docs[key] !== null) state[key] = docs[key];
                    });
                    loaded = true;
                }
                backend = 'electron';
                connected = true;
                try {
                    const p = await el.paths();
                    folderName = (p && p.data) || '';
                    dataPath = folderName;
                    backupPath = (p && p.backups) || '';
                } catch (e) { /* تجاهل */ }
            } catch (e) {
                console.warn('[Store] تعذّر القراءة من Electron:', e);
            }
        }

        /* 1) IndexedDB — لمسار المتصفح فقط */
        if (!loaded && !el && IDB.supported()) {
            try {
                const meta = await IDB.get(C.KEYS.META);
                if (meta) {
                    for (const key of C.ALL_KEYS) {
                        const v = await IDB.get(key);
                        if (v !== null && v !== undefined) state[key] = v;
                    }
                    loaded = true;
                    backend = 'idb';
                }
            } catch (e) {
                console.warn('[Store] تعذّر القراءة من IndexedDB:', e);
            }
        }

        /* 2) الترحيل من localStorage إن لم توجد بيانات جديدة */
        if (!loaded) {
            const legacy = readLegacyLocalStorage();
            if (legacy) {
                const migrated = fromBackupObject(legacy);
                Object.assign(state, migrated);
                loaded = true;
                backend = el ? 'electron' : (IDB.supported() ? 'idb' : 'localstorage');
                await persistAllNow();
                emit('migrated', { source: 'localStorage' });
            }
        }

        /* 3) بيانات افتراضية عند أول تشغيل — بلا موظفين ولا حركات */
        if (!loaded) {
            Object.assign(state, freshState());
            backend = el ? 'electron' : (IDB.supported() ? 'idb' : 'localstorage');
            await persistAllNow();
        }

        /* 3.5) نسخة أمان قبل أي ترقية: إن تغيّر إصدار البرنامج عن آخر تشغيل
           نأخذ نسخة احتياطية كاملة قبل لمس أي شيء، فيبقى للمستخدم نقطة رجوع. */
        const prevAppVersion = (state.meta && state.meta.appVersion) || '';
        const isAppUpgrade = loaded && !!prevAppVersion && prevAppVersion !== C.APP_VERSION;
        if (isAppUpgrade) {
            try {
                await writeBackup('pre-upgrade');
                emit('upgraded', { from: prevAppVersion, to: C.APP_VERSION });
            } catch (e) {
                console.warn('[Store] تعذّر أخذ نسخة ما قبل الترقية:', e);
            }
        }

        /* 4) ضمان اكتمال البنية بعد أي ترحيل.
           قد يكون التحديث أضاف مستندات أو حقولاً جديدة؛ نكتشف ذلك ونكتبه
           على القرص فوراً، لأن ensureShape يملأ الناقص في الذاكرة فقط. */
        const hadKey = {};
        C.ALL_KEYS.forEach(function (k) { hadKey[k] = (state[k] !== undefined); });
        const prevSettingsFields = state.settings ? Object.keys(state.settings).sort().join(',') : '';
        const prevSchema = (state.meta && state.meta.schemaVersion) || 0;

        ensureShape();
        backfillLeaveTypeIds();

        const gainedDocument = C.ALL_KEYS.some(function (k) { return !hadKey[k] && state[k] !== undefined; });
        const gainedSetting = !!state.settings &&
            Object.keys(state.settings).sort().join(',') !== prevSettingsFields;
        const schemaChanged = gainedDocument || gainedSetting ||
            prevSchema !== C.SCHEMA_VERSION || prevAppVersion !== C.APP_VERSION;

        if (schemaChanged) {
            state.meta.schemaVersion = C.SCHEMA_VERSION;
            state.meta.appVersion = C.APP_VERSION;
            state.meta.lastUpgradeAt = nowIso();
            if (loaded) {
                /* نُثبّت البنية الجديدة على القرص فوراً قبل أي تعديل آخر */
                await persistAllNow();
                emit('schemaUpgraded', {
                    from: prevAppVersion || '(أول تشغيل)',
                    to: C.APP_VERSION,
                    newDocuments: C.ALL_KEYS.filter(function (k) { return !hadKey[k]; })
                });
            }
        }

        /* 4.1) إعدادات معالج التنصيب (مرة واحدة لكل تنصيب) */
        if (el && !state.meta.installConfigApplied) {
            const changed = await applyInstallConfig();
            if (changed) {
                ensureShape();
                await persistAllNow();
                emit('installConfig', { settings: state.settings });
            }
        }

        /* 5) استعادة مقبض المجلد إن كان محفوظاً (مسار المتصفح فقط) */
        if (!el && IDB.supported() && FSA.supported()) {
            try {
                const handle = await IDB.get(HANDLE_KEY);
                if (handle) {
                    dirHandle = handle;
                    folderName = handle.name || '';
                    const perm = await FSA.queryPermission(handle, 'readwrite');
                    connected = (perm === 'granted');
                    emit('folderPending', { handle: handle, name: folderName, granted: connected });
                }
            } catch (e) {
                console.warn('[Store] تعذّر استعادة مقبض المجلد:', e);
            }
        }

        ready = true;
        emit('ready', { backend: backend, connected: connected });
        return state;
    }

    /** يضمن وجود كل المفاتيح وأنواعها الصحيحة */
    function ensureShape() {
        const fresh = freshState();
        C.ALL_KEYS.forEach(k => {
            if (Array.isArray(fresh[k])) {
                if (!Array.isArray(state[k])) state[k] = [];
            } else if (typeof fresh[k] === 'object') {
                if (!state[k] || typeof state[k] !== 'object' || Array.isArray(state[k])) {
                    state[k] = fresh[k];
                }
            }
        });
        state.settings = Object.assign({}, C.DEFAULT_SETTINGS, state.settings || {});
        state.meta = Object.assign({}, fresh.meta, state.meta || {});
    }

    function readLegacyLocalStorage() {
        try {
            if (typeof localStorage === 'undefined') return null;
            const raw = {
                settings: localStorage.getItem(C.LEGACY_KEYS.SETTINGS),
                departments: localStorage.getItem(C.LEGACY_KEYS.DEPTS),
                staffList: localStorage.getItem(C.LEGACY_KEYS.STAFF),
                leaveTypes: localStorage.getItem(C.LEGACY_KEYS.TYPES),
                leavesList: localStorage.getItem(C.LEGACY_KEYS.LEAVES)
            };
            if (!raw.settings && !raw.leavesList && !raw.leaveTypes && !raw.departments && !raw.staffList) {
                return null;
            }
            const out = {};
            ['settings', 'departments', 'staffList', 'leaveTypes', 'leavesList'].forEach(k => {
                if (raw[k]) {
                    try { out[k] = JSON.parse(raw[k]); } catch (e) { out[k] = null; }
                }
            });
            return out;
        } catch (e) {
            return null;
        }
    }

    /* ============================================================
       الحفظ
       ============================================================ */

    /** حفظ فوري لكل الوثائق (يُستخدم عند التهيئة والترحيل) */
    async function persistAllNow() {
        state.meta.updatedAt = nowIso();

        /* داخل Electron: الكتابة إلى ملفات القرص مباشرة */
        const el = electronBridge();
        if (el) {
            try {
                const docs = {};
                C.ALL_KEYS.forEach(function (k) { docs[k] = state[k]; });
                await el.writeAll(docs);
            } catch (e) {
                console.warn('[Store] فشل حفظ ملفات Electron:', e);
                emit('fileError', { key: '*', error: e });
            }
            return;
        }

        if (IDB.supported()) {
            for (const key of C.ALL_KEYS) {
                try { await IDB.set(key, state[key]); } catch (e) { console.warn('[Store] فشل حفظ', key, e); }
            }
        } else {
            persistToLocalStorage();
        }
        if (connected && dirHandle) {
            await writeAllToFolder().catch(e => console.warn('[Store] فشل الكتابة للمجلد:', e));
        }
    }

    function persistToLocalStorage() {
        /* احتياطي أخير للمتصفحات القديمة جداً */
        try {
            C.ALL_KEYS.forEach(k => {
                localStorage.setItem('admh_v2_' + k, JSON.stringify(state[k]));
            });
        } catch (e) {
            console.error('[Store] localStorage ممتلئ', e);
        }
    }

    /**
     * الحفظ العام: يُستدعى بعد أي تعديل.
     * يكتب في IndexedDB فوراً، وإلى المجلد بعد تأخير بسيط.
     */
    function save(keys) {
        const list = Array.isArray(keys) ? keys : (keys ? [keys] : C.ALL_KEYS.slice());
        state.meta.updatedAt = nowIso();

        /* داخل Electron: كتابة مؤجلة إلى ملفات القرص عبر IPC */
        const el = electronBridge();
        if (el) {
            list.forEach(function (k) {
                clearTimeout(writeTimers[k]);
                writeTimers[k] = setTimeout(function () {
                    el.writeDoc(k, state[k]).catch(function (e) {
                        console.warn('[Store] فشل كتابة الملف', k, e);
                        emit('fileError', { key: k, error: e });
                    });
                }, 350);
            });
            /* الميتا تُكتب معها حتى تبقى تواريخ النسخ والمجلد محدّثة */
            clearTimeout(writeTimers[C.KEYS.META]);
            writeTimers[C.KEYS.META] = setTimeout(function () {
                el.writeDoc(C.KEYS.META, state.meta).catch(function () { });
            }, 350);

            emit('change', { keys: list });
            return Promise.resolve(true);
        }

        /* IndexedDB فوري */
        if (IDB.supported()) {
            list.forEach(k => {
                IDB.set(k, state[k]).catch(e => console.warn('[Store] فشل حفظ', k, e));
            });
            IDB.set(C.KEYS.META, state.meta).catch(() => { });
        } else {
            persistToLocalStorage();
        }

        /* المجلد بعد تأخير لتجميع التعديلات */
        if (connected && dirHandle) {
            list.forEach(k => {
                clearTimeout(writeTimers[k]);
                writeTimers[k] = setTimeout(() => {
                    writeKeyToFolder(k).catch(e => {
                        console.warn('[Store] فشل كتابة الملف', k, e);
                        emit('fileError', { key: k, error: e });
                    });
                }, 600);
            });
        }

        emit('change', { keys: list });
        return Promise.resolve(true);
    }

    /** كتابة فورية بلا تأخير — تُستدعى قبل إغلاق الصفحة */
    async function flush() {
        const el = electronBridge();
        if (el) {
            Object.keys(writeTimers).forEach(k => clearTimeout(writeTimers[k]));
            Object.keys(writeTimers).forEach(k => delete writeTimers[k]);
            try {
                const docs = {};
                C.ALL_KEYS.forEach(function (k) { docs[k] = state[k]; });
                await el.writeAll(docs);
                return true;
            } catch (e) {
                console.warn('[Store] فشل الحفظ النهائي على القرص:', e);
                return false;
            }
        }

        if (!connected || !dirHandle) return true;
        Object.keys(writeTimers).forEach(k => clearTimeout(writeTimers[k]));
        Object.keys(writeTimers).forEach(k => delete writeTimers[k]);
        try {
            await writeAllToFolder();
            return true;
        } catch (e) {
            console.warn('[Store] فشل الحفظ النهائي:', e);
            return false;
        }
    }

    /* ============================================================
       الكتابة إلى المجلد
       ============================================================ */

    async function writeKeyToFolder(key) {
        if (!dirHandle) return;
        if (key === C.KEYS.LEAVES) return writeLeavesSharded();
        const fileName = FILE_MAP[key];
        if (!fileName) return;
        await FSA.writeJSON(dirHandle, fileName, state[key]);
    }

    async function writeAllToFolder() {
        if (!dirHandle) return;
        for (const key of C.ALL_KEYS) {
            if (key === C.KEYS.LEAVES) continue;
            const fileName = FILE_MAP[key];
            if (fileName) await FSA.writeJSON(dirHandle, fileName, state[key]);
        }
        /* ملف تعريفي بسيط */
        await FSA.writeJSON(dirHandle, '_معلومات-المجلد.json', {
            system: 'نظام موقف الإجازات اليومية',
            version: C.APP_VERSION,
            hospital: state.settings.hospital || '',
            lastWrite: nowIso(),
            note: 'لا تحذف هذا المجلد. يحتوي على بيانات النظام والنسخ الاحتياطية.'
        }).catch(() => { });
        await writeLeavesSharded();
    }

    /** الإجازات تُكتب ملفاً لكل سنة لتسريع الحفظ وتبسيط المراجعة */
    async function writeLeavesSharded() {
        if (!dirHandle) return;
        const sub = await FSA.getSubDir(dirHandle, 'leaves', true);

        const byYear = {};
        (state.leaves || []).forEach(r => {
            const y = App.Dates.yearOf(r.fromDate) || 'unknown';
            (byYear[y] = byYear[y] || []).push(r);
        });

        const prevIndex = await FSA.readJSON(dirHandle, 'leaves-index.json');
        const prevYears = Array.isArray(prevIndex) ? prevIndex.map(String) : [];
        const newYears = Object.keys(byYear);

        for (const y of newYears) {
            await FSA.writeJSON(sub, 'leaves-' + y + '.json', byYear[y]);
        }
        for (const y of prevYears) {
            if (newYears.indexOf(y) === -1) {
                await FSA.removeFile(sub, 'leaves-' + y + '.json');
            }
        }
        await FSA.writeJSON(dirHandle, 'leaves-index.json', newYears);
    }

    /* ============================================================
       ربط مجلد البيانات
       ============================================================ */

    async function connectFolder() {
        if (!FSA.supported()) {
            throw new Error('هذا المتصفح لا يدعم الحفظ في مجلد. استخدم Chrome أو Edge، أو استعمل زر التصدير.');
        }
        const handle = await FSA.pickDirectory();
        const ok = await FSA.ensurePermission(handle, 'readwrite');
        if (!ok) throw new Error('لم يُمنح إذن الكتابة على المجلد');

        dirHandle = handle;
        folderName = handle.name || '';
        connected = true;
        if (IDB.supported()) {
            try { await IDB.set(HANDLE_KEY, handle); } catch (e) { console.warn(e); }
        }
        await writeAllToFolder();
        state.meta.folderName = folderName;
        state.meta.lastBackupDate = App.Dates.todayISO();
        await writeBackup('initial');
        save([C.KEYS.META]);
        emit('folder', { connected: true, name: folderName });
        return folderName;
    }

    /** إعادة تفعيل الاتصال بمجلد محفوظ (يحتاج موافقة المستخدم مرة أخرى) */
    async function reconnectFolder() {
        if (!dirHandle) throw new Error('لا يوجد مجلد محفوظ');
        const ok = await FSA.ensurePermission(dirHandle, 'readwrite');
        if (!ok) throw new Error('لم يُمنح إذن الكتابة');
        connected = true;
        await flush();
        save([C.KEYS.META]);
        emit('folder', { connected: true, name: folderName });
        return folderName;
    }

    function disconnectFolder() {
        connected = false;
        dirHandle = null;
        folderName = '';
        if (IDB.supported()) IDB.del(HANDLE_KEY).catch(() => { });
        emit('folder', { connected: false, name: '' });
    }

    /** القراءة من مجلد موجود بدل الكتابة عليه (استيراد مجلد بيانات) */
    async function readFromFolder(handle) {
        const h = handle || dirHandle;
        if (!h) throw new Error('لا يوجد مجلد');

        const out = {};
        for (const key of C.ALL_KEYS) {
            if (key === C.KEYS.LEAVES) continue;
            const fileName = FILE_MAP[key];
            if (!fileName) continue;
            const v = await FSA.readJSON(h, fileName);
            if (v !== null && v !== undefined) out[key] = v;
        }

        /* جمع سجلات الإجازات من ملفات السنوات */
        try {
            const sub = await FSA.getSubDir(h, 'leaves', false);
            const idx = await FSA.readJSON(h, 'leaves-index.json');
            let years = Array.isArray(idx) ? idx.map(String) : [];
            if (!years.length) {
                const files = await FSA.listFiles(sub);
                years = files.filter(f => /^leaves-\d{4}\.json$/.test(f))
                    .map(f => f.replace(/^leaves-/, '').replace(/\.json$/, ''));
            }
            const all = [];
            for (const y of years) {
                const arr = await FSA.readJSON(sub, 'leaves-' + y + '.json');
                if (Array.isArray(arr)) all.push(...arr);
            }
            if (all.length) out.leaves = all;
        } catch (e) {
            /* لا مجلد إجازات — نتجاهل */
        }
        return out;
    }

    /** يستورد محتوى مجلد بيانات كامل فوق البيانات الحالية */
    async function importFromFolder() {
        if (!FSA.supported()) throw new Error('هذا المتصفح لا يدعم فتح مجلد');
        const handle = await FSA.pickDirectory({ mode: 'read' });
        const data = await readFromFolder(handle);
        if (!Object.keys(data).length) {
            throw new Error('المجلد المختار لا يحتوي ملفات بيانات للنظام');
        }
        applyImported(data);
        await persistAllNow();
        emit('imported', { source: 'folder' });
        return data;
    }

    function applyImported(data) {
        /* fromBackupObject يتعامل مع الصيغتين: الجديدة (leaves/staff)
           والقديمة (leavesList/staffList). تمرير الكائن كما هو يمنع
           فقدان السجلات عند استيراد ملفات النسخة الأولى. */
        const merged = fromBackupObject(data || {});
        Object.assign(state, merged);
        ensureShape();
        backfillLeaveTypeIds();
    }

    /* ============================================================
       النسخ الاحتياطي
       ============================================================ */

    async function writeBackup(reason) {
        const el = electronBridge();
        if (el) {
            try {
                const name = await el.writeBackup(exportObject());
                if (!name) return null;   /* مجلد النسخ غير متاح — لا نُسقط التطبيق */
                state.meta.lastBackupDate = App.Dates.todayISO();
                state.meta.lastBackupFile = name;
                save([C.KEYS.META]);
                emit('backup', { file: name, reason: reason || '' });
                return name;
            } catch (e) {
                console.warn('[Store] فشل النسخ الاحتياطي على القرص:', e);
                return null;
            }
        }

        if (!connected || !dirHandle) return null;
        const sub = await FSA.getSubDir(dirHandle, 'backups', true);
        const stamp = new Date();
        const name = 'snapshot-' +
            App.Dates.toISO(stamp) + '_' +
            App.Dates.pad2(stamp.getHours()) + App.Dates.pad2(stamp.getMinutes()) + '.json';
        await FSA.writeJSON(sub, name, exportObject());
        await rotateBackups(sub, 30);
        state.meta.lastBackupDate = App.Dates.todayISO();
        state.meta.lastBackupFile = name;
        if (IDB.supported()) IDB.set(C.KEYS.META, state.meta).catch(() => { });
        emit('backup', { file: name, reason: reason || '' });
        return name;
    }

    /** ملفات النسخ الاحتياطية الحقيقية فقط — تُستثنى ملفات .prev الداخلية */
    function isSnapshotName(name) {
        return /^snapshot-.*\.json$/.test(name) && !/\.prev\.json$/.test(name);
    }

    async function rotateBackups(sub, keep) {
        const files = (await FSA.listFiles(sub))
            .filter(isSnapshotName)
            .sort();
        const excess = files.length - keep;
        for (let i = 0; i < excess; i++) {
            await FSA.removeFile(sub, files[i]);
        }
    }

    async function listBackups() {
        const el = electronBridge();
        if (el) {
            try {
                const files = await el.listBackups();
                return (files || []).filter(isSnapshotName).sort().reverse();
            } catch (e) {
                return [];
            }
        }

        if (!connected || !dirHandle) return [];
        try {
            const sub = await FSA.getSubDir(dirHandle, 'backups', false);
            const files = (await FSA.listFiles(sub)).filter(isSnapshotName);
            return files.sort().reverse();
        } catch (e) {
            return [];
        }
    }

    async function restoreBackup(fileName) {
        const el = electronBridge();
        if (el) {
            const data = await el.readBackup(fileName);
            if (!data) throw new Error('تعذّر قراءة ملف النسخة الاحتياطية');
            applyImported(data);
            await persistAllNow();
            emit('imported', { source: 'backup', file: fileName });
            return true;
        }

        if (!connected || !dirHandle) throw new Error('لا يوجد مجلد مرتبط');
        const sub = await FSA.getSubDir(dirHandle, 'backups', false);
        const data = await FSA.readJSON(sub, fileName);
        if (!data) throw new Error('تعذّر قراءة ملف النسخة الاحتياطية');
        applyImported(data);
        await persistAllNow();
        emit('imported', { source: 'backup', file: fileName });
        return true;
    }

    /** نسخة احتياطية تلقائية مرة واحدة يومياً */
    async function autoBackupIfNeeded() {
        const el = electronBridge();
        if (!el && (!connected || !dirHandle)) return null;
        const today = App.Dates.todayISO();
        if (state.meta.lastBackupDate === today) return null;
        try {
            return await writeBackup('daily');
        } catch (e) {
            console.warn('[Store] فشل النسخ الاحتياطي اليومي', e);
            return null;
        }
    }

    /* ============================================================
       التصدير والاستيراد عبر ملف
       ============================================================ */

    function exportObject() {
        return {
            _format: 'admh-leaves-backup',
            _version: C.SCHEMA_VERSION,
            _app: C.APP_VERSION,
            exportDate: nowIso(),
            settings: state.settings,
            leaveTypes: state.leaveTypes,
            departments: state.departments,
            staff: state.staff,
            holidays: state.holidays,
            compensations: state.compensations,
            leaves: state.leaves,
            audit: state.audit,
            meta: state.meta,
            /* أسماء متوافقة مع النسخة القديمة */
            staffList: state.staff,
            leavesList: state.leaves
        };
    }

    function exportToFile() {
        const obj = exportObject();
        const name = 'نسخة_احتياطية_موقف_الإجازات_' + App.Dates.todayISO() + '.json';
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return name;
    }

    async function importFromObject(obj) {
        applyImported(obj);
        await persistAllNow();
        emit('imported', { source: 'file' });
        return true;
    }

    /** تصفير كامل: يمسح التخزين المحلي ويعيد البيانات الافتراضية */
    async function factoryReset() {
        if (IDB.supported()) {
            try { await IDB.clear(); } catch (e) { console.warn('[Store] فشل تفريغ IndexedDB', e); }
        }
        try {
            C.ALL_KEYS.forEach(k => localStorage.removeItem('admh_v2_' + k));
        } catch (e) { /* تجاهل */ }

        dirHandle = null;
        /* داخل Electron يبقى الاتصال بمجلد البيانات قائماً بعد التصفير */
        if (!electronBridge()) {
            connected = false;
            folderName = '';
        }

        const fresh = freshState();
        Object.keys(state).forEach(k => { delete state[k]; });
        Object.assign(state, fresh);

        await persistAllNow();
        emit('imported', { source: 'factory-reset' });
        return true;
    }

    /* ============================================================
       أدوات مساعدة على البيانات
       ============================================================ */

    const get = {
        settings: () => state.settings,
        meta: () => state.meta,
        leaveTypes: () => state.leaveTypes,
        departments: () => state.departments,
        staff: () => state.staff,
        holidays: () => state.holidays,
        leaves: () => state.leaves,
        compensations: () => state.compensations,
        audit: () => state.audit
    };

    function leaveTypeById(id) {
        return state.leaveTypes.find(t => t.id === id) || null;
    }

    function leaveTypeByName(name) {
        return state.leaveTypes.find(t => t.name === name) || null;
    }

    function employeeById(id) {
        return state.staff.find(p => p.id === id) || null;
    }

    function employeeByName(name) {
        const n = normalizeName(name);
        return state.staff.find(p => normalizeName(p.name) === n) || null;
    }

    /** يضيف موظفاً إلى الدليل أو يحدّث بياناته */
    function upsertEmployee(info) {
        const name = normalizeName(info.name);
        if (!name) return null;
        let emp = employeeByName(name);
        if (emp) {
            let changed = false;
            if (info.jobTitle && emp.jobTitle !== info.jobTitle) { emp.jobTitle = normalizeName(info.jobTitle); changed = true; }
            if (info.dept && emp.dept !== info.dept) { emp.dept = normalizeName(info.dept); changed = true; }
            if (info.section !== undefined && emp.section !== info.section) { emp.section = normalizeName(info.section); changed = true; }
            if (changed) save([C.KEYS.STAFF]);
            return emp;
        }
        emp = {
            id: C.uid('emp'),
            name: name,
            jobTitle: normalizeName(info.jobTitle),
            dept: normalizeName(info.dept),
            section: normalizeName(info.section),
            employeeNumber: normalizeName(info.employeeNumber),
            annualBalance: App.Security.toInt(info.annualBalance, state.settings.defaultAnnualBalance, 0, 365),
            isActive: true
        };
        state.staff.push(emp);
        save([C.KEYS.STAFF]);
        return emp;
    }

    /* ============================================================
       ضمان وجود قسم/شعبة قادمة من نماذج الإدخال الحر
       ============================================================ */

    /** مفتاح مطابقة يتجاهل حالة الأحرف والمسافات المتكررة */
    function matchKey(s) {
        return normalizeName(s).replace(/\s+/g, ' ').toLowerCase();
    }

    /** يبحث عن قسم بالاسم بمطابقة تتجاهل حالة الأحرف والمسافات */
    function departmentByName(name) {
        const key = matchKey(name);
        if (!key) return null;
        return (state.departments || []).find(d => d && matchKey(d.name) === key) || null;
    }

    /** يبحث عن شعبة داخل قسم بمطابقة تتجاهل حالة الأحرف والمسافات */
    function sectionIn(dept, name) {
        const key = matchKey(name);
        if (!key || !dept) return null;
        return (dept.sections || []).find(s => s && matchKey(s.name) === key) || null;
    }

    /**
     * يضمن وجود قسم (وشعبة داخله) بالاسم، ويضيف الناقص تلقائياً.
     * يُستدعى من نموذج الإدخال حيث يمكن للكاتب أن يكتب قسماً أو شعبة
     * غير موجودة في الدليل، فتُضاف بدل رفض الحفظ.
     *
     * @param {string} deptName    اسم القسم كما كتبه المستخدم (قد يكون فارغاً)
     * @param {string} sectionName اسم الشعبة كما كتبها المستخدم (اختياري)
     * @returns {{dept: Object|null, section: Object|null, createdDept: boolean, createdSection: boolean}}
     *          dept/section هما الكائنان المخزَّنان بأسماء مطبَّعة (normalized)
     */
    function ensureOrg(deptName, sectionName) {
        const out = { dept: null, section: null, createdDept: false, createdSection: false };

        /* لا نُنشئ أبداً قسماً بلا اسم — القسم قد يكون غير مطلوب في النموذج */
        const dName = normalizeName(App.Security.clean(deptName, 120));
        if (!dName) return out;

        if (!Array.isArray(state.departments)) state.departments = [];

        let dept = departmentByName(dName);
        if (!dept) {
            dept = { id: C.uid('d'), name: dName, sections: [] };
            state.departments.push(dept);
            out.createdDept = true;
        }
        if (!Array.isArray(dept.sections)) dept.sections = [];
        out.dept = dept;

        const sName = normalizeName(App.Security.clean(sectionName, 120));
        if (sName) {
            let sec = sectionIn(dept, sName);
            if (!sec) {
                sec = { id: C.uid('s'), name: sName };
                dept.sections.push(sec);
                out.createdSection = true;
            }
            out.section = sec;
        }

        if (out.createdDept || out.createdSection) {
            save([C.KEYS.DEPARTMENTS]);

            if (out.createdDept) {
                App.Audit.log({
                    action: 'insert',
                    entity: 'departments',
                    recordId: dept.id,
                    label: 'إضافة قسم تلقائياً من نموذج الإدخال: ' + dept.name,
                    after: { id: dept.id, name: dept.name }
                });
            }
            if (out.createdSection) {
                App.Audit.log({
                    action: 'insert',
                    entity: 'sections',
                    recordId: out.section.id,
                    label: 'إضافة شعبة تلقائياً من نموذج الإدخال: ' + out.section.name + ' في ' + dept.name,
                    after: { id: out.section.id, name: out.section.name, dept: dept.name }
                });
            }
        }

        return out;
    }

    /** الرصيد المستهلك لموظف في سنة معينة */
    function usedBalance(empId, year) {
        return (state.leaves || [])
            .filter(r => r.empId === empId &&
                r.status !== C.STATUS.CANCELLED && r.status !== C.STATUS.REJECTED &&
                App.Dates.yearOf(r.fromDate) === year)
            .reduce((sum, r) => sum + (r.deductedDays || 0), 0);
    }

    /** رصيد الأيام التعويضية المستحقة على الموظف (غير المسددة) */
    function openCompensations(empId) {
        return (state.compensations || [])
            .filter(c => c.empId === empId && !c.settled)
            .reduce((sum, c) => sum + (c.days || 0), 0);
    }

    return {
        /* حالة */
        state: state,
        get: get,
        init: init,
        isReady: () => ready,
        backend: () => backend,
        isConnected: () => connected,
        folderName: () => folderName,
        hasPendingFolder: () => !!(dirHandle && !connected),
        pendingFolderName: () => folderName,

        /* بيئة Electron (تطبيق .exe) */
        isElectron: () => !!electronBridge(),
        dataPath: () => dataPath,
        backupPath: () => backupPath,
        setBackupFolder: async function (dir) {
            const el = electronBridge();
            if (!el) return false;
            const ok = await el.setBackupFolder(dir).catch(() => false);
            if (ok) {
                backupPath = dir;
                state.settings.backupFolder = dir;
                save([C.KEYS.SETTINGS]);
            }
            return !!ok;
        },
        chooseBackupFolder: async function () {
            const el = electronBridge();
            if (!el) return null;
            const dir = await el.chooseBackupFolder().catch(() => null);
            if (!dir) return null;
            backupPath = dir;
            state.settings.backupFolder = dir;
            save([C.KEYS.SETTINGS]);
            return dir;
        },
        openFolder: function (which) {
            const el = electronBridge();
            if (!el) return Promise.resolve(false);
            return el.openFolder(which).catch(function () { return false; });
        },

        /* حفظ */
        save: save,
        flush: flush,
        persistAllNow: persistAllNow,

        /* مجلد */
        connectFolder: connectFolder,
        reconnectFolder: reconnectFolder,
        disconnectFolder: disconnectFolder,
        importFromFolder: importFromFolder,
        readFromFolder: readFromFolder,

        /* نسخ احتياطية */
        writeBackup: writeBackup,
        listBackups: listBackups,
        restoreBackup: restoreBackup,
        autoBackupIfNeeded: autoBackupIfNeeded,

        /* تصدير/استيراد */
        exportObject: exportObject,
        exportToFile: exportToFile,
        importFromObject: importFromObject,
        factoryReset: factoryReset,
        fromBackupObject: fromBackupObject,

        /* بحث */
        leaveTypeById: leaveTypeById,
        leaveTypeByName: leaveTypeByName,
        employeeById: employeeById,
        employeeByName: employeeByName,
        upsertEmployee: upsertEmployee,
        ensureOrg: ensureOrg,
        usedBalance: usedBalance,
        openCompensations: openCompensations,

        /* أدوات */
        seedHolidays: seedHolidays,
        normalizeName: normalizeName,
        on: on,
        emit: emit,
        FILE_MAP: FILE_MAP,
        DIR_NAME: DIR_NAME
    };
})();
