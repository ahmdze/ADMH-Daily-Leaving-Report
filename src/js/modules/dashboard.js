/* ============================================================
   وحدة الموقف اليومي — الفلاتر والجدول والفرز والترقيم والتصدير
   ============================================================ */
window.App = window.App || {};

App.Dashboard = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    const $ = (id) => document.getElementById(id);
    const val = (id) => { const el = $(id); return el ? el.value : ''; };

    let inited = false;
    let pager = App.Pagination.create({ pageSize: 50, sortKey: 'fromDate', sortDir: 'desc' });

    /* ---------------- نطاق التاريخ المختار ---------------- */

    function currentRange() {
        const mode = val('dashPeriodMode') || 'day';
        const base = val('dashboardFilterDate') || App.Dates.todayISO();

        if (mode === 'day') return { mode: mode, from: base, to: base, label: App.Dates.formatFull(base) };
        if (mode === 'month') {
            const r = App.Dates.monthRange(App.Dates.yearOf(base), App.Dates.monthOf(base));
            return {
                mode: mode, from: r.from, to: r.to,
                label: App.Dates.formatMonth(App.Dates.yearOf(base), App.Dates.monthOf(base))
            };
        }
        if (mode === 'range') {
            const f = val('dashFromDate') || base;
            const t = val('dashToDate') || base;
            const from = f <= t ? f : t;
            const to = f <= t ? t : f;
            return { mode: mode, from: from, to: to, label: 'من ' + App.Dates.formatFull(from) + ' إلى ' + App.Dates.formatFull(to) };
        }
        return { mode: 'all', from: '', to: '', label: 'كل السجلات' };
    }

    /* ---------------- نص تاريخ الترويسة حسب نمط المدة ---------------- */

    function reportDateText(range) {
        if (range.mode === 'day') return App.Dates.formatDMYWithDay(range.from);
        if (range.mode === 'range') return App.Dates.formatDMYRange(range.from, range.to);
        if (range.mode === 'month') return range.label || '';
        return 'كل السجلات';
    }

    /* ---------------- التصفية ---------------- */

    function filtered() {
        const range = currentRange();
        const dept = val('filterDept');
        const type = val('filterLeaveType');
        const status = val('filterStatus');
        const kw = App.Security.clean(val('searchKeyword')).toLowerCase();

        return Store.get.leaves().filter(l => {
            /* التاريخ: تداخل بين مدة الإجازة والنطاق المختار */
            if (range.from) {
                const lFrom = App.Dates.formatISO(l.fromDate);
                const lTo = App.Dates.formatISO(l.toDate) || lFrom;
                if (!(lFrom <= range.to && range.from <= lTo)) return false;
            }
            if (dept && l.dept !== dept) return false;
            if (type && l.leaveType !== type) return false;
            if (status && l.status !== status) return false;
            if (kw) {
                const hay = [
                    l.empName, l.jobTitle, l.dept, l.section,
                    l.leaveType, l.notes, l.empName
                ].map(x => String(x || '').toLowerCase()).join(' ');
                if (!hay.includes(kw)) return false;
            }
            return true;
        });
    }

    /* ---------------- الرسم ---------------- */

    function render() {
        const tbody = $('dashboardTableBody');
        if (!tbody) return;

        const range = currentRange();
        const rows = App.Pagination.sortRows(filtered(), pager.sortKey, pager.sortDir);
        pager.total = rows.length;

        const sizeSel = $('pageSize');
        if (sizeSel) pager.pageSize = App.Security.toInt(sizeSel.value, 50, 0, 100000);
        if (pager.pageSize < 0) pager.pageSize = 0;

        const visible = App.Pagination.slice(pager, rows);

        /* ترويسة التقرير */
        const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
        setText('rptDate', reportDateText(range));
        setText('rptCreatedDate', App.Dates.formatDMY(App.Dates.todayISO()));
        setText('rptCount', App.num(rows.length));
        setText('rptTitle', Store.get.settings().rptTitle || 'موقف الإجازات اليومي للموظفين');

        /* الإحصاءات */
        let casual = 0, hourly = 0, other = 0, daysSum = 0;
        rows.forEach(l => {
            const t = Store.leaveTypeById(l.leaveTypeId) || Store.leaveTypeByName(l.leaveType);
            const isHourly = l.leaveTypeIsHourly || (t && t.isHourly);
            const deducts = t ? t.deductsBalance : /اعتيادية/.test(l.leaveType || '');
            if (isHourly) hourly++;
            else if (deducts) casual++;
            else other++;
            daysSum += App.Security.toInt(l.deductedDays, 0, 0, 100000);
        });
        setText('statTotal', App.num(rows.length));
        setText('statCasual', App.num(casual));
        setText('statHourly', App.num(hourly));
        setText('statOther', App.num(other));
        setText('statDays', App.num(daysSum));

        /* الجدول */
        const emptyEl = $('noDataState');
        tbody.innerHTML = '';

        if (!rows.length) {
            if (emptyEl) emptyEl.classList.remove('hidden');
        } else {
            if (emptyEl) emptyEl.classList.add('hidden');

            const frag = document.createDocumentFragment();
            visible.forEach((l, i) => {
                const t = Store.leaveTypeById(l.leaveTypeId) || Store.leaveTypeByName(l.leaveType);
                const isHourly = l.leaveTypeIsHourly || (t && t.isHourly);
                const color = (t && t.color) || '#0284c7';
                const seq = (pager.pageSize ? (pager.page - 1) * pager.pageSize : 0) + i + 1;

                const tr = document.createElement('tr');
                tr.className = 'hover:bg-slate-50 transition text-slate-800';

                /* المدة */
                let durationHtml;
                if (isHourly) {
                    durationHtml = `<div class="font-bold text-amber-900">${esc(String(l.hoursCount || 0))} ساعة</div>
                        <div class="text-[10px] text-amber-700">من ${esc(l.fromTime || '--')} إلى ${esc(l.toTime || '--')}</div>`;
                } else {
                    const note = l.compensatoryDays
                        ? `<div class="text-[9px] text-amber-700 font-bold">منها ${esc(String(l.compensatoryDays))} تعويضي</div>` : '';
                    durationHtml = `<div class="font-bold text-slate-900">${esc(String(l.deductedDays || 0))} يوم${l.calendarDays && l.calendarDays !== l.deductedDays ? ' <span class="text-[9px] text-slate-400">(تقويمي ' + esc(String(l.calendarDays)) + ')</span>' : ''}</div>
                        <div class="text-[10px] text-slate-500">${esc(App.Dates.formatDMY(l.fromDate))} إلى ${esc(App.Dates.formatDMY(l.toDate))}</div>${note}`;
                }

                const statusClass = C.STATUS_CLASS[l.status] || 'bg-slate-100 text-slate-700';
                const statusLabel = C.STATUS_LABEL[l.status] || l.status || '';
                const notes = (l.notes || '') + (l.holidayNote ? (l.notes ? ' — ' : '') + l.holidayNote : '');

                const deptHtml = `<div class="p-dept-name">${esc(l.dept || '-')}</div>` +
                    (l.section ? `<div class="p-dept-section">${esc(l.section)}</div>` : '');

                tr.innerHTML = `
                    <td class="py-2 px-2 border border-slate-300 font-bold">${seq}</td>
                    <td class="py-2 px-2 border border-slate-300 text-right font-bold text-slate-900 p-name">${esc(l.empName)}</td>
                    <!-- العنوان الوظيفي: الصنف على عنصر داخلي لا على الخلية نفسها،
                         لأن تغيير display على td يُخرجها من نظام الجدول فيختلف ارتفاع الصف -->
                    <td class="py-2 px-2 border border-slate-300 text-right text-slate-700"><div class="p-job">${esc(l.jobTitle || '-')}</div></td>
                    <td class="py-2 px-2 border border-slate-300">${deptHtml}</td>
                    <td class="py-2 px-2 border border-slate-300">
                        <span class="badge" style="background:${esc(color)}18;color:${esc(color)};border-color:${esc(color)}55">${esc(l.leaveType || '-')}</span>
                    </td>
                    <td class="py-2 px-2 border border-slate-300 text-center">${durationHtml}</td>
                    <td class="py-2 px-2 border border-slate-300 text-right text-slate-600 p-notes">${esc(notes || '-')}</td>
                    <td class="py-2 px-2 border border-slate-300 no-print no-export"><span class="status-chip ${statusClass}">${esc(statusLabel)}</span></td>
                    <td class="py-2 px-2 border border-slate-300 no-print">
                        <div class="flex items-center justify-center gap-1">
                            <button type="button" class="text-brand-600 hover:text-brand-800 p-1 text-[11px]" data-dact="edit" data-id="${esc(l.id)}" title="تعديل"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="text-violet-600 hover:text-violet-800 p-1 text-[11px]" data-dact="status" data-id="${esc(l.id)}" title="تغيير الحالة"><i class="fa-solid fa-circle-half-stroke"></i></button>
                            <button type="button" class="text-rose-600 hover:text-rose-800 p-1 text-[11px]" data-dact="del" data-id="${esc(l.id)}" title="حذف"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </td>`;
                frag.appendChild(tr);
            });
            tbody.appendChild(frag);
        }

        /* الترقيم */
        const infoEl = $('pageInfo');
        if (infoEl) infoEl.textContent = App.Pagination.rangeText(pager);
        App.Pagination.renderPager($('pageNumbers'), pager, (p) => { pager.page = p; render(); });
        App.Pagination.paintSortHeaders($('dashboardTable'), pager);

        const pc = App.Pagination.pageCount(pager);
        document.querySelectorAll('.pager-btn').forEach(btn => {
            const act = btn.dataset.page;
            btn.disabled = (act === 'first' || act === 'prev') ? pager.page <= 1 : pager.page >= pc;
        });
    }

    /* ---------------- إظهار سجل محدد بعد الحفظ ----------------
       إن كان السجل المحفوظ خارج النطاق المعروض (مثلاً إجازة بأثر رجعي
       أو مستقبلية) نعرض موقف الشهر الذي يقع فيه حتى لا يبدو كأن الحفظ فشل. */

    function focusRecord(rec) {
        if (!rec || !rec.fromDate) return false;

        const range = currentRange();
        const lFrom = App.Dates.formatISO(rec.fromDate);
        const lTo = App.Dates.formatISO(rec.toDate) || lFrom;

        const visible = !range.from || (lFrom <= range.to && range.from <= lTo);
        if (visible) return false;

        const modeEl = $('dashPeriodMode');
        if (modeEl) modeEl.value = 'month';
        const dateEl = $('dashboardFilterDate');
        if (dateEl) dateEl.value = lFrom;

        /* تفريغ الفلاتر التي قد تخفي السجل */
        ['filterDept', 'filterLeaveType', 'filterStatus', 'searchKeyword'].forEach(id => {
            const el = $(id);
            if (el && el.value) el.value = '';
        });

        updatePeriodUI();
        pager.page = 1;
        render();
        return true;
    }

    /* ---------------- العمليات ---------------- */

    async function removeRecord(id) {
        const l = Store.get.leaves().find(r => r.id === id);
        if (!l) return;

        const ok = await App.Notify.confirm(
            'حذف سجل إجازة «' + l.empName + '» (' + l.leaveType + ') من ' +
            App.Dates.formatISO(l.fromDate) + ' إلى ' + App.Dates.formatISO(l.toDate) + '؟',
            { title: 'تأكيد الحذف', danger: true, confirmText: 'نعم، احذف', type: 'warning' }
        );
        if (!ok) return;

        const leaves = Store.get.leaves();
        const idx = leaves.findIndex(r => r.id === id);
        if (idx === -1) return;
        const before = leaves[idx];
        leaves.splice(idx, 1);

        /* حذف الاستحقاقات التعويضية غير المسددة المرتبطة به */
        const comps = Store.get.compensations();
        for (let i = comps.length - 1; i >= 0; i--) {
            if (comps[i].leaveId === id && !comps[i].settled) comps.splice(i, 1);
        }

        Store.save([C.KEYS.LEAVES, C.KEYS.COMPENSATIONS]);
        App.Audit.log({
            action: 'delete', entity: 'leaves', recordId: id,
            label: 'حذف إجازة: ' + before.empName + ' — ' + before.leaveType, before: before
        });
        App.Notify.toast('تم حذف السجل', 'success');
    }

    function changeStatus(id) {
        const l = Store.get.leaves().find(r => r.id === id);
        if (!l) return;

        const body = document.createElement('div');
        body.className = 'space-y-2';
        body.innerHTML = `
            <p class="text-xs text-slate-600">السجل: <strong>${esc(l.empName)}</strong> — ${esc(l.leaveType || '')}</p>
            <select id="statusPick" class="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm outline-none">
                ${Object.keys(C.STATUS_LABEL).map(k =>
                    `<option value="${k}" ${l.status === k ? 'selected' : ''}>${esc(C.STATUS_LABEL[k])}</option>`).join('')}
            </select>`;

        App.Notify.open({
            title: 'تغيير حالة السجل',
            type: 'question',
            contentNode: body,
            actions: [
                { label: 'إلغاء', value: null, variant: 'ghost' },
                {
                    label: 'حفظ الحالة', value: 'ok', variant: 'primary', icon: 'fa-check'
                }
            ]
        }).then(res => {
            if (res !== 'ok') return;
            const sel = document.getElementById('statusPick');
            const newStatus = sel ? sel.value : l.status;
            if (newStatus === l.status) return;
            const before = l.status;
            l.status = newStatus;
            l.updatedAt = new Date().toISOString();
            Store.save([C.KEYS.LEAVES]);
            App.Audit.log({
                action: 'update', entity: 'leaves', recordId: id,
                label: 'تغيير حالة سجل ' + l.empName + ': ' + (C.STATUS_LABEL[before] || before) + ' ← ' + (C.STATUS_LABEL[newStatus] || newStatus)
            });
            App.Notify.toast('تم تحديث الحالة', 'success');
        });
    }

    /* ---------------- التهيئة ---------------- */

    /* ---------------- إظهار كل الصفوف مؤقتاً عند التصدير ----------------
       الطباعة والتصدير يجب أن يشمل كل السجلات المطابقة للفلاتر، لا الصفحة
       المعروضة فقط. نضبط حجم الصفحة على «الكل» ثم نعيد الحالة كما كانت. */
    function restoreRows(saved) {
        const sizeSel = $('pageSize');
        if (sizeSel) sizeSel.value = saved.value;
        else pager.pageSize = saved.pageSize;
        pager.page = saved.page;
        render();
    }

    function withAllRows(task) {
        const sizeSel = $('pageSize');
        const saved = {
            value: sizeSel ? sizeSel.value : '50',
            page: pager.page,
            pageSize: pager.pageSize
        };

        if (sizeSel) sizeSel.value = '0';
        else pager.pageSize = 0;
        pager.page = 1;
        render();

        let result;
        try {
            result = task();
        } catch (e) {
            restoreRows(saved);
            throw e;
        }

        if (result && typeof result.then === 'function') {
            return result.then(
                (v) => { restoreRows(saved); return v; },
                (e) => { restoreRows(saved); throw e; }
            );
        }
        restoreRows(saved);
        return result;
    }

    function updatePeriodUI() {
        const mode = val('dashPeriodMode') || 'day';
        const rangeBox = $('dashRangeBox');
        if (rangeBox) {
            rangeBox.classList.toggle('hidden', mode !== 'range');
            rangeBox.classList.toggle('flex', mode === 'range');
        }
        const dateWrap = $('dashboardFilterDate');
        if (dateWrap && dateWrap.parentElement) {
            dateWrap.parentElement.classList.toggle('hidden', mode === 'all');
        }
        if (mode === 'range' && !val('dashFromDate')) {
            const today = App.Dates.todayISO();
            const fromEl = $('dashFromDate'), toEl = $('dashToDate');
            if (fromEl) fromEl.value = App.Dates.monthRange(App.Dates.yearOf(today), App.Dates.monthOf(today)).from;
            if (toEl) toEl.value = today;
        }
    }

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const rerender = () => { pager.page = 1; render(); };

        ['dashboardFilterDate', 'dashFromDate', 'dashToDate', 'dashPeriodMode',
            'filterDept', 'filterLeaveType', 'filterStatus'].forEach(id => {
                const el = $(id);
                if (!el) return;
                el.addEventListener('change', () => { updatePeriodUI(); rerender(); });
            });

        const kw = $('searchKeyword');
        if (kw) kw.addEventListener('input', App.debounce(rerender, 300));

        const sizeSel = $('pageSize');
        if (sizeSel) sizeSel.addEventListener('change', () => { pager.page = 1; render(); });

        const clearBtn = $('btnClearFilters');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                ['filterDept', 'filterLeaveType', 'filterStatus', 'searchKeyword'].forEach(id => {
                    const el = $(id); if (el) el.value = '';
                });
                const base = $('dashboardFilterDate');
                if (base) base.value = App.Dates.todayISO();
                const mode = $('dashPeriodMode');
                if (mode) mode.value = 'day';
                updatePeriodUI();
                rerender();
            });
        }

        /* أزرار الترقيم */
        const pagerHost = $('pagerControls');
        if (pagerHost) {
            pagerHost.addEventListener('click', (e) => {
                const btn = e.target.closest('.pager-btn');
                if (!btn || btn.disabled) return;
                const pc = App.Pagination.pageCount(pager);
                if (btn.dataset.page === 'first') pager.page = 1;
                else if (btn.dataset.page === 'prev') pager.page = Math.max(1, pager.page - 1);
                else if (btn.dataset.page === 'next') pager.page = Math.min(pc, pager.page + 1);
                else if (btn.dataset.page === 'last') pager.page = pc;
                render();
            });
        }

        /* الفرز من رؤوس الجدول */
        const table = $('dashboardTable');
        if (table) {
            table.addEventListener('click', (e) => {
                const th = e.target.closest('th[data-sort]');
                if (!th) return;
                App.Pagination.toggleSort(pager, th.dataset.sort);
                pager.page = 1;
                render();
            });
        }

        /* إجراءات الصفوف */
        const tbody = $('dashboardTableBody');
        if (tbody) {
            tbody.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-dact]');
                if (!btn) return;
                const id = btn.dataset.id;
                if (btn.dataset.dact === 'edit') {
                    App.App.goTab('entry');
                    App.Entry.editRecord(id);
                } else if (btn.dataset.dact === 'del') {
                    removeRecord(id);
                } else if (btn.dataset.dact === 'status') {
                    changeStatus(id);
                }
            });
        }

        /* التصدير
           مهم: الجدول مُقسَّم بصفحات داخلية، فلو صدّرنا المعروض فقط لضاعت
           السجلات الواقعة في الصفحات التالية (شهر فيه 200 سجل كان يُطبع 50).
           لذلك نُظهر كل الصفوف مؤقتاً ثم نُعيد حالة الترقيم كما كانت. */
        const excelBtn = $('btnDashExcel');
        if (excelBtn) {
            excelBtn.addEventListener('click', () => {
                withAllRows(() => {
                    const range = currentRange();
                    const name = 'موقف_الإجازات_' + App.Security.safeFileName(Store.get.settings().hospital || 'المستشفى') +
                        '_' + (range.from || 'all') + '.xlsx';
                    App.Exporters.excelFromTable($('dashboardTable'), name, 'موقف الإجازات');
                    App.Notify.toast('تم تصدير ملف Excel', 'success');
                });
            });
        }

        /* أُزيل زر تصدير PDF من الواجهة: الطباعة فقط (مع Excel). */

        const printBtn = $('btnDashPrint');
        if (printBtn) {
            printBtn.addEventListener('click', () => {
                withAllRows(() => App.Exporters.printElement(
                    document.getElementById('printableArea'), 'موقف الإجازات اليومي'));
            });
        }

        const logo = $('rptLogoImg');
        if (logo) {
            const s = Store.get.settings();
            if (s.logoBase64) logo.src = s.logoBase64;
        }

        updatePeriodUI();
        refresh();
    }

    /** طباعة الموقف من أي مكان (يستدعيه اختصار Ctrl+P في app.js)
     *  مع ضمان شمول كل السجلات لا الصفحة المعروضة فقط. */
    function printNow() {
        return withAllRows(() => App.Exporters.printElement(
            document.getElementById('printableArea'), 'موقف الإجازات اليومي'));
    }

    function refresh() {
        render();
    }

    return {
        init: init,
        refresh: refresh,
        render: render,
        filtered: filtered,
        currentRange: currentRange,
        focusRecord: focusRecord,
        printNow: printNow,
        setPageSize: (n) => { pager.pageSize = n; pager.page = 1; render(); }
    };
})();
