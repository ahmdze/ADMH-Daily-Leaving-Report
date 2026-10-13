/* ============================================================
   وحدة التقارير — بناء تقارير رسمية قابلة للطباعة والتصدير
   ------------------------------------------------------------
   الأنماط المدعومة:
     employee     : موظف محدد (ملخص + تفاصيل + الرصيد المتبقي)
     department   : قسم محدد (مجمّع لكل موظف مع مجاميع فرعية)
     all          : تقرير شامل (مجاميع الأقسام + المجموع العام)
     balance      : أرصدة الموظفين (سنوي / مستهلك / متبقٍ / تعويضات)
     compensation : الأيام التعويضية (سجل كامل + مجاميع غير المسددة)
   ------------------------------------------------------------
   الواجهة المُصدَّرة: App.Reports = { init, run, refresh }
     init()    : يربط الأحداث مرة واحدة فقط (آمن عند استدعائه مرتين)
     run()     : ينشئ التقرير الحالي ويرسمه في #reportOutput
     refresh() : يعيد تعبئة القوائم ويعيد إنشاء التقرير المختار
   ------------------------------------------------------------
   ملاحظات:
     • سكربت كلاسيكي داخل IIFE (لا وحدات ES لأنها لا تعمل على file://)
     • كل قيمة مصدرها البيانات تمر عبر App.Security.esc قبل إدراجها في HTML
     • لا نستخدم toISOString — كل صيغ التواريخ من App.Dates
   ============================================================ */
window.App = window.App || {};

App.Reports = (function () {
    'use strict';

    const C = App.Constants;
    const Dates = App.Dates;
    const Store = App.Store;

    /* ---------------- الحالة الداخلية ---------------- */
    let inited = false;          /* التهيئة مرّة واحدة فقط */
    let els = {};                /* العناصر المقروءة من الصفحة */
    let hasReport = false;       /* هل أُنشئ تقرير بالفعل؟ */
    let current = null;          /* آخر تقرير مُنشأ (يُستخدم للتصدير) */
    let changeToken = 0;         /* يمنع تكرار التقارير الثقيلة عند تغيّر البيانات */

    /* ---------------- أدوات صغيرة ---------------- */

    /** تأخير تنفيذ — مع بديل داخلي إن لم تتوفر App.debounce */
    function debounce(fn, wait) {
        if (typeof App.debounce === 'function') return App.debounce(fn, wait);
        let timer = null;
        return function () {
            const args = arguments, ctx = this;
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(ctx, args), wait || 300);
        };
    }

    /** قراءة عنصر بأمان — لا يرمي إذا كان العنصر مفقوداً */
    function byId(id) {
        try { return document.getElementById(id) || null; } catch (e) { return null; }
    }

    /** قراءة قيمة حقل نصي/منسدل بأمان */
    function valOf(el, fallback) {
        if (!el || el.value === undefined || el.value === null) return fallback === undefined ? '' : fallback;
        return String(el.value);
    }

    /** أرقام صحيحة موجبة */
    function num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    }

    /** تقصير نص طويل للعرض داخل الجداول */
    function clip(text, max) {
        const s = (text === undefined || text === null) ? '' : String(text);
        const m = max || 60;
        return s.length > m ? s.slice(0, m) + '…' : s;
    }

    /** تاريخ (ميلادي) من أي قيمة نصية أو زمنية — بدون toISOString */
    function isoOf(value) {
        if (!value) return '';
        const s = String(value);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
        const d = new Date(s);
        return isNaN(d.getTime()) ? '' : Dates.toISO(d);
    }

    /** تاريخ مقروء بالعربية، وإن تعذّر فالنسخة الرقمية */
    function full(iso) {
        if (!iso) return '—';
        return Dates.formatFull(iso) || iso;
    }

    /** الوقت داخل حقل التاريخ للسجلات الزمنية */
    function timeRangeOf(rec) {
        const a = rec.fromTime || '', b = rec.toTime || '';
        if (!a && !b) return '';
        return a + (a && b ? ' - ' : '') + b;
    }

    /* ------------- قراءة البيانات من طبقة التخزين ------------- */

    function getLeaves() {
        try { return (Store && Store.get && Store.get.leaves && Store.get.leaves()) || []; }
        catch (e) { return []; }
    }
    function getStaff() {
        try { return (Store && Store.get && Store.get.staff && Store.get.staff()) || []; }
        catch (e) { return []; }
    }
    function getComps() {
        try { return (Store && Store.get && Store.get.compensations && Store.get.compensations()) || []; }
        catch (e) { return []; }
    }
    function getSettings() {
        try { return Object.assign({}, C.DEFAULT_SETTINGS, (Store && Store.get && Store.get.settings && Store.get.settings()) || {}); }
        catch (e) { return Object.assign({}, C.DEFAULT_SETTINGS); }
    }

    /** هل السجل محسوب في المجاميع؟ (يستثني الملغاة والمرفوضة) */
    function isActive(rec) {
        if (!rec) return false;
        const active = C.ACTIVE_STATUSES || [C.STATUS.PENDING, C.STATUS.APPROVED];
        if (active.indexOf(rec.status) !== -1) return true;
        /* سجل قديم بلا حالة يُحتسب كمعتمد */
        return !rec.status;
    }

    /** الأيام المخصومة للسجل */
    function deducted(rec) {
        return num(rec && rec.deductedDays);
    }

    /* ---------------- الاشتراك في تغييرات البيانات ---------------- */

    function subscribe() {
        if (!Store || typeof Store.on !== 'function') return;
        const onChange = debounce(function () {
            changeToken++;
            refreshSelects();
            /* لا نعيد بناء تقرير ثقيل تلقائياً في كل تغيير بيانات */
            if (!hasReport || !current) return;
            if (changeToken < 2) return;
            const again = current.mode === 'balance' || current.mode === 'compensation';
            if (again) run({ silent: true });
        }, 700);
        try { Store.on('change', onChange); } catch (e) { /* تجاهل */ }
    }

    /* ---------------- القوائم المنسدلة ---------------- */

    /** كل الأقسام: من دليل الأقسام + ما ورد في السجلات والموظفين */
    function deptNames() {
        const set = {};
        const out = [];
        const push = (name) => {
            const n = (name === undefined || name === null) ? '' : String(name).trim();
            if (!n || set[n]) return;
            set[n] = true;
            out.push(n);
        };
        let depts = [];
        try { depts = (Store && Store.get && Store.get.departments && Store.get.departments()) || []; } catch (e) { depts = []; }
        depts.forEach(d => push(d && d.name));
        getStaff().forEach(p => push(p && p.dept));
        getLeaves().forEach(r => push(r && r.dept));
        out.sort((a, b) => a.localeCompare(b, 'ar'));
        return out;
    }

    /** كل الموظفين: من الدليل + الأسماء الواردة في السجلات (مرتّبة عربياً) */
    function staffList() {
        const map = {};
        getStaff().forEach(p => {
            if (!p || !p.name) return;
            map[p.name] = p;
        });
        getLeaves().forEach(r => {
            const n = r && r.empName ? String(r.empName) : '';
            if (!n || map[n]) return;
            map[n] = { id: r.empId || '', name: n, jobTitle: r.jobTitle || '', dept: r.dept || '', section: r.section || '' };
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));
    }

    function refreshSelects() {
        const staff = staffList();

        const empSel = byId('reportEmpName');
        if (empSel) {
            const cur = valOf(empSel, '');
            empSel.innerHTML = staff.length
                ? staff.map(p => '<option value="' + App.Security.esc(p.name) + '">' +
                    App.Security.esc(p.name) + (p.jobTitle ? ' — ' + App.Security.esc(p.jobTitle) : '') +
                    '</option>').join('')
                : '<option value="">لا يوجد موظفون في الدليل</option>';
            if (cur && staff.some(p => p.name === cur)) empSel.value = cur;
        }

        const deptSel = byId('reportDept');
        if (deptSel) {
            const cur = valOf(deptSel, '');
            const list = deptNames();
            deptSel.innerHTML = '<option value="">جميع الأقسام</option>' +
                list.map(d => '<option value="' + App.Security.esc(d) + '">' + App.Security.esc(d) + '</option>').join('');
            deptSel.value = (cur && list.indexOf(cur) !== -1) ? cur : '';
        }
    }

    /* ---------------- قراءة الفترة والتاريخ ---------------- */

    function currentMonthValue() {
        const t = Dates.todayISO() || '';
        return t ? t.slice(0, 7) : '';
    }

    /** يملأ حقول الفترة بقيم افتراضية معقولة عند أول استخدام */
    function applyDefaults() {
        const now = new Date();
        const y = now.getFullYear();

        if (els.reportMonth && !els.reportMonth.value) els.reportMonth.value = currentMonthValue();
        if (els.reportYear) {
            const cur = App.Security.toInt(els.reportYear.value, 0, 0, 9999);
            if (!cur) els.reportYear.value = String(y);
        }
        if (els.reportFrom && !els.reportFrom.value) {
            const r = Dates.monthRange(y, now.getMonth() + 1);
            els.reportFrom.value = r.from;
        }
        if (els.reportTo && !els.reportTo.value) {
            const r = Dates.monthRange(y, now.getMonth() + 1);
            els.reportTo.value = r.to;
        }
    }

    /** يخفي/يظهر الصناديق حسب النمط ونوع الفترة */
    function syncBoxes() {
        const mode = valOf(byId('reportMode'), 'employee');
        const balanceMode = (mode === 'balance' || mode === 'compensation');

        const empBox = byId('reportEmpBox');
        const deptBox = byId('reportDeptBox');
        const monthBox = byId('reportMonthBox');
        const yearBox = byId('reportYearBox');
        const rangeBox = byId('reportRangeBox');
        const periodSel = byId('reportPeriodType');

        const show = (el, on) => {
            if (!el) return;
            el.classList.toggle('hidden', !on);
            el.classList.toggle('block', !!on);
        };

        /* الأرصدة والتعويضات: الفترة سنة كاملة دائماً */
        if (balanceMode) {
            show(empBox, false);
            show(deptBox, false);
            show(monthBox, false);
            show(yearBox, true);
            show(rangeBox, false);
            if (periodSel) periodSel.disabled = true;
            return;
        }
        if (periodSel) periodSel.disabled = false;

        show(empBox, mode === 'employee');
        show(deptBox, mode === 'department');

        const pt = valOf(periodSel, 'month');
        show(monthBox, pt === 'month');
        show(yearBox, pt === 'year');
        show(rangeBox, pt === 'range');
    }

    /** يبني الفترة المختارة: نطاق ISO + عنوان عربي مقروء */
    function readPeriod(mode) {
        const balanceMode = (mode === 'balance' || mode === 'compensation');
        const now = new Date();
        const thisYear = now.getFullYear();
        let pt = balanceMode ? 'year' : valOf(byId('reportPeriodType'), 'month');
        if (['month', 'year', 'range'].indexOf(pt) === -1) pt = 'month';

        if (pt === 'month') {
            let mv = valOf(byId('reportMonth'), '');
            if (!/^\d{4}-\d{2}$/.test(mv)) {
                const m = App.Security.toInt(valOf(byId('reportYear'), thisYear), thisYear, 1900, 2200);
                mv = m + '-' + Dates.pad2(now.getMonth() + 1);
            }
            const y = App.Security.toInt(mv.slice(0, 4), thisYear, 1900, 2200);
            const mo = App.Security.toInt(mv.slice(5, 7), 1, 1, 12);
            const r = Dates.monthRange(y, mo);
            return {
                type: 'month', from: r.from, to: r.to, year: y, month: mo,
                title: Dates.formatMonth(y, mo), label: 'الشهر: ' + Dates.formatMonth(y, mo)
            };
        }

        if (pt === 'year') {
            const y = App.Security.toInt(valOf(byId('reportYear'), thisYear), thisYear, 1900, 2200);
            const r = Dates.yearRange(y);
            return {
                type: 'year', from: r.from, to: r.to, year: y, month: 0,
                title: 'سنة ' + y, label: 'السنة: ' + y
            };
        }

        /* بين تاريخين */
        let from = Dates.formatISO(valOf(byId('reportFrom'), ''));
        let to = Dates.formatISO(valOf(byId('reportTo'), ''));
        if (!App.Security.isIsoDate(from) || !App.Security.isIsoDate(to)) {
            const r = Dates.monthRange(thisYear, now.getMonth() + 1);
            if (!App.Security.isIsoDate(from)) from = r.from;
            if (!App.Security.isIsoDate(to)) to = r.to;
        }
        if (from > to) {
            const tmp = from; from = to; to = tmp;
            App.Notify.toast('تم تبديل التاريخين لأن تاريخ البداية كان بعد النهاية', 'warning');
        }
        return {
            type: 'range', from: from, to: to,
            year: Dates.yearOf(from) || thisYear, month: 0,
            title: 'من ' + from + ' إلى ' + to,
            label: 'الفترة: من ' + full(from) + ' إلى ' + full(to)
        };
    }

    /** يسقط السجلات على الفترة المختارة (حسب تاريخ البداية) */
    function filterByPeriod(rows, period) {
        return (rows || []).filter(r => {
            const d = Dates.formatISO(r && r.fromDate);
            if (!d) return false;
            return d >= period.from && d <= period.to;
        });
    }

    /** الأيام المستهلكة من الرصيد لموظف في سنة */
    function usedInYear(empId, year) {
        try {
            if (Store && typeof Store.usedBalance === 'function') return num(Store.usedBalance(empId, year));
        } catch (e) { /* نكمل بالحساب اليدوي */ }
        if (!empId) return 0;
        return getLeaves()
            .filter(r => r && r.empId === empId && isActive(r) && Dates.yearOf(r.fromDate) === year)
            .reduce((s, r) => s + deducted(r), 0);
    }

    /** الأيام التعويضية غير المسددة لموظف */
    function openComp(empId) {
        try {
            if (Store && typeof Store.openCompensations === 'function') return num(Store.openCompensations(empId));
        } catch (e) { /* نكمل بالحساب اليدوي */ }
        if (!empId) return 0;
        return getComps()
            .filter(c => c && c.empId === empId && !c.settled)
            .reduce((s, c) => s + num(c.days), 0);
    }

    /** الموظف من الدليل بالاسم أو المعرّف */
    function employeeOf(name, id) {
        const staff = getStaff();
        if (id) {
            const byIdHit = staff.find(p => p && p.id === id);
            if (byIdHit) return byIdHit;
        }
        const n = String(name || '');
        if (!n) return null;
        return staff.find(p => p && p.name === n) || null;
    }

    /**
     * مجاميع موظف واحد: لكل نوع (عدد + أيام مخصومة) والإجمالي
     * يُبنى من السجلات المفلترة أصلاً على الفترة.
     */
    function employeeStats(recs) {
        const byType = {};
        const order = [];
        let totalLeaves = 0, totalDays = 0, totalHours = 0;

        (recs || []).forEach(r => {
            const name = String((r && r.leaveType) || 'غير محدد');
            const key = String((r && r.leaveTypeId) || name);
            if (!byType[key]) {
                byType[key] = { name: name, count: 0, days: 0, hours: 0, hourly: !!(r && r.leaveTypeIsHourly) };
                order.push(key);
            }
            const agg = byType[key];
            agg.count++;
            if (r && r.leaveTypeIsHourly) {
                agg.hours += num(r.hoursCount);
                totalHours += num(r.hoursCount);
            } else {
                agg.days += deducted(r);
                totalDays += deducted(r);
            }
            totalLeaves++;
        });

        const types = order.map(k => byType[k]).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'));
        return { byType: types, totalLeaves: totalLeaves, totalDays: totalDays, totalHours: totalHours };
    }

    /* ---------------- قوالب HTML ---------------- */

    /**
     * جدول رسمي موحّد.
     * cols = [{ label, align }] و rows = [[خلية, ...]]
     * أي خلية قد تكون رقماً أو نصاً أو كائناً { html, cls }
     */
    function tableHtml(cols, rows) {
        const head = (cols || []).map(c =>
            '<th class="py-2 px-2 border border-slate-300 ' + (c.align === 'right' ? 'text-right' : '') + '">' +
            App.Security.esc(c.label) + '</th>').join('');

        const body = (rows || []).map(cells =>
            '<tr>' + (cells || []).map((cell, i) => {
                const col = cols[i] || {};
                const cls = 'py-1.5 px-2 border border-slate-300 ' + (col.align === 'right' ? 'text-right' : '');
                if (cell && typeof cell === 'object' && cell.html !== undefined) {
                    return '<td class="' + cls + (cell.cls ? ' ' + cell.cls : '') + '">' + cell.html + '</td>';
                }
                return '<td class="' + cls + '">' + App.Security.esc(cell === undefined || cell === null ? '' : cell) + '</td>';
            }).join('') + '</tr>').join('');

        return '<table class="w-full text-[11px] text-center border-collapse print-table">' +
            '<thead><tr class="bg-brand-900 text-white font-bold">' + head + '</tr></thead>' +
            '<tbody>' + body + '</tbody></table>';
    }

    /** كتلة عنوان صغيرة قبل كل جدول */
    function sectionTitle(icon, text) {
        return '<h3 class="font-extrabold text-xs text-slate-800 flex items-center gap-2 border-b border-slate-200 pb-1.5 mb-2">' +
            '<i class="fa-solid ' + App.Security.esc(icon) + ' text-brand-600"></i>' +
            '<span>' + App.Security.esc(text) + '</span></h3>';
    }

    /** شارات ألوان الحالات */
    function statusChip(status) {
        const key = status || C.STATUS.APPROVED;
        const label = (C.STATUS_LABEL && C.STATUS_LABEL[key]) || key || '—';
        const cls = (C.STATUS_CLASS && C.STATUS_CLASS[key]) || 'bg-slate-200 text-slate-700';
        return '<span class="badge ' + cls + '">' + App.Security.esc(label) + '</span>';
    }

    /** الترويسة الرسمية الموحّدة للتقارير */
    function headerHtml(s) {
        const logo = s.logoBase64
            ? '<img src="' + App.Security.escAttr(s.logoBase64) + '" alt="الشعار" class="max-h-full max-w-full object-contain">'
            : '<i class="fa-solid fa-hospital-user text-2xl text-brand-700"></i>';

        return '' +
            '<div class="border-b-2 border-brand-800 pb-3 mb-4">' +
                '<div class="grid grid-cols-3 items-center text-center gap-2">' +
                    '<div class="text-right space-y-0.5">' +
                        '<h3 class="font-bold text-[11px] md:text-xs text-slate-900">' + App.Security.esc(s.ministry || '') + '</h3>' +
                        '<h4 class="font-bold text-[11px] text-slate-700">' + App.Security.esc(s.directorate || '') + '</h4>' +
                        '<h5 class="font-bold text-[11px] text-brand-700">' + App.Security.esc(s.hospital || '') + '</h5>' +
                        '<p class="text-[10px] text-slate-500">' + App.Security.esc(s.departmentUnit || '') + '</p>' +
                    '</div>' +
                    '<div class="flex flex-col items-center justify-center space-y-1">' +
                        '<div class="w-14 h-14 border border-slate-300 rounded-full flex items-center justify-center p-1 bg-white overflow-hidden">' +
                            logo +
                        '</div>' +
                    '</div>' +
                    '<div class="text-left space-y-0.5 text-[11px] text-slate-600">' +
                        '<p><strong>تاريخ الإصدار:</strong> <span>' + App.Security.esc(Dates.formatFull(Dates.todayISO())) + '</span></p>' +
                        '<p><strong>وقت الإصدار:</strong> <span>' + App.Security.esc(nowTime()) + '</span></p>' +
                        '<p><strong>حالة التقرير:</strong> <span class="text-emerald-700 font-bold">مصدّق رسمياً</span></p>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    /** وقت الإصدار HH:MM بالتوقيت المحلي */
    function nowTime() {
        const d = new Date();
        return Dates.pad2(d.getHours()) + ':' + Dates.pad2(d.getMinutes());
    }

    /** ترويسة عنوان التقرير والفترة والموضوع */
    function titleHtml(rep) {
        const s = rep || {};
        const period = s.period || { label: '' };
        return '' +
            '<div class="text-center mb-4">' +
                '<h2 class="font-black text-base md:text-lg text-slate-900">' + App.Security.esc(s.title || '') + '</h2>' +
                (s.subject ? '<p class="font-extrabold text-sm text-brand-800 mt-0.5">' + App.Security.esc(s.subject) + '</p>' : '') +
                '<p class="text-[11px] font-extrabold text-slate-700 bg-slate-100 px-3 py-0.5 rounded-full border border-slate-200 inline-block mt-1">' +
                    App.Security.esc(period.label || '') +
                '</p>' +
                (s.subLine ? '<p class="text-[10px] text-slate-500 mt-1">' + App.Security.esc(s.subLine) + '</p>' : '') +
            '</div>';
    }

    /** تذييل التواقيع الرسمي */
    function footerHtml(s) {
        return '' +
            '<div class="mt-8 pt-4 grid grid-cols-2 gap-6 text-center text-[11px] no-break">' +
                '<div>' +
                    '<p class="font-bold text-slate-700">' + App.Security.esc(s.footerHR || '') + '</p>' +
                    '<p class="text-slate-400 mt-6">التوقيع: .....................</p>' +
                '</div>' +
                '<div>' +
                    '<p class="font-bold text-slate-700">' + App.Security.esc(s.footerManager || '') + '</p>' +
                    '<p class="text-slate-400 mt-6">التوقيع: .....................</p>' +
                '</div>' +
            '</div>';
    }

    /** رسالة عدم وجود بيانات */
    function emptyHtml(extra) {
        return '<div class="text-center py-10">' +
            '<i class="fa-solid fa-inbox text-3xl text-slate-300"></i>' +
            '<p class="text-sm font-bold text-slate-400 mt-2">لا توجد سجلات مطابقة للفترة المحددة</p>' +
            (extra ? '<p class="text-[11px] text-slate-400 mt-1">' + App.Security.esc(extra) + '</p>' : '') +
            '</div>';
    }

    /** تفاصيل سجل واحد: أيام/ساعات + من/إلى */
    function durationOf(rec) {
        if (rec && rec.leaveTypeIsHourly) {
            return num(rec.hoursCount) + ' ساعة' + (timeRangeOf(rec) ? ' (' + timeRangeOf(rec) + ')' : '');
        }
        return String(deducted(rec));
    }

    function fromToText(rec) {
        const a = Dates.formatISO(rec && rec.fromDate);
        const b = Dates.formatISO(rec && rec.toDate) || a;
        if (!a) return '—';
        return a === b ? a : (a + ' ← ' + b);
    }

    /* ---------------- بناء التقارير ---------------- */

    /** تقرير موظف: ملخص + تفاصيل */
    function buildEmployee(mode, period, opts) {
        opts = opts || {};
        const name = opts.empName || '';
        const emp = employeeOf(name, opts.empId);
        const empId = (emp && emp.id) || opts.empId || '';
        const recs = getLeaves().filter(r => r && String(r.empName || '') === name && isActive(r));
        const inPeriod = filterByPeriod(recs, period);
        const agg = employeeStats(inPeriod);

        const year = period.year || new Date().getFullYear();
        const annualBalance = emp ? num(emp.annualBalance) : num(getSettings().defaultAnnualBalance);
        const used = usedInYear(empId, year);
        const remaining = annualBalance - used;
        const open = openComp(empId);

        const details = inPeriod
            .slice()
            .sort((a, b) => String(a.fromDate).localeCompare(String(b.fromDate)));

        const r = {
            mode: mode,
            title: 'تقرير إجازات موظف',
            subject: name,
            subLine: emp ? [emp.jobTitle, emp.dept, emp.section].filter(Boolean).join(' — ') : '',
            period: period,
            hasRows: details.length > 0,
            totals: { count: agg.totalLeaves, days: agg.totalDays },
            annualBalance: annualBalance,
            usedBalance: used,
            remainingBalance: remaining,
            openCompensations: open,
            typeBreakdown: agg.byType,
            details: details.map(x => ({
                empName: x.empName, leaveType: x.leaveType, fromDate: x.fromDate, toDate: x.toDate,
                deductedDays: x.leaveTypeIsHourly ? 0 : deducted(x), hoursCount: num(x.hoursCount),
                leaveTypeIsHourly: !!x.leaveTypeIsHourly, fromTime: x.fromTime, toTime: x.toTime,
                status: x.status, notes: x.notes, dept: x.dept
            }))
        };
        return r;
    }

    /** مقطع HTML لملخص موظف واحد (يُستخدم في تقرير الموظف والقسم) */
    function employeeSummaryHtml(rep) {
        const breakRows = rep.typeBreakdown.map(t => [
            t.name,
            String(t.count),
            t.hourly ? (t.hours + ' ساعة') : String(t.days),
            t.hourly ? '—' : String(t.days)
        ]);

        const cols = [
            { label: 'نوع الإجازة', align: 'right' },
            { label: 'عدد السجلات' },
            { label: 'المدة', },
            { label: 'الأيام المخصومة' }
        ];

        const head = '<thead><tr class="bg-slate-100 text-slate-700 font-bold">' +
            cols.map(c => '<th class="py-1.5 px-2 border border-slate-300 ' + (c.align === 'right' ? 'text-right' : '') + '">' + App.Security.esc(c.label) + '</th>').join('') +
            '</tr></thead>';

        const body = breakRows.length
            ? breakRows.map(cells => '<tr>' + cells.map((c, i) =>
                '<td class="py-1 px-2 border border-slate-300' + (i === 0 ? ' text-right' : '') + '">' + App.Security.esc(c) + '</td>').join('') + '</tr>').join('')
            : '<tr><td colspan="4" class="py-2 px-2 border border-slate-300 text-slate-400">لا توجد سجلات مطابقة للفترة المحددة</td></tr>';

        const foot = '<tfoot><tr class="bg-slate-50 font-bold">' +
            '<td class="py-1.5 px-2 border border-slate-300 text-right">المجموع</td>' +
            '<td class="py-1.5 px-2 border border-slate-300">' + App.Security.esc(String(rep.totals.count)) + '</td>' +
            '<td class="py-1.5 px-2 border border-slate-300">' + App.Security.esc(String(rep.totals.days)) + ' يوم</td>' +
            '<td class="py-1.5 px-2 border border-slate-300">' + App.Security.esc(String(rep.totals.days)) + '</td>' +
            '</tr></tfoot>';

        const table = '<table class="w-full text-[11px] text-center border-collapse print-table">' + head + '<tbody>' + body + '</tbody>' + foot + '</table>';

        const cards = '' +
            '<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[11px]">' +
                cardBox('الرصيد السنوي', String(rep.annualBalance) + ' يوم', 'text-slate-800') +
                cardBox('المستهلك في ' + (rep.period.year || ''), String(rep.usedBalance) + ' يوم', 'text-amber-700') +
                cardBox('الرصيد المتبقي', String(rep.remainingBalance) + ' يوم', rep.remainingBalance < 0 ? 'text-rose-700' : 'text-emerald-700') +
                cardBox('أيام تعويضية غير مسددة', String(rep.openCompensations) + ' يوم', rep.openCompensations > 0 ? 'text-rose-700' : 'text-slate-800') +
            '</div>';

        const grand = '' +
            '<div class="mt-2 text-[11px] font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">' +
                'مجموع الأيام المخصومة في الفترة: <span class="text-emerald-700">' + App.Security.esc(String(rep.totals.days)) + ' يوم</span>' +
                ' · عدد السجلات: <span class="text-slate-900">' + App.Security.esc(String(rep.totals.count)) + '</span>' +
            '</div>';

        return table + cards + grand;
    }

    function cardBox(label, value, valueCls) {
        return '<div class="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">' +
            '<p class="text-[10px] text-slate-500 font-bold">' + App.Security.esc(label) + '</p>' +
            '<p class="font-black ' + valueCls + '">' + App.Security.esc(value) + '</p>' +
            '</div>';
    }

    /** تقرير قسم: مجاميع لكل موظف + تفاصيل */
    function buildDepartment(period, deptName) {
        const all = getLeaves().filter(r => isActive(r));
        const scoped = all.filter(r => {
            if (deptName && String(r.dept || '') !== deptName) return false;
            const d = Dates.formatISO(r.fromDate);
            return d && d >= period.from && d <= period.to;
        });

        /* تجميع حسب اسم الموظف */
        const groups = {};
        const order = [];
        scoped.forEach(r => {
            const n = String(r.empName || 'غير محدد');
            if (!groups[n]) { groups[n] = []; order.push(n); }
            groups[n].push(r);
        });
        order.sort((a, b) => a.localeCompare(b, 'ar'));

        const employees = order.map(n => {
            const recs = groups[n];
            const emp = employeeOf(n, (recs[0] || {}).empId);
            const agg = employeeStats(recs);
            const details = recs.slice().sort((a, b) => String(a.fromDate).localeCompare(String(b.fromDate)));
            return {
                name: n,
                jobTitle: (emp && emp.jobTitle) || (recs[0] || {}).jobTitle || '',
                empId: (emp && emp.id) || (recs[0] || {}).empId || '',
                count: agg.totalLeaves,
                days: agg.totalDays,
                typeBreakdown: agg.byType,
                details: details.map(x => ({
                    empName: x.empName, leaveType: x.leaveType, fromDate: x.fromDate, toDate: x.toDate,
                    deductedDays: x.leaveTypeIsHourly ? 0 : deducted(x), hoursCount: num(x.hoursCount),
                    leaveTypeIsHourly: !!x.leaveTypeIsHourly, fromTime: x.fromTime, toTime: x.toTime,
                    status: x.status, notes: x.notes
                }))
            };
        });

        const totals = employees.reduce((acc, e) => {
            acc.count += e.count; acc.days += e.days; return acc;
        }, { count: 0, days: 0 });

        return {
            mode: 'department',
            title: deptName ? ('تقرير إجازات قسم — ' + deptName) : 'تقرير إجازات الأقسام',
            subject: deptName || 'جميع الأقسام',
            subLine: employees.length + ' موظف لديهم سجلات في الفترة',
            period: period,
            hasRows: employees.length > 0,
            totals: totals,
            employees: employees
        };
    }

    /** تقرير شامل: مجاميع الأقسام + تفاصيل كل السجلات */
    function buildAll(period) {
        const scoped = filterByPeriod(getLeaves().filter(r => isActive(r)), period);

        const map = {};
        const order = [];
        scoped.forEach(r => {
            const d = String(r.dept || 'بدون قسم');
            if (!map[d]) { map[d] = { dept: d, count: 0, days: 0, emps: {} }; order.push(d); }
            map[d].count++;
            map[d].days += deducted(r);
            map[d].emps[String(r.empName || '')] = true;
        });

        const rows = order.map(d => ({
            dept: d,
            count: map[d].count,
            days: map[d].days,
            employees: Object.keys(map[d].emps).filter(Boolean).length
        })).sort((a, b) => b.count - a.count || a.dept.localeCompare(b.dept, 'ar'));

        const totals = rows.reduce((acc, r) => {
            acc.count += r.count; acc.days += r.days; return acc;
        }, { count: 0, days: 0 });

        const details = scoped.slice().sort((a, b) =>
            String(a.dept || '').localeCompare(String(b.dept || ''), 'ar') ||
            String(a.empName || '').localeCompare(String(b.empName || ''), 'ar') ||
            String(a.fromDate || '').localeCompare(String(b.fromDate || '')));

        return {
            mode: 'all',
            title: 'تقرير إجازات شامل',
            subject: 'جميع الأقسام',
            subLine: rows.length + ' قسم · ' + details.length + ' سجل',
            period: period,
            hasRows: details.length > 0,
            totals: totals,
            departments: rows,
            details: details.map(x => ({
                empName: x.empName, dept: x.dept, jobTitle: x.jobTitle, leaveType: x.leaveType,
                fromDate: x.fromDate, toDate: x.toDate,
                deductedDays: x.leaveTypeIsHourly ? 0 : deducted(x), hoursCount: num(x.hoursCount),
                leaveTypeIsHourly: !!x.leaveTypeIsHourly, fromTime: x.fromTime, toTime: x.toTime,
                status: x.status, notes: x.notes
            }))
        };
    }

    /** أرصدة الموظفين لسنة محددة */
    function buildBalance(period) {
        const year = period.year || new Date().getFullYear();
        const rows = getStaff()
            .filter(p => p && p.name && p.isActive !== false)
            .map(p => {
                const annual = num(p.annualBalance);
                const used = usedInYear(p.id, year);
                return {
                    id: p.id,
                    name: p.name,
                    jobTitle: p.jobTitle || '',
                    dept: p.dept || '',
                    employeeNumber: p.employeeNumber || '',
                    annualBalance: annual,
                    usedDays: used,
                    remainingDays: annual - used,
                    openCompensations: openComp(p.id)
                };
            })
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar'));

        const totals = rows.reduce((acc, r) => {
            acc.annual += r.annualBalance;
            acc.used += r.usedDays;
            acc.remaining += r.remainingDays;
            acc.open += r.openCompensations;
            acc.negative += (r.remainingDays < 0 ? 1 : 0);
            return acc;
        }, { annual: 0, used: 0, remaining: 0, open: 0, negative: 0 });

        return {
            mode: 'balance',
            title: 'تقرير أرصدة الإجازات السنوية',
            subject: 'أرصدة الموظفين',
            subLine: rows.length + ' موظف فعّال' + (totals.negative ? ' · ' + totals.negative + ' رصيد سالب' : ''),
            period: period,
            hasRows: rows.length > 0,
            totals: totals,
            employees: rows
        };
    }

    /** الأيام التعويضية في الفترة */
    function buildCompensation(period) {
        const all = getComps();
        const inPeriod = all.filter(c => {
            const ref = c.settledAt || c.createdAt;
            const d = isoOf(ref);
            if (!d) return true;               /* بلا تاريخ → يُعرض دائماً */
            return d >= period.from && d <= period.to;
        }).sort((a, b) => String(isoOf(a.settledAt || a.createdAt)).localeCompare(String(isoOf(b.settledAt || b.createdAt))));

        const empMap = {};
        const order = [];
        inPeriod.forEach(c => {
            const n = String(c.empName || (employeeOf('', c.empId) || {}).name || 'غير معروف');
            if (!empMap[n]) { empMap[n] = { name: n, open: 0, settled: 0, total: 0 }; order.push(n); }
            empMap[n].total += num(c.days);
            if (c.settled) empMap[n].settled += num(c.days);
            else empMap[n].open += num(c.days);
        });

        const employees = order.map(n => empMap[n]).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, 'ar'));
        const totals = inPeriod.reduce((acc, c) => {
            acc.days += num(c.days);
            if (c.settled) acc.settled += num(c.days);
            else acc.open += num(c.days);
            return acc;
        }, { days: 0, settled: 0, open: 0 });

        return {
            mode: 'compensation',
            title: 'تقرير الأيام التعويضية',
            subject: 'الأيام التعويضية',
            subLine: inPeriod.length + ' قيد · ' + totals.open + ' يوم غير مسدد',
            period: period,
            hasRows: inPeriod.length > 0,
            totals: { count: inPeriod.length, days: totals.days, settled: totals.settled, open: totals.open },
            employees: employees,
            details: inPeriod.map(c => ({
                empName: c.empName || (employeeOf('', c.empId) || {}).name || 'غير معروف',
                days: num(c.days),
                reason: c.reason || '',
                leaveId: c.leaveId || '',
                settled: !!c.settled,
                settledAt: isoOf(c.settledAt),
                createdAt: isoOf(c.createdAt)
            }))
        };
    }

    /* ---------------- رسم التقرير ---------------- */

    /** يبني HTML كامل للتقارير التي لا تحتاج جدولاً تفصيلياً كبيراً */
    function buildBodyHtml(rep) {
        let out = titleHtml(rep);

        if (rep.mode === 'employee') {
            out += sectionTitle('fa-user-check', 'ملخص إجازات الموظف');
            out += employeeSummaryHtml(rep);

            out += '<div class="mt-4">' + sectionTitle('fa-table-list', 'تفاصيل السجلات في الفترة') + '</div>';
            out += rep.hasRows ? detailsTable(rep.details, false) : emptyHtml('لا توجد إجازات مسجّلة لهذا الموظف في الفترة المحددة');
            return out;
        }

        if (rep.mode === 'department') {
            if (!rep.hasRows) return out + emptyHtml('لا توجد سجلات لهذا القسم في الفترة المحددة');

            out += sectionTitle('fa-users', 'مجاميع الموظفين في القسم');
            out += tableHtml(
                [{ label: 'ت' }, { label: 'اسم الموظف', align: 'right' }, { label: 'العنوان الوظيفي', align: 'right' },
                 { label: 'عدد السجلات' }, { label: 'الأيام المخصومة' }],
                rep.employees.map((e, i) => [
                    String(i + 1),
                    { html: App.Security.esc(e.name), cls: 'text-right font-bold' },
                    { html: App.Security.esc(e.jobTitle || '—'), cls: 'text-right' },
                    String(e.count),
                    String(e.days)
                ]).concat([[
                    { html: '<strong>المجموع</strong>', cls: 'text-right' }, '', '',
                    { html: '<strong>' + App.Security.esc(String(rep.totals.count)) + '</strong>' },
                    { html: '<strong>' + App.Security.esc(String(rep.totals.days)) + '</strong>' }
                ]])
            );

            out += '<div class="mt-4">' + sectionTitle('fa-table-list', 'التفاصيل حسب الموظف') + '</div>';
            rep.employees.forEach(e => {
                out += '<div class="mb-4 no-break">' +
                    '<div class="flex flex-wrap items-center justify-between gap-2 bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 mb-2">' +
                        '<span class="font-extrabold text-[11px] text-slate-800"><i class="fa-solid fa-user text-brand-600"></i> ' + App.Security.esc(e.name) + '</span>' +
                        '<span class="text-[10px] text-slate-600">' + App.Security.esc(e.jobTitle || '') + '</span>' +
                        '<span class="text-[10px] font-bold text-emerald-700">' + App.Security.esc(String(e.days)) + ' يوم مخصوم · ' + App.Security.esc(String(e.count)) + ' سجل</span>' +
                    '</div>' +
                    detailsTable(e.details, false) +
                '</div>';
            });
            return out;
        }

        if (rep.mode === 'all') {
            out += sectionTitle('fa-building', 'مجاميع الأقسام');
            if (rep.departments.length) {
                out += tableHtml(
                    [{ label: 'ت' }, { label: 'القسم / الشعبة', align: 'right' }, { label: 'عدد الموظفين' },
                     { label: 'عدد السجلات' }, { label: 'الأيام المخصومة' }],
                    rep.departments.map((d, i) => [
                        String(i + 1),
                        { html: App.Security.esc(d.dept), cls: 'text-right font-bold' },
                        String(d.employees), String(d.count), String(d.days)
                    ]).concat([[
                        { html: '<strong>المجموع العام</strong>', cls: 'text-right' }, '',
                        { html: '<strong>' + App.Security.esc(String(rep.totals.count)) + '</strong>' },
                        { html: '<strong>' + App.Security.esc(String(rep.totals.days)) + '</strong>' }
                    ]])
                );
            } else {
                out += emptyHtml();
            }

            out += '<div class="mt-4">' + sectionTitle('fa-table-list', 'تفاصيل السجلات في الفترة') + '</div>';
            out += rep.hasRows ? allDetailsTable(rep.details) : emptyHtml();
            return out;
        }

        if (rep.mode === 'balance') {
            out += sectionTitle('fa-scale-balanced', 'أرصدة الموظفين للسنة المحددة');
            if (!rep.hasRows) return out + emptyHtml('لا يوجد موظفون فعّالون في دليل الموظفين');

            out += tableHtml(
                [{ label: 'ت' }, { label: 'اسم الموظف', align: 'right' }, { label: 'القسم', align: 'right' },
                 { label: 'الرصيد السنوي' }, { label: 'المستهلك' }, { label: 'المتبقي' }, { label: 'تعويضات غير مسددة' }],
                rep.employees.map((e, i) => [
                    String(i + 1),
                    { html: App.Security.esc(e.name), cls: 'text-right font-bold' },
                    { html: App.Security.esc(e.dept || '—'), cls: 'text-right' },
                    String(e.annualBalance),
                    String(e.usedDays),
                    { html: App.Security.esc(String(e.remainingDays)), cls: e.remainingDays < 0 ? 'text-rose-700 font-bold' : 'font-bold' },
                    { html: App.Security.esc(String(e.openCompensations)), cls: e.openCompensations > 0 ? 'text-rose-700 font-bold' : '' }
                ]).concat([[
                    { html: '<strong>المجموع</strong>', cls: 'text-right' }, '', '',
                    { html: '<strong>' + App.Security.esc(String(rep.totals.annual)) + '</strong>' },
                    { html: '<strong>' + App.Security.esc(String(rep.totals.used)) + '</strong>' },
                    { html: '<strong>' + App.Security.esc(String(rep.totals.remaining)) + '</strong>' },
                    { html: '<strong>' + App.Security.esc(String(rep.totals.open)) + '</strong>' }
                ]])
            );

            out += '<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[11px]">' +
                cardBox('مجموع الأرصدة السنوية', String(rep.totals.annual) + ' يوم', 'text-slate-800') +
                cardBox('مجموع المستهلك', String(rep.totals.used) + ' يوم', 'text-amber-700') +
                cardBox('مجموع المتبقي', String(rep.totals.remaining) + ' يوم', rep.totals.remaining < 0 ? 'text-rose-700' : 'text-emerald-700') +
                cardBox('أرصدة سالبة', String(rep.totals.negative) + ' موظف', rep.totals.negative ? 'text-rose-700' : 'text-slate-800') +
                '</div>';
            return out;
        }

        if (rep.mode === 'compensation') {
            out += sectionTitle('fa-clock-rotate-left', 'مجاميع الأيام التعويضية لكل موظف');
            if (rep.employees.length) {
                out += tableHtml(
                    [{ label: 'ت' }, { label: 'اسم الموظف', align: 'right' }, { label: 'غير مسدد' },
                     { label: 'مسدد' }, { label: 'المجموع' }],
                    rep.employees.map((e, i) => [
                        String(i + 1),
                        { html: App.Security.esc(e.name), cls: 'text-right font-bold' },
                        { html: App.Security.esc(String(e.open)), cls: e.open > 0 ? 'text-rose-700 font-bold' : '' },
                        String(e.settled), String(e.total)
                    ]).concat([[
                        { html: '<strong>المجموع</strong>', cls: 'text-right' }, '',
                        { html: '<strong>' + App.Security.esc(String(rep.totals.open)) + '</strong>' },
                        { html: '<strong>' + App.Security.esc(String(rep.totals.settled)) + '</strong>' },
                        { html: '<strong>' + App.Security.esc(String(rep.totals.days)) + '</strong>' }
                    ]])
                );
            } else {
                out += emptyHtml();
            }

            out += '<div class="mt-2 text-[11px] font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">' +
                'إجمالي الأيام التعويضية في الفترة: <span class="text-slate-900">' + App.Security.esc(String(rep.totals.days)) + ' يوم</span>' +
                ' · غير مسدد: <span class="text-rose-700">' + App.Security.esc(String(rep.totals.open)) + ' يوم</span>' +
                ' · مسدد: <span class="text-emerald-700">' + App.Security.esc(String(rep.totals.settled)) + ' يوم</span>' +
                '</div>';

            out += '<div class="mt-4">' + sectionTitle('fa-table-list', 'سجل الأيام التعويضية') + '</div>';
            if (!rep.hasRows) {
                out += emptyHtml('لا توجد قيود تعويضية في الفترة المحددة');
            } else {
                out += tableHtml(
                    [{ label: 'ت' }, { label: 'التاريخ' }, { label: 'اسم الموظف', align: 'right' },
                     { label: 'عدد الأيام' }, { label: 'السبب', align: 'right' }, { label: 'الحالة' }, { label: 'تاريخ التسديد' }],
                    rep.details.map((c, i) => [
                        String(i + 1),
                        c.settledAt || c.createdAt || '—',
                        { html: App.Security.esc(c.empName), cls: 'text-right font-bold' },
                        String(c.days),
                        { html: App.Security.esc(clip(c.reason, 50) || '—'), cls: 'text-right' },
                        {
                            html: c.settled
                                ? '<span class="badge bg-emerald-100 text-emerald-800">مسدد</span>'
                                : '<span class="badge bg-rose-100 text-rose-800">غير مسدد</span>'
                        },
                        c.settledAt || '—'
                    ])
                );
            }
            return out;
        }

        return out + emptyHtml();
    }

    /** جدول تفاصيل سجلات الإجازات */
    function detailsTable(rows, withEmp) {
        const cols = withEmp
            ? [{ label: 'ت' }, { label: 'اسم الموظف', align: 'right' }, { label: 'نوع الإجازة', align: 'right' },
               { label: 'من تاريخ' }, { label: 'إلى تاريخ' }, { label: 'المدة' },
               { label: 'الأيام المخصومة' }, { label: 'الحالة' }, { label: 'الملاحظات', align: 'right' }]
            : [{ label: 'ت' }, { label: 'نوع الإجازة', align: 'right' }, { label: 'من تاريخ' }, { label: 'إلى تاريخ' },
               { label: 'المدة' }, { label: 'الأيام المخصومة' }, { label: 'الحالة' }, { label: 'الملاحظات', align: 'right' }];

        const body = (rows || []).map((r, i) => {
            const cells = [];
            cells.push(String(i + 1));
            if (withEmp) cells.push({ html: App.Security.esc(r.empName || ''), cls: 'text-right font-bold' });
            cells.push({ html: App.Security.esc(r.leaveType || ''), cls: 'text-right' });
            cells.push(App.Security.esc(Dates.formatISO(r.fromDate)));
            cells.push(App.Security.esc(Dates.formatISO(r.toDate) || Dates.formatISO(r.fromDate)));
            cells.push(App.Security.esc(r.leaveTypeIsHourly ? (num(r.hoursCount) + ' ساعة') : (num(r.deductedDays) + ' يوم')));
            cells.push(App.Security.esc(String(r.leaveTypeIsHourly ? 0 : num(r.deductedDays))));
            cells.push({ html: statusChip(r.status) });
            cells.push({ html: App.Security.esc(clip(r.notes, 60) || '—'), cls: 'text-right' });
            return cells;
        });

        const sumDays = (rows || []).reduce((s, r) => s + (r.leaveTypeIsHourly ? 0 : num(r.deductedDays)), 0);
        /* الأعمدة: ت + [الموظف] + النوع + من + إلى + المدة + (المخصوم) + الحالة + الملاحظات */
        const firstSpan = withEmp ? 6 : 5;
        const foot = '<tfoot><tr class="bg-slate-50 font-bold">' +
            '<td class="py-1.5 px-2 border border-slate-300 text-right" colspan="' + firstSpan + '">المجموع</td>' +
            '<td class="py-1.5 px-2 border border-slate-300">' + App.Security.esc(String(sumDays)) + '</td>' +
            '<td class="py-1.5 px-2 border border-slate-300" colspan="2">—</td>' +
            '</tr></tfoot>';

        return tableHtml(cols, body).replace('</table>', foot + '</table>');
    }

    /** جدول تفاصيل كل السجلات (يشمل القسم) */
    function allDetailsTable(rows) {
        const cols = [
            { label: 'ت' }, { label: 'القسم', align: 'right' }, { label: 'اسم الموظف', align: 'right' },
            { label: 'نوع الإجازة', align: 'right' }, { label: 'من تاريخ' }, { label: 'إلى تاريخ' },
            { label: 'الأيام المخصومة' }, { label: 'الحالة' }, { label: 'الملاحظات', align: 'right' }
        ];
        const body = (rows || []).map((r, i) => [
            String(i + 1),
            { html: App.Security.esc(r.dept || '—'), cls: 'text-right' },
            { html: App.Security.esc(r.empName || ''), cls: 'text-right font-bold' },
            { html: App.Security.esc(r.leaveType || ''), cls: 'text-right' },
            App.Security.esc(Dates.formatISO(r.fromDate)),
            App.Security.esc(Dates.formatISO(r.toDate) || Dates.formatISO(r.fromDate)),
            App.Security.esc(String(r.leaveTypeIsHourly ? 0 : num(r.deductedDays))),
            { html: statusChip(r.status) },
            { html: App.Security.esc(clip(r.notes, 50) || '—'), cls: 'text-right' }
        ]);
        return tableHtml(cols, body);
    }

    /* ---------------- التشغيل ---------------- */

    /** يبني التقرير المطلوب ويرسمه في #reportOutput */
    function run(opts) {
        opts = opts || {};
        const out = byId('reportOutput');
        if (!out) return null;

        try {
            const mode = valOf(byId('reportMode'), 'employee');
            const period = readPeriod(mode);
            const name = valOf(byId('reportEmpName'), '');
            const dept = valOf(byId('reportDept'), '');

            let rep;
            if (mode === 'department') {
                rep = buildDepartment(period, dept);
            } else if (mode === 'all') {
                rep = buildAll(period);
            } else if (mode === 'balance') {
                rep = buildBalance(period);
            } else if (mode === 'compensation') {
                rep = buildCompensation(period);
            } else {
                if (!name) {
                    out.innerHTML = headerHtml(getSettings()) + emptyHtml('يرجى اختيار موظف من القائمة أولاً');
                    hasReport = false;
                    current = null;
                    syncButtons();
                    return null;
                }
                rep = buildEmployee('employee', period, { empName: name });
            }

            current = rep;
            hasReport = true;

            const s = getSettings();
            out.innerHTML = headerHtml(s) + buildBodyHtml(rep) + footerHtml(s);

            syncButtons();
            if (!opts.silent) {
                const total = rep.totals && (rep.totals.count !== undefined ? rep.totals.count : rep.totals.days);
                App.Notify.toast('تم إنشاء التقرير' + (rep.hasRows ? ' (' + num(total) + ' سجل)' : ' — لا توجد سجلات في الفترة'), rep.hasRows ? 'success' : 'info');
            }
            return rep;
        } catch (err) {
            console.error('[Reports] فشل إنشاء التقرير', err);
            current = null;
            hasReport = false;
            out.innerHTML = headerHtml(getSettings()) +
                '<div class="text-center py-10 text-rose-700 text-sm font-bold">تعذّر إنشاء التقرير. يرجى المحاولة مرة أخرى.</div>';
            syncButtons();
            if (!opts.silent) App.Notify.toast('تعذّر إنشاء التقرير', 'error');
            return null;
        }
    }

    /** تعطيل أزرار التصدير قبل إنشاء أي تقرير */
    function syncButtons() {
        ['btnReportExcel', 'btnReportPdf', 'btnReportPrint'].forEach(id => {
            const b = byId(id);
            if (b) b.disabled = !hasReport;
        });
    }

    /* ---------------- التصدير ---------------- */

    /** أوراق Excel: ملخص + تفاصيل بحسب النمط */
    function sheetsFor(rep) {
        const s = getSettings();
        const summary = [
            ['نظام موقف الإجازات اليومية'],
            ['الوزارة', s.ministry || ''],
            ['الدائرة', s.directorate || ''],
            ['المستشفى / المؤسسة', s.hospital || ''],
            ['القسم / الوحدة', s.departmentUnit || ''],
            [],
            ['عنوان التقرير', rep.title],
            ['الموضوع', rep.subject || ''],
            ['الفترة', rep.period.title],
            ['من تاريخ', rep.period.from],
            ['إلى تاريخ', rep.period.to],
            ['تاريخ الإصدار', Dates.todayISO()],
            ['وقت الإصدار', nowTime()]
        ];

        const detailRows = [];
        let detailsName = 'التفاصيل';

        if (rep.mode === 'employee') {
            summary.push([], ['—— ملخص أنواع الإجازات ——'], ['نوع الإجازة', 'عدد السجلات', 'الأيام المخصومة']);
            rep.typeBreakdown.forEach(t => summary.push([t.name, t.count, t.hourly ? 0 : t.days]));
            summary.push(['المجموع', rep.totals.count, rep.totals.days]);
            summary.push([], ['—— الرصيد ——']);
            summary.push(['الرصيد السنوي', rep.annualBalance]);
            summary.push(['المستهلك في ' + rep.period.year, rep.usedBalance]);
            summary.push(['الرصيد المتبقي', rep.remainingBalance]);
            summary.push(['أيام تعويضية غير مسددة', rep.openCompensations]);

            detailsName = 'تفاصيل الإجازات';
            detailRows.push(['ت', 'نوع الإجازة', 'من تاريخ', 'إلى تاريخ', 'المدة', 'الأيام المخصومة', 'الحالة', 'الملاحظات']);
            rep.details.forEach((r, i) => detailRows.push([
                i + 1, r.leaveType || '', Dates.formatISO(r.fromDate), Dates.formatISO(r.toDate) || Dates.formatISO(r.fromDate),
                r.leaveTypeIsHourly ? (num(r.hoursCount) + ' ساعة') : (num(r.deductedDays) + ' يوم'),
                r.leaveTypeIsHourly ? 0 : num(r.deductedDays),
                (C.STATUS_LABEL && C.STATUS_LABEL[r.status]) || r.status || '', r.notes || ''
            ]));
        } else if (rep.mode === 'department') {
            summary.push([], ['—— مجاميع الموظفين ——'], ['اسم الموظف', 'العنوان الوظيفي', 'عدد السجلات', 'الأيام المخصومة']);
            rep.employees.forEach(e => summary.push([e.name, e.jobTitle || '', e.count, e.days]));
            summary.push(['المجموع', '', rep.totals.count, rep.totals.days]);

            detailsName = 'تفاصيل القسم';
            detailRows.push(['ت', 'اسم الموظف', 'نوع الإجازة', 'من تاريخ', 'إلى تاريخ', 'الأيام المخصومة', 'الحالة', 'الملاحظات']);
            let i = 0;
            rep.employees.forEach(e => e.details.forEach(r => {
                i++;
                detailRows.push([
                    i, r.empName || e.name, r.leaveType || '', Dates.formatISO(r.fromDate),
                    Dates.formatISO(r.toDate) || Dates.formatISO(r.fromDate),
                    r.leaveTypeIsHourly ? 0 : num(r.deductedDays),
                    (C.STATUS_LABEL && C.STATUS_LABEL[r.status]) || r.status || '', r.notes || ''
                ]);
            }));
        } else if (rep.mode === 'all') {
            summary.push([], ['—— مجاميع الأقسام ——'], ['القسم', 'عدد الموظفين', 'عدد السجلات', 'الأيام المخصومة']);
            rep.departments.forEach(d => summary.push([d.dept, d.employees, d.count, d.days]));
            summary.push(['المجموع العام', '', rep.totals.count, rep.totals.days]);

            detailsName = 'جميع السجلات';
            detailRows.push(['ت', 'القسم', 'اسم الموظف', 'نوع الإجازة', 'من تاريخ', 'إلى تاريخ', 'الأيام المخصومة', 'الحالة', 'الملاحظات']);
            rep.details.forEach((r, i) => detailRows.push([
                i + 1, r.dept || '', r.empName || '', r.leaveType || '',
                Dates.formatISO(r.fromDate), Dates.formatISO(r.toDate) || Dates.formatISO(r.fromDate),
                r.leaveTypeIsHourly ? 0 : num(r.deductedDays),
                (C.STATUS_LABEL && C.STATUS_LABEL[r.status]) || r.status || '', r.notes || ''
            ]));
        } else if (rep.mode === 'balance') {
            summary.push([], ['—— ملخص الأرصدة ——']);
            summary.push(['مجموع الأرصدة السنوية', rep.totals.annual]);
            summary.push(['مجموع المستهلك', rep.totals.used]);
            summary.push(['مجموع المتبقي', rep.totals.remaining]);
            summary.push(['أيام تعويضية غير مسددة', rep.totals.open]);
            summary.push(['أرصدة سالبة', rep.totals.negative]);

            detailsName = 'أرصدة الموظفين';
            detailRows.push(['ت', 'اسم الموظف', 'العنوان الوظيفي', 'القسم', 'الرصيد السنوي', 'المستهلك', 'المتبقي', 'تعويضات غير مسددة']);
            rep.employees.forEach((e, i) => detailRows.push([
                i + 1, e.name, e.jobTitle || '', e.dept || '',
                e.annualBalance, e.usedDays, e.remainingDays, e.openCompensations
            ]));
        } else if (rep.mode === 'compensation') {
            summary.push([], ['—— ملخص التعويضات ——']);
            summary.push(['إجمالي الأيام التعويضية', rep.totals.days]);
            summary.push(['غير مسدد', rep.totals.open]);
            summary.push(['مسدد', rep.totals.settled]);
            summary.push([], ['مجاميع الموظفين'], ['اسم الموظف', 'غير مسدد', 'مسدد', 'المجموع']);
            rep.employees.forEach(e => summary.push([e.name, e.open, e.settled, e.total]));

            detailsName = 'الأيام التعويضية';
            detailRows.push(['ت', 'التاريخ', 'اسم الموظف', 'عدد الأيام', 'السبب', 'الحالة', 'تاريخ التسديد']);
            rep.details.forEach((c, i) => detailRows.push([
                i + 1, c.settledAt || c.createdAt || '', c.empName || '', c.days, c.reason || '',
                c.settled ? 'مسدد' : 'غير مسدد', c.settledAt || ''
            ]));
        }

        if (!detailRows.length) detailRows.push(['لا توجد بيانات في الفترة المحددة']);

        return [
            { name: 'ملخص التقرير', rows: summary, widths: [30, 22, 22, 20] },
            { name: detailsName, rows: detailRows, widths: [6, 28, 22, 14, 14, 16, 14, 30] }
        ];
    }

    /** تصدير Excel: ملخص + تفاصيل */
    function exportExcel() {
        let rep = current;
        if (!rep) rep = run({ silent: true });
        if (!rep) { App.Notify.toast('يرجى إنشاء التقرير أولاً', 'warning'); return false; }

        const fileName = 'تقرير_' + App.Security.safeFileName(rep.subject || rep.mode, 'التقرير') +
            '_' + Dates.todayISO() + '.xlsx';

        const ok = App.Exporters.excel(sheetsFor(rep), fileName);
        if (ok) App.Notify.toast('تم تصدير التقرير إلى Excel', 'success');
        return ok;
    }

    /** تصدير PDF من عنصر التقرير */
    function exportPdf() {
        const target = byId('reportOutput');
        if (!target || !hasReport) {
            const rep = run({ silent: true });
            if (!rep) { App.Notify.toast('يرجى إنشاء التقرير أولاً', 'warning'); return Promise.resolve(false); }
        }
        const el = byId('reportOutput');
        if (!el) return Promise.resolve(false);

        const title = (current && current.title) || 'تقرير';
        const fileName = 'تقرير_' + App.Security.safeFileName((current && current.subject) || 'التقرير', 'التقرير') +
            '_' + Dates.todayISO() + '.pdf';

        return App.Exporters.pdfFromElement(el, fileName)
            .then(() => { App.Notify.toast('تم إنشاء ملف PDF', 'success'); return true; })
            .catch(() => false);
    }

    /** طباعة التقرير فقط */
    function printReport() {
        if (!hasReport) {
            const rep = run({ silent: true });
            if (!rep) { App.Notify.toast('يرجى إنشاء التقرير أولاً', 'warning'); return; }
        }
        const el = byId('reportOutput');
        if (!el) return;
        const s = getSettings();
        const title = ((current && current.title) || 'تقرير') + ' — ' + (s.hospital || '');
        App.Exporters.printElement(el, title);
    }

    /* ---------------- التهيئة ---------------- */

    function cacheEls() {
        els = {
            reportMode: byId('reportMode'),
            reportEmpName: byId('reportEmpName'),
            reportDept: byId('reportDept'),
            reportPeriodType: byId('reportPeriodType'),
            reportMonth: byId('reportMonth'),
            reportYear: byId('reportYear'),
            reportFrom: byId('reportFrom'),
            reportTo: byId('reportTo'),
            reportOutput: byId('reportOutput'),
            btnRunReport: byId('btnRunReport'),
            btnReportExcel: byId('btnReportExcel'),
            btnReportPdf: byId('btnReportPdf'),
            btnReportPrint: byId('btnReportPrint')
        };
    }

    function wire() {
        if (els.btnRunReport) els.btnRunReport.addEventListener('click', () => run());
        if (els.btnReportExcel) els.btnReportExcel.addEventListener('click', exportExcel);
        if (els.btnReportPdf) els.btnReportPdf.addEventListener('click', exportPdf);
        if (els.btnReportPrint) els.btnReportPrint.addEventListener('click', printReport);

        if (els.reportMode) els.reportMode.addEventListener('change', () => { syncBoxes(); run({ silent: true }); });
        if (els.reportPeriodType) els.reportPeriodType.addEventListener('change', () => { syncBoxes(); run({ silent: true }); });
        if (els.reportMonth) els.reportMonth.addEventListener('change', () => run({ silent: true }));
        if (els.reportYear) els.reportYear.addEventListener('change', () => run({ silent: true }));
        if (els.reportFrom) els.reportFrom.addEventListener('change', () => run({ silent: true }));
        if (els.reportTo) els.reportTo.addEventListener('change', () => run({ silent: true }));

        /* تغيير الموظف/القسم لا يعيد البناء تلقائياً — ينتظر زر «إنشاء التقرير» */
        [els.reportEmpName, els.reportDept].forEach(sel => {
            if (sel) sel.addEventListener('change', () => { hasReport = false; current = null; syncButtons(); });
        });
    }

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        cacheEls();
        applyDefaults();
        syncBoxes();
        wire();
        subscribe();
        refreshSelects();
        syncButtons();
    }

    /** إعادة المزامنة: القوائم + إعادة إنشاء التقرير الحالي */
    function refresh() {
        cacheEls();
        applyDefaults();
        syncBoxes();
        refreshSelects();
        if (hasReport) run({ silent: true });
        else syncButtons();
    }

    return {
        init: init,
        run: run,
        refresh: refresh
    };
})();
