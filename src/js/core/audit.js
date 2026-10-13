/* ============================================================
   سجل التدقيق — يسجّل كل إضافة/تعديل/حذف مع القيمة قبل وبعد
   ============================================================ */
window.App = window.App || {};

App.Audit = (function () {
    'use strict';

    const C = App.Constants;
    const MAX_ENTRIES = 3000;

    const ACTION_LABEL = {
        insert: 'إضافة',
        update: 'تعديل',
        delete: 'حذف',
        override: 'تجاوز تعارض',
        settle: 'تسديد تعويض',
        system: 'عملية نظام'
    };

    const ACTION_CLASS = {
        insert: 'bg-emerald-100 text-emerald-800',
        update: 'bg-sky-100 text-sky-800',
        delete: 'bg-rose-100 text-rose-800',
        override: 'bg-amber-100 text-amber-800',
        settle: 'bg-violet-100 text-violet-800',
        system: 'bg-slate-200 text-slate-700'
    };

    function operator() {
        const s = App.Store.get.settings();
        return (s && s.operatorName) || 'موظف الإجازات';
    }

    /**
     * تسجيل عملية.
     * rec = { action, entity, recordId, label, before, after, note }
     */
    function log(rec) {
        rec = rec || {};
        const list = App.Store.get.audit();
        const entry = {
            id: C.uid('aud'),
            at: new Date().toISOString(),
            action: rec.action || 'system',
            entity: rec.entity || '',
            recordId: rec.recordId || '',
            label: App.Security.clean(rec.label, 200),
            before: rec.before === undefined ? null : rec.before,
            after: rec.after === undefined ? null : rec.after,
            note: App.Security.clean(rec.note, 300),
            by: rec.by || operator()
        };
        list.unshift(entry);

        /* تحديد الحجم حتى لا يتضخم الملف */
        if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;

        App.Store.save([C.KEYS.AUDIT]);
        return entry;
    }

    /** قائمة مع تصفية */
    function list(filter) {
        filter = filter || {};
        let out = App.Store.get.audit().slice();

        if (filter.action) out = out.filter(e => e.action === filter.action);
        if (filter.entity) out = out.filter(e => e.entity === filter.entity);
        if (filter.from) out = out.filter(e => String(e.at).slice(0, 10) >= filter.from);
        if (filter.to) out = out.filter(e => String(e.at).slice(0, 10) <= filter.to);
        if (filter.keyword) {
            const k = filter.keyword.toLowerCase();
            out = out.filter(e =>
                String(e.label || '').toLowerCase().includes(k) ||
                String(e.note || '').toLowerCase().includes(k) ||
                String(e.by || '').toLowerCase().includes(k)
            );
        }
        return out;
    }

    function clearAll() {
        App.Store.state.audit = [];
        App.Store.save([C.KEYS.AUDIT]);
    }

    function formatAt(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return App.Dates.toISO(d) + ' ' +
            App.Dates.pad2(d.getHours()) + ':' + App.Dates.pad2(d.getMinutes());
    }

    function label(action) {
        return ACTION_LABEL[action] || action;
    }

    function actionClass(action) {
        return ACTION_CLASS[action] || ACTION_CLASS.system;
    }

    return {
        log: log,
        list: list,
        clearAll: clearAll,
        formatAt: formatAt,
        label: label,
        actionClass: actionClass
    };
})();
