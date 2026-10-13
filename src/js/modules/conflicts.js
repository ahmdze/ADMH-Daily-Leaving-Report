/* ============================================================
   وحدة كشف التداخل بين الإجازات
   التداخل = سجلان فعّالان لنفس الموظف تتقاطع مدتهما
   ============================================================ */
window.App = window.App || {};

App.Conflicts = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    function overlaps(aFrom, aTo, bFrom, bTo) {
        if (!aFrom || !bFrom) return false;
        const aEnd = aTo || aFrom;
        const bEnd = bTo || bFrom;
        return aFrom <= bEnd && bFrom <= aEnd;
    }

    /**
     * يبحث عن السجلات المتعارضة.
     * opt = { empId, empName, fromDate, toDate, excludeId, statuses }
     */
    function find(opt) {
        opt = opt || {};
        const from = App.Dates.formatISO(opt.fromDate);
        const to = App.Dates.formatISO(opt.toDate) || from;
        if (!from) return [];

        const statuses = opt.statuses || C.ACTIVE_STATUSES;
        const normName = Store.normalizeName(opt.empName);

        return Store.get.leaves().filter(l => {
            if (opt.excludeId && l.id === opt.excludeId) return false;
            if (statuses.indexOf(l.status) === -1) return false;

            /* مطابقة الموظف: بالمعرّف إن وُجد، وإلا بالاسم */
            if (opt.empId && l.empId) {
                if (l.empId !== opt.empId) return false;
            } else {
                if (Store.normalizeName(l.empName) !== normName) return false;
            }

            return overlaps(from, to, App.Dates.formatISO(l.fromDate), App.Dates.formatISO(l.toDate));
        }).map(l => {
            const lFrom = App.Dates.formatISO(l.fromDate);
            const lTo = App.Dates.formatISO(l.toDate) || lFrom;
            const start = lFrom > from ? lFrom : from;
            const end = lTo < to ? lTo : to;
            return {
                record: l,
                overlapFrom: start,
                overlapTo: end,
                overlapDays: App.Dates.eachDay(start, end)
            };
        }).sort((a, b) => String(a.overlapFrom).localeCompare(String(b.overlapFrom)));
    }

    /**
     * يعرض نافذة التعارض.
     * يُرجع: 'override' | 'edit' | 'cancel'
     */
    function show(conflicts, info) {
        info = info || {};

        const node = document.createElement('div');
        node.className = 'space-y-3';

        node.innerHTML = `
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[11px] text-amber-900 space-y-1">
                <p><strong>الموظف:</strong> ${esc(info.empName || '-')}</p>
                <p><strong>الإجازة الجديدة:</strong> من ${esc(App.Dates.formatDMY(info.fromDate))} إلى ${esc(App.Dates.formatDMY(info.toDate || info.fromDate))}
                   ${info.leaveTypeName ? ' — ' + esc(info.leaveTypeName) : ''}</p>
                <p><strong>عدد التعارضات:</strong> ${conflicts.length}</p>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-[11px] text-center border-collapse">
                    <thead>
                        <tr class="bg-slate-100 text-slate-700 font-bold">
                            <th class="py-2 px-2 border border-slate-200 w-8">#</th>
                            <th class="py-2 px-2 border border-slate-200">النوع</th>
                            <th class="py-2 px-2 border border-slate-200">من</th>
                            <th class="py-2 px-2 border border-slate-200">إلى</th>
                            <th class="py-2 px-2 border border-slate-200">الأيام المتداخلة</th>
                            <th class="py-2 px-2 border border-slate-200">الحالة</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${conflicts.map((c, i) => `
                            <tr>
                                <td class="py-1.5 px-2 border border-slate-200 font-bold">${i + 1}</td>
                                <td class="py-1.5 px-2 border border-slate-200">${esc(c.record.leaveType || '-')}</td>
                                <td class="py-1.5 px-2 border border-slate-200">${esc(App.Dates.formatDMY(c.overlapFrom))}</td>
                                <td class="py-1.5 px-2 border border-slate-200">${esc(App.Dates.formatDMY(c.overlapTo))}</td>
                                <td class="py-1.5 px-2 border border-slate-200">${c.overlapDays.length}</td>
                                <td class="py-1.5 px-2 border border-slate-200">
                                    <span class="status-chip ${C.STATUS_CLASS[c.record.status] || ''}">${esc(C.STATUS_LABEL[c.record.status] || c.record.status || '')}</span>
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <p class="text-[10px] text-slate-500">
                الحفظ مع التجاوز يتطلب إدخال سبب، ويُسجَّل في سجل التدقيق. راجع التواريخ قبل المتابعة.
            </p>`;

        return App.Notify.open({
            title: 'تعارض في الإجازات',
            type: 'warning',
            wide: true,
            contentNode: node,
            actions: [
                { label: 'تعديل التواريخ', value: 'edit', variant: 'primary', icon: 'fa-pen' },
                { label: 'إلغاء الحفظ', value: 'cancel', variant: 'ghost' },
                { label: 'الحفظ مع تجاوز', value: 'override', variant: 'danger', icon: 'fa-triangle-exclamation' }
            ]
        });
    }

    /**
     * فحص كامل + عرض عند وجود تعارض.
     * يُرجع { ok: true } للمتابعة، أو { ok:false, reason } للإلغاء.
     */
    async function check(opt) {
        const list = find(opt);
        if (!list.length) return { ok: true, conflicts: [] };

        const choice = await show(list, opt);

        if (choice === 'edit') return { ok: false, reason: 'edit', conflicts: list };
        if (choice !== 'override') return { ok: false, reason: 'cancel', conflicts: list };

        const reason = await App.Notify.prompt(
            'اكتب سبب تجاوز التعارض (سيُسجَّل في سجل التدقيق):', '',
            { title: 'سبب التجاوز', confirmText: 'متابعة الحفظ', maxLength: 200 }
        );
        if (!reason) return { ok: false, reason: 'cancel', conflicts: list };

        return { ok: true, conflicts: list, overrideReason: reason };
    }

    return {
        find: find,
        show: show,
        check: check,
        overlaps: overlaps
    };
})();
