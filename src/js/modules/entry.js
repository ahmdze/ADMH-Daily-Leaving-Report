/* ============================================================
   وحدة إدخال وتعديل الإجازات + الاحتساب الفوري + حماية الفورم
   ============================================================ */
window.App = window.App || {};

App.Entry = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    let inited = false;
    let dirty = false;

    /* ---------------- مساعدات العناصر ---------------- */

    const $ = (id) => document.getElementById(id);
    const val = (id) => { const el = $(id); return el ? el.value : ''; };

    function setVal(id, v) {
        const el = $(id);
        if (el) el.value = v === undefined || v === null ? '' : v;
    }

    /* ---------------- حالة الفورم ----------------
       «التغيير غير المحفوظ» يُحسب بمقارنة بصمة الحقول بالبصمة المرجعية،
       لا برفع علم عند أي حدث — لأن إعادة تعبئة القوائم المنسدلة
       برمجياً تُطلق أحداث change كاذبة. */

    const SIGNATURE_FIELDS = [
        'entryEditId', 'entryEmpName', 'entryJobTitle', 'entryDept', 'entrySection',
        'entryType', 'entryStatus', 'entryNotes', 'entryLeaveDate',
        'entryFromDate', 'entryToDate', 'entryDaysCount',
        'entryFromTime', 'entryToTime', 'entryHoursCount'
    ];

    let baseline = '';

    function signature() {
        return SIGNATURE_FIELDS.map(id => val(id)).join('\u0001');
    }

    function refreshDirtyHint() {
        const isDirtyNow = isDirty();
        const hint = $('entryDirtyHint');
        if (hint) hint.classList.toggle('hidden', !isDirtyNow);
        const form = $('entryForm');
        if (form) form.classList.toggle('is-dirty', isDirtyNow);
        return isDirtyNow;
    }

    function markDirty() { return refreshDirtyHint(); }

    function clearDirty() {
        baseline = signature();
        dirty = false;
        refreshDirtyHint();
    }

    function isDirty() { return signature() !== baseline; }

    /* ---------------- القوائم ---------------- */

    function populateSections() {
        const deptName = val('entryDept');
        const sel = $('entrySection');
        if (!sel) return;

        const secs = App.Org.sectionsOf(deptName);
        const cur = sel.value;
        sel.innerHTML = '<option value="">بدون شعبة</option>' +
            secs.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
        sel.value = secs.some(s => s.name === cur) ? cur : '';
    }

    /** يعرض حقول الأيام أو حقول الساعات حسب نوع الإجازة */
    function toggleFields() {
        const typeId = val('entryType');
        const t = Store.leaveTypeById(typeId);
        const isHourly = t ? !!t.isHourly : false;

        const daysBox = $('daysRangeContainer');
        const timeBox = $('timeRangeBox');
        if (daysBox) daysBox.classList.toggle('hidden', isHourly);
        if (timeBox) timeBox.classList.toggle('hidden', !isHourly);
    }

    /* ---------------- الاحتساب الفوري ---------------- */

    function currentAnalysis() {
        const typeId = val('entryType');
        const t = Store.leaveTypeById(typeId);
        const s = Store.get.settings();
        const isHourly = t ? !!t.isHourly : false;

        if (isHourly) {
            return App.Dates.analyze({
                isHourly: true,
                fromDate: val('entryLeaveDate'),
                hoursCount: val('entryHoursCount'),
                deductsBalance: t ? t.deductsBalance : false,
                holidays: Store.get.holidays()
            });
        }

        return App.Dates.analyze({
            isHourly: false,
            fromDate: val('entryFromDate'),
            toDate: val('entryToDate') || val('entryFromDate'),
            deductsBalance: t ? t.deductsBalance : true,
            holidayMode: s.holidayMode,
            countWeekend: s.countWeekend,
            holidays: Store.get.holidays()
        });
    }

    function renderAnalysis() {
        const host = $('entryAnalysis');
        if (!host) return;

        const a = currentAnalysis();
        const typeId = val('entryType');
        const t = Store.leaveTypeById(typeId);

        if (!a.valid) {
            host.innerHTML = `<p class="text-slate-400 font-bold">${esc(a.error || 'أكمل البيانات لعرض الاحتساب')}</p>`;
            return;
        }

        const row = (label, value, cls) => `
            <div class="flex items-center justify-between gap-2 border-b border-slate-100 pb-1">
                <span class="text-slate-500">${esc(label)}</span>
                <span class="${cls || 'font-bold text-slate-800'}">${value}</span>
            </div>`;

        let html = '';
        html += row('نوع الإجازة', esc(t ? t.name : '—'));
        html += row('تخصم من الرصيد', t && t.deductsBalance ? '<span class="text-emerald-700">نعم</span>' : '<span class="text-slate-500">لا</span>');

        if (a.isHourly) {
            html += row('التاريخ', esc(a.fromDate || '—'));
            html += row('عدد الساعات', a.hoursCount);
        } else {
            html += row('المدة', esc(a.fromDate) + ' ← ' + esc(a.toDate));
            html += row('إجمالي الأيام التقويمية', a.calendarDays);
            html += row('أيام العمل الفعلية', a.workingDays);
            html += row('أيام الراحة الأسبوعية', a.weekendDays);
        }

        if (a.holidays.length) {
            html += `<div class="bg-amber-50 border border-amber-200 rounded-lg p-2 mt-1">
                        <p class="font-bold text-amber-900 mb-1">عطل رسمية داخل المدة (${a.holidays.length}):</p>
                        <ul class="space-y-0.5 text-amber-900">
                            ${a.holidays.map(h => `<li>• ${esc(App.Dates.formatISO(h.date))} — ${esc(h.name)}
                                ${a.excludedHolidays.some(x => x.date === h.date) ? '<span class="badge bg-amber-200 text-amber-900 border-amber-300">مستثناة</span>' : ''}</li>`).join('')}
                        </ul>
                     </div>`;
        }

        html += `<div class="pt-1"></div>`;
        html += row('الأيام المخصومة من الرصيد', a.deductedDays + ' يوم', 'font-black text-brand-700 text-sm');
        if (a.compensatoryDays > 0) {
            html += row('أيام تعويضية على الموظف', a.compensatoryDays + ' يوم', 'font-black text-amber-700 text-sm');
        }

        host.innerHTML = html;
    }

    function renderPolicy() {
        const host = $('entryPolicy');
        if (!host) return;
        const s = Store.get.settings();
        host.innerHTML = `
            <p>• العطل الرسمية: <strong>${s.holidayMode === 'excluded' ? 'تُستثنى من الإجازة' : 'من ضمن الإجازة'}</strong></p>
            <p>• الجمعة والسبت: <strong>${s.countWeekend ? 'تُحسب من الإجازة' : 'تُستثنى من الأيام المخصومة'}</strong></p>
            <p>• الرصيد السنوي الافتراضي: <strong>${App.Security.toInt(s.defaultAnnualBalance, 21, 0, 365)} يوم</strong></p>
            <p>• عدد العطل المسجّلة: <strong>${Store.get.holidays().length}</strong></p>`;
    }

    function renderRecent() {
        const host = $('entryRecent');
        if (!host) return;

        const recent = Store.get.leaves()
            .slice()
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
            .slice(0, 5);

        if (!recent.length) {
            host.innerHTML = '<p class="text-slate-400 font-bold text-center py-3">لا توجد سجلات بعد</p>';
            return;
        }

        host.innerHTML = recent.map(l => `
            <div class="border border-slate-200 rounded-lg px-2.5 py-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="font-bold text-slate-800 truncate">${esc(l.empName)}</span>
                    <span class="text-[10px] text-slate-500 whitespace-nowrap">${esc(l.leaveType || '')}</span>
                </div>
                <div class="text-[10px] text-slate-500 mt-0.5">
                    ${esc(App.Dates.formatISO(l.fromDate))} ← ${esc(App.Dates.formatISO(l.toDate))}
                    ${l.leaveTypeIsHourly ? ' · ' + (l.hoursCount || 0) + ' ساعة' : ' · ' + (l.deductedDays || 0) + ' يوم'}
                </div>
            </div>`).join('');
    }

    /* ---------------- مزامنة الأيام والتواريخ ---------------- */

    function syncToFromDays() {
        const from = val('entryFromDate');
        if (!from) return;
        const days = Math.max(1, App.Security.toInt(val('entryDaysCount'), 1, 1, 4000));
        setVal('entryToDate', App.Dates.addDays(from, days - 1));
        renderAnalysis();
    }

    function syncDaysFromTo() {
        const from = val('entryFromDate');
        const to = val('entryToDate');
        if (!from || !to) return;

        if (App.Dates.diffDays(from, to) < 0) {
            App.Notify.toast('تاريخ النهاية لا يمكن أن يكون قبل تاريخ البداية', 'warning');
            setVal('entryToDate', from);
            setVal('entryDaysCount', 1);
            renderAnalysis();
            return;
        }
        setVal('entryDaysCount', App.Dates.inclusiveDays(from, to));
        renderAnalysis();
    }

    /* ---------------- اقتراحات الموظفين ---------------- */

    function hideSuggestions() {
        const box = $('staffSuggestions');
        if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    }

    function showSuggestions(keyword) {
        const box = $('staffSuggestions');
        if (!box) return;

        const kw = App.Security.clean(keyword).toLowerCase();
        if (!kw || kw.length < 1) { hideSuggestions(); return; }

        const list = Store.get.staff()
            .filter(p => p.isActive !== false && p.name.toLowerCase().includes(kw))
            .slice(0, 8);

        if (!list.length) { hideSuggestions(); return; }

        box.innerHTML = list.map(p => `
            <button type="button" class="w-full text-right px-3 py-2 hover:bg-brand-50 border-b border-slate-100 last:border-0" data-emp="${esc(p.id)}">
                <div class="font-bold text-[11px] text-slate-800">${esc(p.name)}</div>
                <div class="text-[10px] text-slate-500">${esc(p.jobTitle || '')} ${p.dept ? '— ' + esc(p.dept) : ''} ${p.section ? '/ ' + esc(p.section) : ''}</div>
            </button>`).join('');
        box.classList.remove('hidden');
    }

    function applyEmployee(empId) {
        const p = Store.employeeById(empId);
        if (!p) return;
        setVal('entryEmpName', p.name);
        setVal('entryJobTitle', p.jobTitle || '');
        setVal('entryDept', p.dept || '');
        populateSections();
        if (p.section) setVal('entrySection', p.section);
        hideSuggestions();
        markDirty();
    }

    /* ---------------- الأيام التعويضية ---------------- */

    /**
     * يزامن رصيد الأيام التعويضية مع السجل.
     * لا يمسّ الأيام التي سُدّدت فعلاً.
     */
    function syncCompensations(record) {
        const list = Store.get.compensations();

        /* إزالة الاستحقاقات السابقة غير المسددة لهذا السجل */
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].leaveId === record.id && !list[i].settled) list.splice(i, 1);
        }

        if (!record.compensatoryDays || record.compensatoryDays <= 0) return;

        const names = (record.excludedHolidays || []).map(h => h.name).join('، ');
        list.push({
            id: C.uid('cmp'),
            empId: record.empId || '',
            empName: record.empName,
            leaveId: record.id,
            date: record.fromDate,
            days: record.compensatoryDays,
            reason: 'عطلة رسمية مستثناة داخل الإجازة' + (names ? ': ' + names : ''),
            settled: false,
            settledAt: '',
            createdAt: new Date().toISOString()
        });
    }

    /* ---------------- الحفظ ---------------- */

    async function save(e) {
        if (e) e.preventDefault();

        const editId = val('entryEditId');
        const empName = App.Security.clean(val('entryEmpName'), 150);
        const jobTitle = App.Security.clean(val('entryJobTitle'), 150);
        const dept = App.Security.clean(val('entryDept'), 120);
        const section = App.Security.clean(val('entrySection'), 120);
        const typeId = val('entryType');
        const status = val('entryStatus') || Store.get.settings().defaultStatus;
        const notes = App.Security.clean(val('entryNotes'), 500);

        const type = Store.leaveTypeById(typeId);

        /* التحقق */
        if (!empName) { App.Notify.alert('يرجى إدخال اسم الموظف', 'warning', 'بيانات ناقصة'); $('entryEmpName').focus(); return; }
        if (!jobTitle) { App.Notify.alert('يرجى إدخال العنوان الوظيفي', 'warning', 'بيانات ناقصة'); $('entryJobTitle').focus(); return; }
        if (!type) { App.Notify.alert('يرجى اختيار نوع الإجازة', 'warning', 'بيانات ناقصة'); return; }

        const analysis = currentAnalysis();
        if (!analysis.valid) {
            App.Notify.alert(analysis.error || 'بيانات المدة غير مكتملة', 'warning', 'تحقق من المدة');
            return;
        }

        /* فحص التداخل */
        const emp = Store.employeeByName(empName);
        const conflict = await App.Conflicts.check({
            empId: emp ? emp.id : null,
            empName: empName,
            fromDate: analysis.fromDate,
            toDate: analysis.toDate || analysis.fromDate,
            excludeId: editId || null,
            leaveTypeName: type.name
        });

        if (!conflict.ok) {
            if (conflict.reason === 'edit') {
                const toEl = type.isHourly ? $('entryLeaveDate') : $('entryFromDate');
                if (toEl) toEl.focus();
            }
            return;
        }

        /* الموظف في الدليل */
        const employee = Store.upsertEmployee({ name: empName, jobTitle: jobTitle, dept: dept, section: section });

        const record = {
            id: editId || C.uid('lv'),
            empId: employee ? employee.id : '',
            empName: empName,
            jobTitle: jobTitle,
            dept: dept,
            section: section,
            leaveTypeId: type.id,
            leaveType: type.name,
            leaveTypeIsHourly: !!type.isHourly,
            fromDate: analysis.fromDate,
            toDate: analysis.toDate || analysis.fromDate,
            fromTime: type.isHourly ? (App.Security.isTime(val('entryFromTime')) ? val('entryFromTime') : '') : '',
            toTime: type.isHourly ? (App.Security.isTime(val('entryToTime')) ? val('entryToTime') : '') : '',
            calendarDays: analysis.calendarDays,
            daysCount: type.isHourly ? 0 : analysis.calendarDays,
            deductedDays: analysis.deductedDays,
            hoursCount: type.isHourly ? analysis.hoursCount : 0,
            compensatoryDays: analysis.compensatoryDays,
            excludedHolidays: analysis.excludedHolidays,
            holidayNote: analysis.excludedHolidays.length
                ? 'من ضمن الإجازة عطلة رسمية: ' + analysis.excludedHolidays.map(h => h.name + ' (' + h.date + ')').join('، ')
                : '',
            notes: notes,
            status: status,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: Store.get.settings().operatorName || 'موظف الإجازات'
        };

        const leaves = Store.get.leaves();
        let before = null;

        if (editId) {
            const idx = leaves.findIndex(l => l.id === editId);
            if (idx === -1) {
                App.Notify.alert('لم يُعثر على السجل المطلوب تعديله', 'error');
                return;
            }
            before = Object.assign({}, leaves[idx]);
            record.createdAt = before.createdAt || record.createdAt;
            record.createdBy = before.createdBy || record.createdBy;
            leaves[idx] = record;
        } else {
            leaves.unshift(record);
        }

        syncCompensations(record);
        Store.save([C.KEYS.LEAVES, C.KEYS.STAFF, C.KEYS.COMPENSATIONS]);

        App.Audit.log({
            action: editId ? 'update' : 'insert',
            entity: 'leaves',
            recordId: record.id,
            label: (editId ? 'تعديل إجازة: ' : 'إضافة إجازة: ') + empName + ' — ' + type.name +
                   ' (' + record.fromDate + ' ← ' + record.toDate + ')',
            before: before,
            after: record,
            note: conflict.overrideReason ? 'تجاوز تعارض: ' + conflict.overrideReason : ''
        });

        if (conflict.overrideReason) {
            App.Audit.log({
                action: 'override',
                entity: 'leaves',
                recordId: record.id,
                label: 'تجاوز تعارض لصالح: ' + empName,
                note: conflict.overrideReason
            });
        }

        App.Notify.toast(editId ? 'تم تحديث السجل' : 'تم حفظ الإجازة', 'success');

        /* إن كان السجل خارج نطاق الموقف المعروض نعرض الشهر الذي يقع فيه */
        const moved = App.Dashboard && App.Dashboard.focusRecord
            ? App.Dashboard.focusRecord(record)
            : false;
        if (moved) {
            App.Notify.toast('عُرض موقف ' + App.Dates.formatMonth(
                App.Dates.yearOf(record.fromDate), App.Dates.monthOf(record.fromDate)) +
                ' لأن السجل خارج التاريخ المعروض', 'info', 4200);
        }

        resetForm();
        App.App.goTab('dashboard');
    }

    /* ---------------- تفريغ وتعبئة ---------------- */

    function resetForm() {
        setVal('entryEditId', '');
        setVal('entryEmpName', '');
        setVal('entryJobTitle', '');
        setVal('entryDept', '');
        setVal('entryStatus', Store.get.settings().defaultStatus || 'approved');
        setVal('entryNotes', '');

        const today = App.Dates.todayISO();
        setVal('entryLeaveDate', today);
        setVal('entryFromDate', today);
        setVal('entryToDate', today);
        setVal('entryDaysCount', 1);
        setVal('entryFromTime', '09:00');
        setVal('entryToTime', '11:00');
        setVal('entryHoursCount', 2);

        populateSections();
        hideSuggestions();

        const title = $('entryFormTitle');
        if (title) title.textContent = 'إدخال إجازة جديدة';
        const badge = $('entryEditBadge');
        if (badge) badge.classList.add('hidden');
        const saveBtn = $('saveLeaveBtn');
        if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> حفظ الموقف اليومي';

        clearDirty();
        renderAnalysis();
    }

    function editRecord(id) {
        const l = Store.get.leaves().find(r => r.id === id);
        if (!l) return;

        setVal('entryEditId', l.id);
        setVal('entryEmpName', l.empName);
        setVal('entryJobTitle', l.jobTitle);
        setVal('entryDept', l.dept);
        populateSections();
        setVal('entrySection', l.section || '');
        setVal('entryStatus', l.status || 'approved');
        setVal('entryNotes', l.notes || '');

        /* اختيار النوع */
        const typeSel = $('entryType');
        if (typeSel) {
            let tid = l.leaveTypeId;
            if (!tid || !Store.leaveTypeById(tid)) {
                const t = Store.leaveTypeByName(l.leaveType);
                tid = t ? t.id : (typeSel.options[0] ? typeSel.options[0].value : '');
            }
            typeSel.value = tid || '';
        }

        toggleFields();

        const isHourly = !!l.leaveTypeIsHourly;
        if (isHourly) {
            setVal('entryLeaveDate', l.fromDate || App.Dates.todayISO());
            setVal('entryHoursCount', l.hoursCount || 2);
            setVal('entryFromTime', l.fromTime || '09:00');
            setVal('entryToTime', l.toTime || '11:00');
        } else {
            setVal('entryFromDate', l.fromDate);
            setVal('entryToDate', l.toDate);
            setVal('entryDaysCount', l.daysCount || App.Dates.inclusiveDays(l.fromDate, l.toDate));
        }

        const title = $('entryFormTitle');
        if (title) title.textContent = 'تعديل بيانات الإجازة';
        const badge = $('entryEditBadge');
        if (badge) badge.classList.remove('hidden');
        const saveBtn = $('saveLeaveBtn');
        if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> تحديث الإجازة';

        clearDirty();
        renderAnalysis();
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const form = $('entryForm');

        if (form) {
            form.addEventListener('submit', save);

            /* تتبّع أي تعديل */
            form.addEventListener('input', (e) => {
                if (e.target.id === 'entryEmpName') return;
                markDirty();
            });
            form.addEventListener('change', () => markDirty());
        }

        /* نوع الإجازة */
        const typeSel = $('entryType');
        if (typeSel) {
            typeSel.addEventListener('change', () => { toggleFields(); markDirty(); renderAnalysis(); });
        }

        /* القسم ← الشعب */
        const deptSel = $('entryDept');
        if (deptSel) {
            deptSel.addEventListener('change', () => { populateSections(); renderAnalysis(); });
        }

        /* التواريخ والأيام */
        const fromEl = $('entryFromDate');
        if (fromEl) fromEl.addEventListener('change', syncToFromDays);

        const daysEl = $('entryDaysCount');
        if (daysEl) daysEl.addEventListener('input', App.debounce(syncToFromDays, 250));

        const toEl = $('entryToDate');
        if (toEl) toEl.addEventListener('change', syncDaysFromTo);

        /* الاحتساب الفوري لبقية الحقول */
        ['entryLeaveDate', 'entryFromTime', 'entryToTime', 'entryHoursCount', 'entryStatus']
            .forEach(id => {
                const el = $(id);
                if (el) el.addEventListener('change', renderAnalysis);
                if (el) el.addEventListener('input', App.debounce(renderAnalysis, 200));
            });

        /* اقتراحات الموظفين */
        const nameEl = $('entryEmpName');
        if (nameEl) {
            nameEl.addEventListener('input', App.debounce(() => {
                showSuggestions(nameEl.value);
                markDirty();
            }, 200));
            nameEl.addEventListener('focus', () => {
                if (nameEl.value) showSuggestions(nameEl.value);
            });
        }

        const sug = $('staffSuggestions');
        if (sug) {
            sug.addEventListener('mousedown', (e) => {
                const btn = e.target.closest('[data-emp]');
                if (!btn) return;
                e.preventDefault();
                applyEmployee(btn.dataset.emp);
            });
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#staffSuggestions') && !e.target.closest('#entryEmpName')) hideSuggestions();
        });

        /* أزرار */
        const resetBtn = $('resetEntryBtn');
        if (resetBtn) resetBtn.addEventListener('click', async () => {
            if (isDirty()) {
                const ok = await App.Notify.confirm('سيتم فقدان البيانات غير المحفوظة. متابعة؟',
                    { title: 'تفريغ الحقول', confirmText: 'تفريغ', danger: true, type: 'warning' });
                if (!ok) return;
            }
            resetForm();
        });

        refresh();
    }

    function refresh() {
        const s = Store.get.settings();
        const statusSel = $('entryStatus');
        if (statusSel && !val('entryEditId')) statusSel.value = s.defaultStatus || 'approved';

        if (!$('entryFromDate').value) {
            const today = App.Dates.todayISO();
            setVal('entryFromDate', today);
            setVal('entryToDate', today);
            setVal('entryLeaveDate', today);
        }

        toggleFields();
        populateSections();
        renderAnalysis();
        renderPolicy();
        renderRecent();
    }

    return {
        init: init,
        refresh: refresh,
        save: save,
        resetForm: resetForm,
        editRecord: editRecord,
        isDirty: isDirty,
        clearDirty: clearDirty,
        markDirty: markDirty,
        getAnalysis: currentAnalysis,
        syncCompensations: syncCompensations
    };
})();
