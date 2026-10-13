/* ============================================================
   وحدة العطل الرسمية — إضافة وتعديل وحذف وتهيئة سنوية
   لكل عطلة ثلاث حالات:
     null  = اتبع السياسة العامة في الإعدادات
     false = العطلة من ضمن الإجازة ولا تؤثر على الأيام
     true  = العطلة تُستثنى من الإجازة ويُستحق يوم تعويضي
   ============================================================ */
window.App = window.App || {};

App.Holidays = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    let inited = false;

    function all() { return Store.get.holidays(); }

    /** فهرس سريع للاحتكام إليه في محرك حساب الأيام */
    function index() {
        return App.Dates.buildHolidayIndex(all());
    }

    function years() {
        const set = {};
        all().forEach(h => { if (h.date) set[String(h.date).slice(0, 4)] = true; });
        set[String(new Date().getFullYear())] = true;
        return Object.keys(set).sort().reverse();
    }

    /* ---------------- الرسم ---------------- */

    function render() {
        const host = document.getElementById('holidayList');
        if (!host) return;

        const searchEl = document.getElementById('holidaySearch');
        const yearEl = document.getElementById('holidayYearFilter');
        const kw = App.Security.clean(searchEl ? searchEl.value : '').toLowerCase();
        const yearFilter = yearEl ? yearEl.value : '';

        /* تحديث فلتر السنوات */
        if (yearEl) {
            const cur = yearEl.value;
            const ys = years();
            yearEl.innerHTML = '<option value="">جميع السنوات</option>' +
                ys.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('');
            yearEl.value = cur;
        }

        let list = all().slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));

        if (yearFilter) list = list.filter(h => String(h.date).slice(0, 4) === yearFilter);
        if (kw) list = list.filter(h => (h.name || '').toLowerCase().includes(kw));

        const countEl = document.getElementById('holidayCount');
        if (countEl) countEl.textContent = list.length + ' عطلة';

        const emptyEl = document.getElementById('holidayEmpty');
        if (!list.length) {
            host.innerHTML = '';
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }
        if (emptyEl) emptyEl.classList.add('hidden');

        host.innerHTML = list.map((h, i) => {
            const dow = App.Dates.dayName(h.date);
            const isWeekend = App.Dates.isWeekend(h.date);
            return `
                <tr class="hover:bg-slate-50 text-slate-800">
                    <td class="py-2 px-2 border border-slate-200 font-bold">${i + 1}</td>
                    <td class="py-2 px-2 border border-slate-200 text-right font-bold">${esc(h.name)}</td>
                    <td class="py-2 px-2 border border-slate-200">${esc(App.Dates.formatDMY(h.date))}</td>
                    <td class="py-2 px-2 border border-slate-200 ${isWeekend ? 'text-slate-400' : ''}">${esc(dow)}</td>
                    <td class="py-2 px-2 border border-slate-200">
                        ${h.recurring ? '<i class="fa-solid fa-check text-emerald-600"></i>' : '<span class="text-slate-300">—</span>'}
                    </td>
                    <td class="py-2 px-2 border border-slate-200">
                        <select class="bg-white border border-slate-300 rounded-lg px-1.5 py-1 text-[10px] font-bold outline-none" data-hact="mode" data-id="${esc(h.id)}">
                            <option value="null" ${h.excluded === null || h.excluded === undefined ? 'selected' : ''}>حسب السياسة</option>
                            <option value="false" ${h.excluded === false ? 'selected' : ''}>داخل الإجازة</option>
                            <option value="true" ${h.excluded === true ? 'selected' : ''}>تُستثنى</option>
                        </select>
                    </td>
                    <td class="py-2 px-2 border border-slate-200">
                        <div class="flex items-center justify-center gap-1">
                            <button type="button" class="text-brand-600 hover:text-brand-800 p-1 text-[11px]" data-hact="edit" data-id="${esc(h.id)}" title="تعديل"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="text-rose-600 hover:text-rose-800 p-1 text-[11px]" data-hact="del" data-id="${esc(h.id)}" title="حذف"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </td>
                </tr>`;
        }).join('');
    }

    /* ---------------- العمليات ---------------- */

    function modeLabel() {
        const s = Store.get.settings();
        return s.holidayMode === 'excluded'
            ? 'تُستثنى من الإجازة (تُنشئ يوماً تعويضياً)'
            : 'من ضمن الإجازة (لا تؤثر على الأيام)';
    }

    async function add() {
        const today = App.Dates.todayISO();
        const res = await App.Notify.form({
            title: 'إضافة عطلة رسمية',
            confirmText: 'إضافة',
            fields: [
                { name: 'name', label: 'اسم العطلة *', type: 'text', placeholder: 'مثال: عيد الفطر' },
                { name: 'date', label: 'التاريخ *', type: 'date', value: today },
                { name: 'recurring', label: 'تتكرر سنوياً في التاريخ الميلادي نفسه', type: 'checkbox', value: false },
                {
                    name: 'excluded', label: 'معاملة العطلة داخل الإجازة', type: 'select',
                    options: [
                        { value: 'null', label: 'حسب السياسة العامة (' + modeLabel() + ')' },
                        { value: 'false', label: 'من ضمن الإجازة — لا تؤثر على الأيام' },
                        { value: 'true', label: 'تُستثنى — يُستحق يوم تعويضي' }
                    ],
                    value: 'null'
                }
            ]
        });
        if (!res) return;

        const name = App.Security.clean(res.name, 120);
        if (!name) { App.Notify.toast('اسم العطلة مطلوب', 'warning'); return; }
        if (!App.Security.isIsoDate(res.date)) { App.Notify.toast('تاريخ غير صالح', 'warning'); return; }

        const dup = all().find(h => h.date === res.date && h.name === name);
        if (dup) { App.Notify.toast('هذه العطلة مسجلة مسبقاً', 'warning'); return; }

        const rec = {
            id: C.uid('hol'),
            date: res.date,
            name: name,
            recurring: !!res.recurring,
            excluded: res.excluded === 'true' ? true : (res.excluded === 'false' ? false : null)
        };
        all().push(rec);
        Store.save([C.KEYS.HOLIDAYS]);
        App.Audit.log({ action: 'insert', entity: 'holidays', recordId: rec.id, label: 'إضافة عطلة: ' + name + ' (' + rec.date + ')', after: rec });
        App.Notify.toast('تمت إضافة العطلة', 'success');
    }

    async function edit(id) {
        const h = all().find(x => x.id === id);
        if (!h) return;

        const res = await App.Notify.form({
            title: 'تعديل عطلة رسمية',
            fields: [
                { name: 'name', label: 'اسم العطلة *', type: 'text', value: h.name },
                { name: 'date', label: 'التاريخ *', type: 'date', value: h.date },
                { name: 'recurring', label: 'تتكرر سنوياً في التاريخ الميلادي نفسه', type: 'checkbox', value: !!h.recurring },
                {
                    name: 'excluded', label: 'معاملة العطلة داخل الإجازة', type: 'select',
                    options: [
                        { value: 'null', label: 'حسب السياسة العامة (' + modeLabel() + ')' },
                        { value: 'false', label: 'من ضمن الإجازة — لا تؤثر على الأيام' },
                        { value: 'true', label: 'تُستثنى — يُستحق يوم تعويضي' }
                    ],
                    value: h.excluded === null || h.excluded === undefined ? 'null' : String(h.excluded)
                }
            ]
        });
        if (!res) return;

        const name = App.Security.clean(res.name, 120);
        if (!name) { App.Notify.toast('الاسم مطلوب', 'warning'); return; }
        if (!App.Security.isIsoDate(res.date)) { App.Notify.toast('تاريخ غير صالح', 'warning'); return; }

        const before = Object.assign({}, h);
        h.name = name;
        h.date = res.date;
        h.recurring = !!res.recurring;
        h.excluded = res.excluded === 'true' ? true : (res.excluded === 'false' ? false : null);

        Store.save([C.KEYS.HOLIDAYS]);
        App.Audit.log({ action: 'update', entity: 'holidays', recordId: id, label: 'تعديل عطلة: ' + name, before: before, after: h });
        App.Notify.toast('تم التعديل', 'success');
    }

    function setMode(id, value) {
        const h = all().find(x => x.id === id);
        if (!h) return;
        const before = h.excluded;
        h.excluded = value === 'true' ? true : (value === 'false' ? false : null);
        Store.save([C.KEYS.HOLIDAYS]);
        App.Audit.log({
            action: 'update', entity: 'holidays', recordId: id,
            label: 'تغيير معاملة العطلة: ' + h.name,
            before: { excluded: before }, after: { excluded: h.excluded }
        });
        App.Notify.toast('تم تحديث معاملة العطلة', 'success');
    }

    async function remove(id) {
        const h = all().find(x => x.id === id);
        if (!h) return;
        const ok = await App.Notify.confirm('حذف عطلة «' + h.name + '» بتاريخ ' + App.Dates.formatDMY(h.date) + '؟',
            { title: 'تأكيد الحذف', danger: true, confirmText: 'احذف', type: 'warning' });
        if (!ok) return;

        const list = all();
        const idx = list.findIndex(x => x.id === id);
        if (idx === -1) return;
        list.splice(idx, 1);

        Store.save([C.KEYS.HOLIDAYS]);
        App.Audit.log({ action: 'delete', entity: 'holidays', recordId: id, label: 'حذف عطلة: ' + h.name, before: h });
        App.Notify.toast('تم الحذف', 'success');
    }

    /** تهيئة العطل الثابتة لسنة من القالب العراقي */
    async function seedForYear() {
        const y = await App.Notify.prompt('أدخل السنة المطلوب تهيئتها:', new Date().getFullYear(),
            { title: 'تهيئة العطل الثابتة', inputType: 'number', confirmText: 'تهيئة' });
        if (!y) return;

        const year = App.Security.toInt(y, 0, 2000, 2100);
        if (!year) { App.Notify.toast('سنة غير صالحة', 'warning'); return; }

        const existing = {};
        all().forEach(h => { existing[h.date + '|' + h.name] = true; });

        let added = 0;
        C.IRAQ_HOLIDAY_TEMPLATE.forEach((t, i) => {
            const date = year + '-' + App.Dates.pad2(t.month) + '-' + App.Dates.pad2(t.day);
            if (existing[date + '|' + t.name]) return;
            all().push({
                id: 'hol-' + year + '-' + (i + 1) + '-' + Math.random().toString(36).slice(2, 6),
                date: date,
                name: t.name,
                recurring: true,
                excluded: null
            });
            added++;
        });

        if (!added) {
            App.Notify.toast('كل عطل سنة ' + year + ' الثابتة موجودة مسبقاً', 'info');
            return;
        }

        Store.save([C.KEYS.HOLIDAYS]);
        App.Audit.log({ action: 'insert', entity: 'holidays', label: 'تهيئة ' + added + ' عطلة ثابتة لسنة ' + year });
        App.Notify.toast('تمت إضافة ' + added + ' عطلة لسنة ' + year, 'success');
    }

    /** تذكير بالعطل المتحركة (هجرية) — تُدخل يدوياً */
    function showMovableHint() {
        const body = document.createElement('div');
        body.className = 'text-xs space-y-2';
        body.innerHTML = `
            <p class="font-bold text-slate-700">العطل التالية هجرية وتتغيّر سنوياً، لذلك لا يمكن توليدها تلقائياً. أضفها يدوياً لكل سنة:</p>
            <div class="flex flex-wrap gap-1.5">
                ${C.MOVABLE_HOLIDAY_HINT.map(n => `<span class="badge bg-slate-100 text-slate-700 border-slate-200">${esc(n)}</span>`).join('')}
            </div>
            <p class="text-[11px] text-slate-500">يمكنك الحصول على تواريخها الميلادية من التقويم الرسمي لدائرتك ثم إضافتها بزر «إضافة عطلة».</p>`;
        App.Notify.open({
            title: 'العطل المتحركة (الهجرية)',
            type: 'info',
            contentNode: body,
            actions: [{ label: 'فهمت', value: true, variant: 'primary' }]
        });
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const host = document.getElementById('holidayList');
        if (host) {
            host.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-hact]');
                if (!btn || btn.dataset.hact === 'mode') return;
                if (btn.dataset.hact === 'edit') edit(btn.dataset.id);
                else if (btn.dataset.hact === 'del') remove(btn.dataset.id);
            });
            host.addEventListener('change', (e) => {
                const sel = e.target.closest('[data-hact="mode"]');
                if (!sel) return;
                setMode(sel.dataset.id, sel.value);
            });
        }

        const addBtn = document.getElementById('btnAddHoliday');
        if (addBtn) addBtn.addEventListener('click', add);

        const seedBtn = document.getElementById('btnSeedHolidays');
        if (seedBtn) {
            seedBtn.addEventListener('click', () => {
                App.Notify.confirm('سيتم إضافة العطل الرسمية الثابتة (رأس السنة، الجيش، نوروز، العمال، 14 تموز، الاستقلال، يوم النصر) لسنة تختارها.\n\nملاحظة: العطل الهجرية المتحركة تُضاف يدوياً.',
                    { title: 'تهيئة العطل الثابتة', confirmText: 'متابعة', type: 'question' }
                ).then(ok => { if (ok) seedForYear(); });
            });
        }

        const hintBtn = document.getElementById('btnMovableHint');
        if (hintBtn) hintBtn.addEventListener('click', showMovableHint);

        const exportBtn = document.getElementById('btnExportHolidays');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                const rows = [['ت', 'اسم العطلة', 'التاريخ', 'اليوم', 'تتكرر سنوياً', 'داخل الإجازة']];
                all().slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((h, i) => {
                    rows.push([
                        i + 1, h.name, App.Dates.formatDMY(h.date), App.Dates.dayName(h.date),
                        h.recurring ? 'نعم' : 'لا',
                        (h.excluded === null || h.excluded === undefined) ? 'حسب السياسة'
                            : (h.excluded ? 'لا - تُستثنى' : 'نعم')
                    ]);
                });
                App.Exporters.excel([{ name: 'العطل الرسمية', rows: rows, widths: [5, 30, 14, 12, 14, 18] }],
                    'العطل_الرسمية_' + App.Dates.todayISO() + '.xlsx');
                App.Notify.toast('تم تصدير العطل', 'success');
            });
        }

        const search = document.getElementById('holidaySearch');
        if (search) search.addEventListener('input', App.debounce(render, 250));

        const yearFilter = document.getElementById('holidayYearFilter');
        if (yearFilter) yearFilter.addEventListener('change', render);

        refresh();
    }

    function refresh() {
        render();
    }

    return {
        init: init,
        refresh: refresh,
        render: render,
        index: index,
        all: all,
        seedHolidays: Store.seedHolidays
    };
})();
