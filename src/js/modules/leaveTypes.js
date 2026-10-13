/* ============================================================
   وحدة أنواع الإجازات
   ============================================================ */
window.App = window.App || {};

App.LeaveTypes = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    let inited = false;

    function all() { return Store.get.leaveTypes(); }
    function active() { return all().filter(t => t.isActive !== false); }
    function byId(id) { return all().find(t => t.id === id) || null; }
    function byName(name) { return all().find(t => t.name === name) || null; }

    /* ---------------- القوائم المنسدلة ---------------- */

    function populateSelects() {
        const list = active();

        const filterType = document.getElementById('filterLeaveType');
        if (filterType) {
            const cur = filterType.value;
            filterType.innerHTML = '<option value="">جميع أنواع الإجازات</option>' +
                list.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
            filterType.value = cur;
        }

        const entryType = document.getElementById('entryType');
        if (entryType) {
            const cur = entryType.value;
            entryType.innerHTML = list.map(t =>
                `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
            if (cur && byId(cur)) entryType.value = cur;
            else if (list.length) entryType.value = list[0].id;
        }

        const anType = document.getElementById('anType');
        if (anType) {
            const cur = anType.value;
            anType.innerHTML = '<option value="">جميع الأنواع</option>' +
                list.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
            anType.value = cur;
        }
    }

    /* ---------------- الرسم ---------------- */

    function render() {
        const host = document.getElementById('typeList');
        if (!host) return;

        const searchEl = document.getElementById('typeSearch');
        const kw = App.Security.clean(searchEl ? searchEl.value : '').toLowerCase();
        const leaves = Store.get.leaves();

        const list = all().filter(t => !kw || t.name.toLowerCase().includes(kw));

        if (!list.length) {
            host.innerHTML = '<p class="text-center py-6 text-slate-400 text-xs font-bold">لا توجد أنواع مطابقة</p>';
            return;
        }

        host.innerHTML = list.map(t => {
            const used = leaves.filter(l => l.leaveTypeId === t.id ||
                (!l.leaveTypeId && l.leaveType === t.name)).length;

            const flags = [];
            if (t.isHourly) flags.push('<span class="badge bg-amber-100 text-amber-800 border-amber-200">زمنية</span>');
            if (t.deductsBalance) flags.push('<span class="badge bg-emerald-100 text-emerald-800 border-emerald-200">تخصم من الرصيد</span>');
            else flags.push('<span class="badge bg-slate-100 text-slate-700 border-slate-200">لا تخصم</span>');
            if (t.isActive === false) flags.push('<span class="badge bg-rose-100 text-rose-800 border-rose-200">معطّلة</span>');

            return `
                <div class="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="w-3 h-3 rounded-full shrink-0" style="background:${esc(t.color || '#0284c7')}"></span>
                        <span class="font-bold text-xs text-slate-800 truncate">${esc(t.name)}</span>
                        ${flags.join(' ')}
                        <span class="text-[10px] text-slate-400">${used} سجل</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <button type="button" class="p-1 text-[11px] ${t.isActive === false ? 'text-slate-300' : 'text-emerald-600 hover:text-emerald-800'}" data-tact="toggle" data-id="${esc(t.id)}" title="${t.isActive === false ? 'تفعيل' : 'تعطيل'}">
                            <i class="fa-solid ${t.isActive === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>
                        </button>
                        <button type="button" class="p-1 text-[11px] text-brand-600 hover:text-brand-800" data-tact="edit" data-id="${esc(t.id)}" title="تعديل"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="p-1 text-[11px] text-rose-600 hover:text-rose-800" data-tact="del" data-id="${esc(t.id)}" title="حذف"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>`;
        }).join('');
    }

    /* ---------------- العمليات ---------------- */

    function add() {
        const nameEl = document.getElementById('newTypeName');
        const colorEl = document.getElementById('newTypeColor');
        const hourlyEl = document.getElementById('newTypeHourly');
        const deductsEl = document.getElementById('newTypeDeducts');
        if (!nameEl) return;

        const name = App.Security.clean(nameEl.value, 80);
        if (!name) { App.Notify.toast('يرجى كتابة اسم نوع الإجازة', 'warning'); return; }
        if (byName(name)) { App.Notify.toast('هذا النوع موجود مسبقاً', 'warning'); return; }

        const rec = {
            id: C.uid('lt'),
            name: name,
            isHourly: !!(hourlyEl && hourlyEl.checked),
            deductsBalance: !!(deductsEl && deductsEl.checked),
            color: (colorEl && colorEl.value) || '#0284c7',
            isActive: true
        };
        all().push(rec);
        Store.save([C.KEYS.LEAVE_TYPES]);
        App.Audit.log({ action: 'insert', entity: 'leaveTypes', recordId: rec.id, label: 'إضافة نوع إجازة: ' + name, after: rec });

        nameEl.value = '';
        if (hourlyEl) hourlyEl.checked = false;
        if (deductsEl) deductsEl.checked = true;
        App.Notify.toast('تمت إضافة نوع الإجازة', 'success');
    }

    async function edit(id) {
        const t = byId(id);
        if (!t) return;

        const res = await App.Notify.form({
            title: 'تعديل نوع الإجازة',
            fields: [
                { name: 'name', label: 'الاسم', type: 'text', value: t.name },
                { name: 'color', label: 'اللون', type: 'color', value: t.color || '#0284c7' },
                { name: 'isHourly', label: 'إجازة زمنية (بالساعات)', type: 'checkbox', value: t.isHourly },
                { name: 'deductsBalance', label: 'تخصم من الرصيد السنوي', type: 'checkbox', value: t.deductsBalance }
            ]
        });
        if (!res) return;

        const name = App.Security.clean(res.name, 80);
        if (!name) { App.Notify.toast('الاسم مطلوب', 'warning'); return; }
        const dup = byName(name);
        if (dup && dup.id !== id) { App.Notify.toast('يوجد نوع آخر بهذا الاسم', 'warning'); return; }

        const before = Object.assign({}, t);
        const oldName = t.name;
        t.name = name;
        t.color = res.color || t.color;
        t.isHourly = !!res.isHourly;
        t.deductsBalance = !!res.deductsBalance;

        /* تحديث السجلات المرتبطة بالاسم المخزّن */
        Store.get.leaves().forEach(l => {
            if (l.leaveTypeId === id || (!l.leaveTypeId && l.leaveType === oldName)) {
                l.leaveType = name;
                l.leaveTypeIsHourly = t.isHourly;
            }
        });

        Store.save([C.KEYS.LEAVE_TYPES, C.KEYS.LEAVES]);
        App.Audit.log({ action: 'update', entity: 'leaveTypes', recordId: id, label: 'تعديل نوع: ' + oldName, before: before, after: t });
        App.Notify.toast('تم التعديل', 'success');
    }

    function toggle(id) {
        const t = byId(id);
        if (!t) return;
        if (t.isActive !== false && active().length <= 1) {
            App.Notify.toast('يجب أن يبقى نوع إجازة واحد فعّال على الأقل', 'warning');
            return;
        }
        t.isActive = t.isActive === false;
        Store.save([C.KEYS.LEAVE_TYPES]);
        App.Audit.log({ action: 'update', entity: 'leaveTypes', recordId: id, label: (t.isActive ? 'تفعيل' : 'تعطيل') + ' نوع: ' + t.name });
        render();
    }

    async function remove(id) {
        const t = byId(id);
        if (!t) return;

        const used = Store.get.leaves().filter(l => l.leaveTypeId === id ||
            (!l.leaveTypeId && l.leaveType === t.name)).length;

        if (all().length <= 1) {
            App.Notify.toast('يجب أن يبقى نوع إجازة واحد على الأقل', 'warning');
            return;
        }

        const ok = await App.Notify.confirm(
            'حذف نوع «' + t.name + '»؟' +
            (used ? '\n\nتنبيه: يوجد ' + used + ' سجل يستخدم هذا النوع. لن تُحذف السجلات وسيبقى اسم النوع كنص فيها.' : ''),
            { title: 'تأكيد الحذف', danger: true, confirmText: 'احذف', type: 'warning' }
        );
        if (!ok) return;

        const list = all();
        const idx = list.findIndex(x => x.id === id);
        if (idx === -1) return;
        list.splice(idx, 1);

        Store.save([C.KEYS.LEAVE_TYPES]);
        App.Audit.log({ action: 'delete', entity: 'leaveTypes', recordId: id, label: 'حذف نوع: ' + t.name, before: t });
        App.Notify.toast('تم حذف النوع', 'success');
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const host = document.getElementById('typeList');
        if (host) {
            host.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-tact]');
                if (!btn) return;
                const id = btn.dataset.id;
                if (btn.dataset.tact === 'edit') edit(id);
                else if (btn.dataset.tact === 'del') remove(id);
                else if (btn.dataset.tact === 'toggle') toggle(id);
            });
        }

        const addBtn = document.getElementById('btnAddType');
        if (addBtn) addBtn.addEventListener('click', add);

        const nameEl = document.getElementById('newTypeName');
        if (nameEl) {
            nameEl.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); add(); }
            });
        }

        const search = document.getElementById('typeSearch');
        if (search) search.addEventListener('input', App.debounce(render, 250));

        refresh();
    }

    function refresh() {
        populateSelects();
        render();
    }

    return {
        init: init,
        refresh: refresh,
        render: render,
        populateSelects: populateSelects,
        all: all,
        active: active,
        byId: byId,
        byName: byName
    };
})();
