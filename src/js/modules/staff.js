/* ============================================================
   وحدة دليل الموظفين + رصيد الأيام التعويضية
   ============================================================ */
window.App = window.App || {};

App.Staff = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    let inited = false;

    function all() { return Store.get.staff(); }
    function byId(id) { return Store.employeeById(id); }

    /* ---------------- القوائم المنسدلة ---------------- */

    function populateSelects() {
        const list = all().filter(p => p.isActive !== false)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

        const reportEmp = document.getElementById('reportEmpName');
        if (reportEmp) {
            const cur = reportEmp.value;
            reportEmp.innerHTML = list.length
                ? list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
                : '<option value="">لا يوجد موظفون</option>';
            if (cur && byId(cur)) reportEmp.value = cur;
        }
    }

    /* ---------------- الرسم ---------------- */

    function render() {
        const host = document.getElementById('staffList');
        if (!host) return;

        const searchEl = document.getElementById('staffSearch');
        const kw = App.Security.clean(searchEl ? searchEl.value : '').toLowerCase();
        const year = new Date().getFullYear();
        const leaves = Store.get.leaves();

        const list = all().filter(p => {
            if (!kw) return true;
            return (p.name || '').toLowerCase().includes(kw) ||
                (p.jobTitle || '').toLowerCase().includes(kw) ||
                (p.dept || '').toLowerCase().includes(kw) ||
                (p.section || '').toLowerCase().includes(kw) ||
                (p.employeeNumber || '').toLowerCase().includes(kw);
        });

        const emptyEl = document.getElementById('staffEmpty');
        const countEl = document.getElementById('staffCount');
        if (countEl) countEl.textContent = list.length + ' موظف';

        if (!list.length) {
            host.innerHTML = '';
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }
        if (emptyEl) emptyEl.classList.add('hidden');

        host.innerHTML = list.map((p, i) => {
            const balance = App.Security.toInt(p.annualBalance, Store.get.settings().defaultAnnualBalance, 0, 365);
            const used = Store.usedBalance(p.id, year);
            const remaining = balance - used;
            const openComp = Store.openCompensations(p.id);
            const leavesCount = leaves.filter(l => l.empId === p.id).length;

            const remainClass = remaining < 0 ? 'text-rose-700 font-black' : 'text-emerald-700 font-bold';

            return `
                <tr class="hover:bg-slate-50 text-slate-800">
                    <td class="py-2 px-2 border border-slate-200 font-bold">${i + 1}</td>
                    <td class="py-2 px-2 border border-slate-200 text-right font-bold">${esc(p.name)}
                        ${p.isActive === false ? '<span class="badge bg-rose-100 text-rose-700 border-rose-200 mr-1">معطّل</span>' : ''}
                    </td>
                    <td class="py-2 px-2 border border-slate-200 text-right">${esc(p.jobTitle || '-')}</td>
                    <td class="py-2 px-2 border border-slate-200">${esc(p.dept || '-')}${p.section ? ' - <span class="text-slate-500">' + esc(p.section) + '</span>' : ''}</td>
                    <td class="py-2 px-2 border border-slate-200">${esc(p.employeeNumber || '-')}</td>
                    <td class="py-2 px-2 border border-slate-200">${balance}</td>
                    <td class="py-2 px-2 border border-slate-200">${used}</td>
                    <td class="py-2 px-2 border border-slate-200 ${remainClass}">${remaining}</td>
                    <td class="py-2 px-2 border border-slate-200">
                        ${openComp > 0
                            ? `<button type="button" class="badge bg-amber-100 text-amber-800 border-amber-200" data-sact="comp" data-id="${esc(p.id)}">${openComp} يوم مستحق</button>`
                            : '<span class="text-slate-400 text-[10px]">لا يوجد</span>'}
                    </td>
                    <td class="py-2 px-2 border border-slate-200">
                        <div class="flex items-center justify-center gap-1">
                            <button type="button" class="text-brand-600 hover:text-brand-800 p-1 text-[11px]" data-sact="edit" data-id="${esc(p.id)}" title="تعديل"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="text-slate-500 hover:text-slate-800 p-1 text-[11px]" data-sact="history" data-id="${esc(p.id)}" title="سجلات الموظف (${leavesCount})"><i class="fa-solid fa-clock-rotate-left"></i></button>
                            <button type="button" class="text-rose-600 hover:text-rose-800 p-1 text-[11px]" data-sact="del" data-id="${esc(p.id)}" title="حذف"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </td>
                </tr>`;
        }).join('');
    }

    /* ---------------- إضافة وتعديل ---------------- */

    function deptOptions(selected) {
        const opts = [{ value: '', label: '— بدون —' }];
        Store.get.departments().forEach(d => opts.push({ value: d.name, label: d.name }));
        if (selected && !opts.some(o => o.value === selected)) {
            opts.push({ value: selected, label: selected + ' (غير مدرج)' });
        }
        return opts;
    }

    async function add() {
        const res = await App.Notify.form({
            title: 'إضافة موظف إلى الدليل',
            confirmText: 'إضافة',
            fields: [
                { name: 'name', label: 'اسم الموظف *', type: 'text' },
                { name: 'jobTitle', label: 'العنوان الوظيفي', type: 'text' },
                { name: 'dept', label: 'القسم', type: 'select', options: deptOptions() },
                { name: 'section', label: 'الشعبة / الوحدة', type: 'text', hint: 'اختياري — اكتب اسم الشعبة إن وُجدت' },
                { name: 'employeeNumber', label: 'الرقم الوظيفي', type: 'text' },
                { name: 'annualBalance', label: 'الرصيد السنوي (يوم)', type: 'number', value: Store.get.settings().defaultAnnualBalance }
            ]
        });
        if (!res) return;

        const name = App.Security.clean(res.name, 150);
        if (!name) { App.Notify.toast('اسم الموظف مطلوب', 'warning'); return; }
        if (Store.employeeByName(name)) { App.Notify.toast('هذا الاسم موجود في الدليل', 'warning'); return; }

        const emp = {
            id: C.uid('emp'),
            name: name,
            jobTitle: App.Security.clean(res.jobTitle, 150),
            dept: App.Security.clean(res.dept, 120),
            section: App.Security.clean(res.section, 120),
            employeeNumber: App.Security.clean(res.employeeNumber, 40),
            annualBalance: App.Security.toInt(res.annualBalance, Store.get.settings().defaultAnnualBalance, 0, 365),
            isActive: true
        };
        all().push(emp);

        /* ربط أي سجلات سابقة بالاسم نفسه */
        Store.get.leaves().forEach(l => {
            if (!l.empId && Store.normalizeName(l.empName) === Store.normalizeName(name)) l.empId = emp.id;
        });

        Store.save([C.KEYS.STAFF, C.KEYS.LEAVES]);
        App.Audit.log({ action: 'insert', entity: 'staff', recordId: emp.id, label: 'إضافة موظف: ' + name, after: emp });
        App.Notify.toast('تمت إضافة الموظف', 'success');
    }

    async function edit(id) {
        const p = byId(id);
        if (!p) return;

        const res = await App.Notify.form({
            title: 'تعديل بيانات الموظف',
            fields: [
                { name: 'name', label: 'اسم الموظف *', type: 'text', value: p.name },
                { name: 'jobTitle', label: 'العنوان الوظيفي', type: 'text', value: p.jobTitle },
                { name: 'dept', label: 'القسم', type: 'select', options: deptOptions(p.dept), value: p.dept },
                { name: 'section', label: 'الشعبة / الوحدة', type: 'text', value: p.section },
                { name: 'employeeNumber', label: 'الرقم الوظيفي', type: 'text', value: p.employeeNumber },
                { name: 'annualBalance', label: 'الرصيد السنوي (يوم)', type: 'number', value: p.annualBalance },
                { name: 'isActive', label: 'موظف فعّال', type: 'checkbox', value: p.isActive !== false }
            ]
        });
        if (!res) return;

        const name = App.Security.clean(res.name, 150);
        if (!name) { App.Notify.toast('الاسم مطلوب', 'warning'); return; }

        const before = Object.assign({}, p);
        const oldName = p.name;

        p.name = name;
        p.jobTitle = App.Security.clean(res.jobTitle, 150);
        p.dept = App.Security.clean(res.dept, 120);
        p.section = App.Security.clean(res.section, 120);
        p.employeeNumber = App.Security.clean(res.employeeNumber, 40);
        p.annualBalance = App.Security.toInt(res.annualBalance, p.annualBalance, 0, 365);
        p.isActive = !!res.isActive;

        /* تحديث الاسم المخزّن في السجلات المرتبطة */
        if (oldName !== name) {
            Store.get.leaves().forEach(l => {
                if (l.empId === id) l.empName = name;
            });
        }

        Store.save([C.KEYS.STAFF, C.KEYS.LEAVES]);
        App.Audit.log({ action: 'update', entity: 'staff', recordId: id, label: 'تعديل موظف: ' + oldName, before: before, after: p });
        App.Notify.toast('تم التعديل', 'success');
    }

    async function remove(id) {
        const p = byId(id);
        if (!p) return;

        const used = Store.get.leaves().filter(l => l.empId === id).length;
        const ok = await App.Notify.confirm(
            'حذف «' + p.name + '» من دليل الموظفين؟' +
            (used ? '\n\nتنبيه: يوجد ' + used + ' سجل إجازة لهذا الموظف. لن تُحذف السجلات، وستبقى باسمه.' : ''),
            { title: 'تأكيد الحذف', danger: true, confirmText: 'احذف', type: 'warning' }
        );
        if (!ok) return;

        const list = all();
        const idx = list.findIndex(x => x.id === id);
        if (idx === -1) return;
        list.splice(idx, 1);

        Store.save([C.KEYS.STAFF]);
        App.Audit.log({ action: 'delete', entity: 'staff', recordId: id, label: 'حذف موظف: ' + p.name, before: p });
        App.Notify.toast('تم الحذف', 'success');
    }

    /* ---------------- سجل الموظف ---------------- */

    function showHistory(id) {
        const p = byId(id);
        if (!p) return;

        const rows = Store.get.leaves()
            .filter(l => l.empId === id)
            .sort((a, b) => String(b.fromDate).localeCompare(String(a.fromDate)));

        const wrap = document.createElement('div');
        if (!rows.length) {
            wrap.innerHTML = '<p class="text-center py-6 text-slate-400 text-xs font-bold">لا توجد سجلات لهذا الموظف</p>';
        } else {
            wrap.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="w-full text-[11px] text-center border-collapse">
                        <thead>
                            <tr class="bg-slate-100 text-slate-700 font-bold">
                                <th class="py-2 px-2 border border-slate-200">النوع</th>
                                <th class="py-2 px-2 border border-slate-200">من</th>
                                <th class="py-2 px-2 border border-slate-200">إلى</th>
                                <th class="py-2 px-2 border border-slate-200">مخصوم</th>
                                <th class="py-2 px-2 border border-slate-200">تعويضي</th>
                                <th class="py-2 px-2 border border-slate-200">الحالة</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(l => `
                                <tr>
                                    <td class="py-1.5 px-2 border border-slate-200">${esc(l.leaveType || '-')}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">${esc(App.Dates.formatDMY(l.fromDate))}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">${esc(App.Dates.formatDMY(l.toDate))}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">${l.leaveTypeIsHourly ? esc(String(l.hoursCount || 0)) + ' ساعة' : (l.deductedDays || 0)}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">${l.compensatoryDays || 0}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">
                                        <span class="status-chip ${C.STATUS_CLASS[l.status] || ''}">${esc(C.STATUS_LABEL[l.status] || l.status || '')}</span>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        App.Notify.open({
            title: 'سجلات الموظف: ' + p.name,
            type: 'info',
            wide: true,
            contentNode: wrap,
            actions: [{ label: 'إغلاق', value: true, variant: 'ghost' }]
        });
    }

    /* ---------------- الأيام التعويضية ---------------- */

    function showCompensations(id) {
        const p = byId(id);
        if (!p) return;

        const entries = Store.get.compensations().filter(c => c.empId === id)
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

        const wrap = document.createElement('div');
        if (!entries.length) {
            wrap.innerHTML = '<p class="text-center py-6 text-slate-400 text-xs font-bold">لا توجد أيام تعويضية</p>';
        } else {
            wrap.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="w-full text-[11px] text-center border-collapse">
                        <thead>
                            <tr class="bg-slate-100 text-slate-700 font-bold">
                                <th class="py-2 px-2 border border-slate-200">تاريخ الاستحقاق</th>
                                <th class="py-2 px-2 border border-slate-200">الأيام</th>
                                <th class="py-2 px-2 border border-slate-200 text-right">السبب</th>
                                <th class="py-2 px-2 border border-slate-200">الحالة</th>
                                <th class="py-2 px-2 border border-slate-200">إجراء</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${entries.map(c => `
                                <tr>
                                    <td class="py-1.5 px-2 border border-slate-200">${esc(App.Dates.formatDMY(c.date))}</td>
                                    <td class="py-1.5 px-2 border border-slate-200 font-bold">${c.days || 0}</td>
                                    <td class="py-1.5 px-2 border border-slate-200 text-right">${esc(c.reason || '-')}</td>
                                    <td class="py-1.5 px-2 border border-slate-200">
                                        ${c.settled
                                            ? '<span class="status-chip bg-emerald-100 text-emerald-800">مُسدّد</span>'
                                            : '<span class="status-chip bg-amber-100 text-amber-800">مستحق</span>'}
                                    </td>
                                    <td class="py-1.5 px-2 border border-slate-200">
                                        ${c.settled ? esc(c.settledAt || '') :
                                            `<button type="button" class="text-[10px] font-bold text-brand-700" data-cact="settle" data-id="${esc(c.id)}">تسديد</button>`}
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        }

        const open = Store.openCompensations(id);
        const info = document.createElement('p');
        info.className = 'text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-3';
        info.textContent = open > 0
            ? 'إجمالي الأيام التعويضية المستحقة على الموظف: ' + open + ' يوم'
            : 'لا توجد أيام تعويضية مستحقة';

        const holder = document.createElement('div');
        holder.appendChild(wrap);
        holder.appendChild(info);

        let api = null;
        App.Notify.open({
            title: 'الأيام التعويضية: ' + p.name,
            type: 'info',
            wide: true,
            contentNode: holder,
            actions: [{ label: 'إغلاق', value: true, variant: 'ghost' }],
            onReady: (a) => { api = a; }
        });

        holder.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-cact="settle"]');
            if (!btn) return;
            const c = Store.get.compensations().find(x => x.id === btn.dataset.id);
            if (!c) return;

            const ok = await App.Notify.confirm(
                'تسديد ' + (c.days || 1) + ' يوم تعويضي بتاريخ ' + App.Dates.formatDMY(c.date) + '؟',
                { title: 'تسديد يوم تعويضي', confirmText: 'نعم، سدّد' }
            );
            if (!ok) return;

            c.settled = true;
            c.settledAt = App.Dates.todayISO();
            Store.save([C.KEYS.COMPENSATIONS]);
            App.Audit.log({ action: 'settle', entity: 'compensations', recordId: c.id, label: 'تسديد يوم تعويضي: ' + p.name, note: c.settledAt });
            App.Notify.toast('تم تسديد اليوم التعويضي', 'success');
            if (api) api.close(true);
        });
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const host = document.getElementById('staffList');
        if (host) {
            host.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-sact]');
                if (!btn) return;
                const id = btn.dataset.id;
                const act = btn.dataset.sact;
                if (act === 'edit') edit(id);
                else if (act === 'del') remove(id);
                else if (act === 'history') showHistory(id);
                else if (act === 'comp') showCompensations(id);
            });
        }

        const addBtn = document.getElementById('btnAddStaff');
        if (addBtn) addBtn.addEventListener('click', add);

        const exportBtn = document.getElementById('btnExportStaff');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                const year = new Date().getFullYear();
                const rows = [['ت', 'الاسم', 'العنوان الوظيفي', 'القسم', 'الشعبة', 'الرقم الوظيفي',
                    'الرصيد السنوي', 'المستهلك ' + year, 'المتبقي', 'أيام تعويضية مستحقة', 'سجلات الإجازات']];
                all().forEach((p, i) => {
                    const balance = App.Security.toInt(p.annualBalance, Store.get.settings().defaultAnnualBalance, 0, 365);
                    const used = Store.usedBalance(p.id, year);
                    rows.push([
                        i + 1, p.name, p.jobTitle || '', p.dept || '', p.section || '',
                        p.employeeNumber || '', balance, used, balance - used,
                        Store.openCompensations(p.id),
                        Store.get.leaves().filter(l => l.empId === p.id).length
                    ]);
                });
                App.Exporters.excel(
                    [{ name: 'دليل الموظفين', rows: rows, widths: [5, 28, 22, 20, 20, 14, 12, 12, 10, 14, 12] }],
                    'دليل_الموظفين_' + App.Dates.todayISO() + '.xlsx'
                );
                App.Notify.toast('تم تصدير دليل الموظفين', 'success');
            });
        }

        const search = document.getElementById('staffSearch');
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
        byId: byId,
        showHistory: showHistory,
        showCompensations: showCompensations
    };
})();
