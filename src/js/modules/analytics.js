/* ============================================================
   وحدة الإحصائيات والتحليلات البيانية
   ------------------------------------------------------------
   - تُبنى على App.Store كمصدر وحيد للبيانات، وتستثني كل سجل
     حالته «ملغاة» أو «مرفوضة» من كل إحصائية.
   - الرسوم عبر Chart.js (النسخة العامة window.Chart) مع تدمير
     كل نسخة سابقة قبل إعادة الرسم على نفس اللوحة.
   - لا حساب للرسوم أثناء إخفاء التبويب، بل يُرفع علم «يحتاج
     إعادة رسم» ثم يُستدعى App.Analytics.refresh() عند فتح التبويب.
   - سكربت كلاسيكي داخل IIFE (لا وحدات ES) ليعمل على file://
   ============================================================ */
(function () {
    'use strict';

    window.App = window.App || {};

    App.Analytics = (function () {

        const C = App.Constants;
        const D = App.Dates;

        /* ألوان احتياطية للأقسام عند غياب لون النوع */
        const PALETTE = [
            '#0284c7', '#0891b2', '#16a34a', '#65a30d', '#d97706',
            '#db2777', '#7c3aed', '#4f46e5', '#0d9488', '#dc2626'
        ];

        const FONT = 'Cairo, Tajawal, sans-serif';

        /* ---------------- مراجع العناصر ---------------- */
        let view = null;
        let elFrom = null, elTo = null, elQuick = null, elDept = null, elType = null;
        let elBtnRun = null, elBtnExcel = null;
        let kpiTotal = null, kpiCurrent = null, kpiTopDept = null, kpiDays = null;
        let emptyBox = null;

        /* ---------------- الحالة ---------------- */
        let inited = false;
        let bound = false;
        let stale = true;        /* البيانات تغيّرت — يلزم إعادة حساب */
        let needsDraw = true;    /* الرسوم لم تُرسم لأن اللوحة كانت مخفية */
        let chartMissingMsg = false;
        let lastModel = null;    /* آخر تجميعة محسوبة — تُستخدم في التصدير */
        let offStore = null;

        /* كل مستمعي الأحداث لتسهيل الفصل في destroy() */
        const listeners = [];
        /* نسخ Chart.js الجارية — تُدمَّر قبل إعادة الاستخدام */
        const charts = { byDept: null, byType: null, trend: null, topEmp: null };

        /* ============================================================
           أدوات عامة
           ============================================================ */

        const $ = (id) => document.getElementById(id);
        const esc = (v) => (App.Security && App.Security.esc ? App.Security.esc(v) : '');
        const txt = (v) => (v === null || v === undefined ? '' : String(v));
        const num = (v) => {
            const n = parseFloat(v);
            return isNaN(n) ? 0 : n;
        };

        function bind(target, evt, handler) {
            if (!target || typeof target.addEventListener !== 'function') return;
            target.addEventListener(evt, handler);
            listeners.push({ target: target, evt: evt, handler: handler });
        }

        function unbindAll() {
            listeners.forEach((l) => {
                try { l.target.removeEventListener(l.evt, l.handler); } catch (e) { /* تجاهل */ }
            });
            listeners.length = 0;
        }

        /** هل التبويب ظاهر فعلاً؟ (Tailwind يخفي بـ display:none) */
        function isVisible() {
            if (!view) return false;
            if (view.offsetParent === null) return false;
            try {
                if (view.getBoundingClientRect().width === 0) return false;
            } catch (e) { /* نتجاهل */ }
            return true;
        }

        /** أي عنصر واجهة مفقود؟ لا نُسقط الوحدة بل نعطّل بلطف */
        function elementsOk() {
            return !!(elFrom && elTo && elQuick && elDept && elType);
        }

        function warn(message) {
            if (App.Notify && App.Notify.toast) App.Notify.toast(message, 'warning');
        }

        /* ============================================================
           الفلاتر
           ============================================================ */

        /** تعبئة قوائم القسم والنوع من البيانات الحالية مع حفظ الاختيار */
        function fillSelect(sel, items, allLabel) {
            if (!sel) return;
            const current = sel.value || '';
            const head = '<option value="">' + esc(allLabel) + '</option>';
            const body = items.map((it) => '<option value="' + esc(it) + '">' + esc(it) + '</option>').join('');
            sel.innerHTML = head + body;
            if (current && items.indexOf(current) !== -1) sel.value = current;
        }

        function refreshFilterOptions(leaves) {
            const depts = [];
            const seenD = {};

            /* الأقسام من دليل الأقسام الرسمي أولاً، حتى لا تفرغ القائمة
               قبل وجود أي سجل إجازة */
            (App.Store.get.departments() || []).forEach((d) => {
                const n = txt(d && d.name).trim();
                if (n && !seenD[n]) { seenD[n] = true; depts.push(n); }
            });
            /* ثم أي قسم ورد في السجلات ولم يعد مدرجاً في الدليل */
            leaves.forEach((r) => {
                const d = txt(r.dept).trim();
                if (d && !seenD[d]) { seenD[d] = true; depts.push(d); }
            });
            depts.sort((a, b) => a.localeCompare(b, 'ar'));
            fillSelect(elDept, depts, 'جميع الأقسام');

            /* الأنواع من تعريفات النظام أولاً ثم ما ورد في السجلات */
            const types = [];
            const seenT = {};
            (App.Store.get.leaveTypes() || []).forEach((t) => {
                const n = txt(t && t.name).trim();
                if (n && !seenT[n]) { seenT[n] = true; types.push(n); }
            });
            leaves.forEach((r) => {
                const n = txt(r.leaveType).trim();
                if (n && !seenT[n]) { seenT[n] = true; types.push(n); }
            });
            fillSelect(elType, types, 'جميع الأنواع');
        }

        /** يملأ حقلي التاريخ حسب الفترة السريعة المختارة */
        function applyQuickRange(mode) {
            const today = D.todayISO();
            let range = null;

            if (mode === 'today') {
                range = { from: today, to: today };
            } else if (mode === 'week') {
                range = { from: D.addDays(today, -6), to: today };
            } else if (mode === 'month') {
                range = D.monthRange(D.yearOf(today), D.monthOf(today));
            } else if (mode === 'year') {
                range = D.yearRange(D.yearOf(today));
            }

            if (!range) return false;
            if (elFrom) elFrom.value = range.from;
            if (elTo) elTo.value = range.to;
            return true;
        }

        /** النطاق الحالي مع تصحيح الأخطاء (نهاية قبل بداية / قيم فارغة) */
        function readRange() {
            const today = D.todayISO();
            let from = D.formatISO(elFrom && elFrom.value);
            let to = D.formatISO(elTo && elTo.value);

            if (!D.parseISO(from)) {
                from = D.yearRange(D.yearOf(today)).from;
                if (elFrom) elFrom.value = from;
            }
            if (!D.parseISO(to)) {
                to = today;
                if (elTo) elTo.value = to;
            }
            if (from > to) {
                const tmp = from; from = to; to = tmp;
                if (elFrom) elFrom.value = from;
                if (elTo) elTo.value = to;
                warn('تم تصحيح النطاق: تاريخ البداية كان بعد تاريخ النهاية');
            }
            return { from: from, to: to, today: today };
        }

        function readFilters() {
            return {
                dept: elDept ? elDept.value : '',
                type: elType ? elType.value : ''
            };
        }

        /* ============================================================
           الحسابات
           ============================================================ */

        /** استثناء الملغاة والمرفوضة — قاعدة ثابتة في كل إحصائية */
        function isCounted(r) {
            return !!r && r.status !== C.STATUS.CANCELLED && r.status !== C.STATUS.REJECTED;
        }

        /** السجلات المطابقة للتاريخ والفلاتر */
        function selectLeaves(range, filters) {
            const all = App.Store.get.leaves() || [];
            return all.filter((r) => {
                if (!isCounted(r)) return false;
                const d = D.formatISO(r.fromDate);
                if (!d) return false;
                if (range && (d < range.from || d > range.to)) return false;
                if (filters.dept && txt(r.dept).trim() !== filters.dept) return false;
                if (filters.type && txt(r.leaveType).trim() !== filters.type) return false;
                return true;
            });
        }

        /** هل يغطي السجل تاريخ اليوم؟ (يُستخدم لعدّ المجازين حالياً) */
        function coversToday(r, today) {
            const from = D.formatISO(r.fromDate);
            const to = D.formatISO(r.toDate) || from;
            if (!from) return false;
            return today >= from && today <= to;
        }

        /**
         * يبني التجميعات كاملة: مؤشرات + بيانات الرسوم + بيانات التصدير.
         * يُرجع كائناً واحداً يُخزَّن في lastModel ليعاد استخدامه.
         */
        function compute() {
            const range = readRange();
            const filters = readFilters();
            const leaves = selectLeaves(range, filters);

            /* --- مؤشر «مجازون حالياً»: موظفون فريدون يغطي سجلهم اليوم --- */
            const currentKeys = {};
            leaves.forEach((r) => {
                if (!coversToday(r, range.today)) return;
                const key = r.empId || ('n:' + txt(r.empName).trim());
                currentKeys[key] = true;
            });
            const current = Object.keys(currentKeys).length;

            /* --- الأيام المخصومة --- */
            const days = leaves.reduce((sum, r) => sum + num(r.deductedDays), 0);

            /* --- حسب القسم (تنازلي، أعلى 10) --- */
            const deptMap = {};
            leaves.forEach((r) => {
                const d = txt(r.dept).trim() || 'غير محدد';
                deptMap[d] = (deptMap[d] || 0) + 1;
            });
            const byDept = Object.keys(deptMap)
                .map((name) => ({ label: name, value: deptMap[name] }))
                .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ar'))
                .slice(0, 10);

            /* --- حسب نوع الإجازة (مع ألوان تعريفات الأنواع) --- */
            const typeMap = {};
            leaves.forEach((r) => {
                const n = txt(r.leaveType).trim() || 'غير محدد';
                typeMap[n] = (typeMap[n] || 0) + 1;
            });
            const typeDefs = App.Store.get.leaveTypes() || [];
            const typesTotal = leaves.length || 1;
            const byType = Object.keys(typeMap).map((name, i) => {
                const def = typeDefs.find((t) => txt(t && t.name).trim() === name) || null;
                const count = typeMap[name];
                return {
                    id: def ? def.id : '',
                    label: name,
                    value: count,
                    percent: Math.round((count / typesTotal) * 1000) / 10,
                    color: (def && def.color) ? def.color : PALETTE[i % PALETTE.length]
                };
            }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ar'));

            /* --- الاتجاه الشهري: كل أشهر النطاق مع تعبئة الأصفار --- */
            const monthMap = {};
            leaves.forEach((r) => {
                const key = D.isoMonth(r.fromDate);
                if (!key) return;
                monthMap[key] = (monthMap[key] || 0) + 1;
            });
            const trend = [];
            const startY = D.yearOf(range.from);
            const startM = D.monthOf(range.from);
            const endY = D.yearOf(range.to);
            const endM = D.monthOf(range.to);
            if (startY && startM && endY && endM) {
                let y = startY;
                let m = startM;
                let guard = 0;
                while ((y < endY || (y === endY && m <= endM)) && guard < 600) {
                    const key = y + '-' + D.pad2(m);
                    const label = D.monthName(m) + ' ' + y;
                    trend.push({
                        key: key,
                        label: label,
                        shortLabel: D.monthName(m) + ' ' + String(y).slice(2),
                        value: monthMap[key] || 0
                    });
                    m++;
                    if (m > 12) { m = 1; y++; }
                    guard++;
                }
            }

            /* --- أكثر الموظفين إجازات (تنازلي، أعلى 10) --- */
            const empMap = {};
            leaves.forEach((r) => {
                const n = txt(r.empName).trim() || 'غير محدد';
                empMap[n] = (empMap[n] || 0) + 1;
            });
            const topEmployees = Object.keys(empMap)
                .map((name) => ({ label: name, value: empMap[name] }))
                .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ar'))
                .slice(0, 10);

            /* --- أعلى قسم بالاسم لا بالرقم --- */
            let topDept = '';
            let topDeptCount = 0;
            if (byDept.length) {
                topDept = byDept[0].label;
                topDeptCount = byDept[0].value;
            }

            return {
                range: range,
                filters: filters,
                total: leaves.length,
                current: current,
                days: Math.round(days * 100) / 100,
                topDept: topDept,
                topDeptCount: topDeptCount,
                byDept: byDept,
                byType: byType,
                trend: trend,
                topEmployees: topEmployees,
                leaves: leaves
            };
        }

        /* ============================================================
           المؤشرات ورسالة «لا بيانات»
           ============================================================ */

        function renderKpis(model) {
            if (kpiTotal) kpiTotal.textContent = String(model.total);
            if (kpiCurrent) kpiCurrent.textContent = String(model.current);
            if (kpiDays) kpiDays.textContent = String(model.days);
            /* اسم القسم يُعرض كنص لا كرقم */
            if (kpiTopDept) kpiTopDept.textContent = model.topDept || '—';
        }

        function ensureEmptyBox() {
            if (emptyBox && document.body.contains(emptyBox)) return emptyBox;
            if (!view) return null;
            emptyBox = document.createElement('div');
            emptyBox.id = 'anEmptyState';
            emptyBox.className = 'bg-white rounded-2xl border border-slate-200 shadow-sm p-10 text-center';
            emptyBox.innerHTML =
                '<i class="fa-solid fa-chart-pie text-3xl text-slate-300"></i>' +
                '<p class="text-sm font-bold text-slate-500 mt-3">لا توجد سجلات مطابقة للفلاتر المحددة</p>' +
                '<p class="text-[11px] text-slate-400 mt-1">جرّب توسيع النطاق الزمني أو إلغاء فلتر القسم/النوع</p>';
            view.appendChild(emptyBox);
            return emptyBox;
        }

        function renderEmptyState(show) {
            const box = ensureEmptyBox();
            if (box) box.classList.toggle('hidden', !show);
        }

        /* ============================================================
           الرسوم البيانية
           ============================================================ */

        function ensureChartLib() {
            if (typeof window.Chart !== 'undefined') return true;
            if (!chartMissingMsg) {
                chartMissingMsg = true;
                if (App.Notify && App.Notify.alert) {
                    App.Notify.alert('مكتبة الرسوم البيانية المحلية لم تُحمّل، لذا لا يمكن عرض المخططات. تأكد من وجود assets/js/chart.umd.min.js ثم أعد تحميل الصفحة.', 'warning', 'الرسوم غير متاحة');
                } else {
                    warn('مكتبة الرسوم البيانية غير متاحة');
                }
            }
            return false;
        }

        /** يدمّر كل النسخ الجارية — يمنع خطأ Canvas is already in use */
        function destroyCharts() {
            Object.keys(charts).forEach((key) => {
                const inst = charts[key];
                if (!inst) return;
                try { inst.destroy(); } catch (e) { /* تجاهل */ }
                charts[key] = null;
            });
        }

        /** إعدادات عربية موحّدة (RTL + خط Cairo) */
        function baseOptions(extra) {
            const opts = {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                layout: { padding: { top: 4, right: 4, left: 4, bottom: 4 } },
                plugins: {
                    legend: {
                        rtl: true,
                        textDirection: 'rtl',
                        labels: {
                            font: { family: FONT, size: 12 },
                            color: '#334155',
                            usePointStyle: true,
                            boxWidth: 10
                        }
                    },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        titleFont: { family: FONT, size: 12 },
                        bodyFont: { family: FONT, size: 12 }
                    }
                }
            };
            /* دمج سطحي كافٍ لاحتياجات هذه الوحدة */
            const src = extra || {};
            Object.keys(src).forEach((k) => {
                if (k === 'plugins') {
                    opts.plugins = Object.assign({}, opts.plugins, src.plugins);
                } else {
                    opts[k] = src[k];
                }
            });
            return opts;
        }

        function axesFont(color) {
            return {
                ticks: { font: { family: FONT, size: 11 }, color: color || '#475569' },
                grid: { color: 'rgba(148, 163, 184, 0.25)' },
                border: { color: 'rgba(148, 163, 184, 0.5)' }
            };
        }

        /* ============================================================
           محاور الواجهة العربية (RTL):
           محور القيم على اليمين، والتصنيفات تبدأ من اليمين.
           ============================================================ */
        function rtlValueAxis(extra) {
            return Object.assign({}, axesFont(), {
                position: 'right',
                beginAtZero: true,
                ticks: { precision: 0, font: { family: FONT, size: 11 }, color: '#475569' }
            }, extra || {});
        }

        function rtlCategoryAxis(extra) {
            return Object.assign({}, axesFont('#334155'), {
                reverse: true,
                grid: { display: false }
            }, extra || {});
        }

        function renderByDept(model) {
            const canvas = $('chartByDept');
            if (!canvas) return;
            if (charts.byDept) { try { charts.byDept.destroy(); } catch (e) { /* تجاهل */ } charts.byDept = null; }

            const labels = model.byDept.map((d) => d.label);
            const values = model.byDept.map((d) => d.value);
            const colors = model.byDept.map((d, i) => {
                const t = model.byType.find((x) => x.label === d.label);
                return (t && t.color) || PALETTE[i % PALETTE.length];
            });

            charts.byDept = new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'عدد الإجازات',
                        data: values,
                        backgroundColor: colors.map((c) => c + 'cc'),
                        borderColor: colors,
                        borderWidth: 1,
                        borderRadius: 6,
                        maxBarThickness: 34
                    }]
                },
                options: baseOptions({
                    plugins: { legend: { display: false } },
                    scales: {
                        x: rtlCategoryAxis(),
                        y: rtlValueAxis()
                    }
                })
            });
        }

        function renderByType(model) {
            const canvas = $('chartByType');
            if (!canvas) return;
            if (charts.byType) { try { charts.byType.destroy(); } catch (e) { /* تجاهل */ } charts.byType = null; }

            const labels = model.byType.map((t) => t.label);
            const values = model.byType.map((t) => t.value);
            const colors = model.byType.map((t, i) => t.color || PALETTE[i % PALETTE.length]);

            charts.byType = new window.Chart(canvas, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: values,
                        backgroundColor: colors,
                        borderColor: '#ffffff',
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: baseOptions({
                    cutout: '55%',
                    plugins: {
                        legend: {
                            position: 'bottom',
                            rtl: true,
                            textDirection: 'rtl',
                            labels: {
                                font: { family: FONT, size: 11 },
                                color: '#334155',
                                usePointStyle: true,
                                boxWidth: 10,
                                padding: 10
                            }
                        },
                        tooltip: {
                            rtl: true,
                            textDirection: 'rtl',
                            titleFont: { family: FONT, size: 12 },
                            bodyFont: { family: FONT, size: 12 },
                            callbacks: {
                                label: (ctx) => {
                                    const total = ctx.dataset.data.reduce((s, v) => s + num(v), 0) || 1;
                                    const pct = Math.round((num(ctx.parsed) / total) * 1000) / 10;
                                    return ' ' + ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
                                }
                            }
                        }
                    }
                })
            });
        }

        function renderTrend(model) {
            const canvas = $('chartTrend');
            if (!canvas) return;
            if (charts.trend) { try { charts.trend.destroy(); } catch (e) { /* تجاهل */ } charts.trend = null; }

            const labels = model.trend.map((t) => t.shortLabel);
            const values = model.trend.map((t) => t.value);
            const full = model.trend.map((t) => t.label);

            charts.trend = new window.Chart(canvas, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'عدد الإجازات',
                        data: values,
                        borderColor: '#0284c7',
                        backgroundColor: 'rgba(2, 132, 199, 0.15)',
                        pointBackgroundColor: '#0284c7',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        borderWidth: 2.5,
                        tension: 0.32,
                        fill: true,
                        _fullLabels: full
                    }]
                },
                options: baseOptions({
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            rtl: true,
                            textDirection: 'rtl',
                            titleFont: { family: FONT, size: 12 },
                            bodyFont: { family: FONT, size: 12 },
                            callbacks: {
                                title: (items) => {
                                    const i = items && items.length ? items[0].dataIndex : -1;
                                    return i >= 0 && full[i] ? full[i] : '';
                                }
                            }
                        }
                    },
                    scales: {
                        x: rtlCategoryAxis(),
                        y: rtlValueAxis()
                    }
                })
            });
        }

        function renderTopEmployees(model) {
            const canvas = $('chartTopEmp');
            if (!canvas) return;
            if (charts.topEmp) { try { charts.topEmp.destroy(); } catch (e) { /* تجاهل */ } charts.topEmp = null; }

            const labels = model.topEmployees.map((e) => e.label);
            const values = model.topEmployees.map((e) => e.value);

            charts.topEmp = new window.Chart(canvas, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'عدد الإجازات',
                        data: values,
                        backgroundColor: 'rgba(13, 148, 136, 0.75)',
                        borderColor: '#0d9488',
                        borderWidth: 1,
                        borderRadius: 6,
                        maxBarThickness: 26
                    }]
                },
                options: baseOptions({
                    indexAxis: 'y',
                    plugins: { legend: { display: false } },
                    scales: {
                        /* محور القيم معكوس ليبدأ الصفر من اليمين،
                           والتصنيفات على اليمين أيضاً */
                        x: rtlValueAxis({ reverse: true, grid: { display: true } }),
                        y: rtlCategoryAxis({ position: 'right', reverse: true })
                    }
                })
            });
        }

        function renderCharts(model) {
            if (!ensureChartLib()) return;
            destroyCharts();
            /* نرسم دائماً ولو كانت القيم أصفاراً حتى تظهر المحاور والاتجاه */
            renderByDept(model);
            renderByType(model);
            renderTrend(model);
            renderTopEmployees(model);
        }

        /* ============================================================
           الرسم الكامل
           ============================================================ */

        function renderAll(opts) {
            const options = opts || {};
            if (!elementsOk()) return;

            /* الخيارات تُبنى من كل السجلات النشطة، لا من نطاق التاريخ */
            const active = (App.Store.get.leaves() || []).filter(isCounted);
            refreshFilterOptions(active);

            const model = compute();
            lastModel = model;

            renderKpis(model);
            renderEmptyState(model.total === 0);

            /* الرسوم لا تُرسم إلا والتبويب ظاهر، وإلا صارت أبعادها صفراً */
            if (isVisible()) {
                renderCharts(model);
                needsDraw = false;
            } else {
                needsDraw = true;
            }
            stale = false;

            if (options.notify) {
                App.Notify.toast('تم تحديث الإحصائيات — ' + model.total + ' سجل في النطاق المحدد', 'success');
            }
        }

        /* ============================================================
           التصدير إلى Excel (أرقام مجمّعة لا صور)
           ============================================================ */

        function exportExcel() {
            if (!App.Exporters || typeof App.Exporters.excel !== 'function') {
                warn('وحدة التصدير غير متاحة');
                return;
            }
            if (!lastModel) {
                renderAll();
                if (!lastModel) {
                    warn('لا توجد بيانات للتصدير');
                    return;
                }
            }

            const m = lastModel;
            const title = 'الإحصائيات — ' + D.formatDMYRange(m.range.from, m.range.to) +
                ' — القسم: ' + (m.filters.dept || 'الكل') +
                ' — النوع: ' + (m.filters.type || 'الكل');

            const infoSheet = {
                name: 'معلومات التصدير',
                widths: [26, 44],
                rows: [
                    ['البند', 'القيمة'],
                    ['النطاق الزمني', D.formatDMYRange(m.range.from, m.range.to)],
                    ['القسم', m.filters.dept || 'جميع الأقسام'],
                    ['نوع الإجازة', m.filters.type || 'جميع الأنواع'],
                    ['إجمالي السجلات', m.total],
                    ['مجازون حالياً', m.current],
                    ['أعلى قسم', m.topDept || '—'],
                    ['مجموع الأيام المخصومة', m.days],
                    ['تاريخ التصدير', D.formatDMY(App.Dates.todayISO())]
                ]
            };

            const deptSheet = {
                name: 'حسب القسم',
                widths: [8, 34, 14],
                rows: [['ت', 'القسم', 'عدد الإجازات']]
                    .concat(m.byDept.map((d, i) => [i + 1, d.label, d.value]))
                    .concat(m.byDept.length ? [['', 'المجموع (أعلى ' + m.byDept.length + ' أقسام)', m.byDept.reduce((s, d) => s + d.value, 0)]] : [])
            };

            const typeSheet = {
                name: 'حسب نوع الإجازة',
                widths: [8, 32, 14, 12, 12],
                rows: [['ت', 'نوع الإجازة', 'عدد الإجازات', 'النسبة %', 'اللون']]
                    .concat(m.byType.map((t, i) => [i + 1, t.label, t.value, t.percent, t.color]))
                    .concat(m.byType.length ? [['', 'المجموع', m.total, 100, '']] : [])
            };

            const trendSheet = {
                name: 'الاتجاه الشهري',
                widths: [8, 20, 14],
                rows: [['ت', 'الشهر', 'عدد الإجازات']]
                    .concat(m.trend.map((t, i) => [i + 1, t.label, t.value]))
                    .concat(m.trend.length ? [['', 'المجموع', m.trend.reduce((s, t) => s + t.value, 0)]] : [])
            };

            const empSheet = {
                name: 'أكثر الموظفين إجازات',
                widths: [8, 34, 14],
                rows: [['ت', 'اسم الموظف', 'عدد الإجازات']]
                    .concat(m.topEmployees.map((e, i) => [i + 1, e.label, e.value]))
            };

            const fileName = 'إحصائيات_الإجازات_' + m.range.from + '_' + m.range.to +
                '_' + App.Dates.todayISO() + '.xlsx';

            const ok = App.Exporters.excel(
                [infoSheet, deptSheet, typeSheet, trendSheet, empSheet],
                fileName
            );

            if (ok) {
                App.Notify.toast('تم تصدير الأرقام المجمّعة: ' + title, 'success');
            } else {
                App.Notify.toast('تعذّر إنشاء ملف Excel — تأكد من تحميل مكتبة xlsx المحلية', 'error');
            }
        }

        /* ============================================================
           الإعداد والتدمير
           ============================================================ */

        function wire() {
            if (bound) return;

            /* الفترة السريعة تملأ الحقلين ثم تُحدَّث النتائج */
            bind(elQuick, 'change', () => {
                if (applyQuickRange(elQuick.value)) {
                    renderAll();
                } else {
                    elQuick.value = '';
                }
            });

            /* تغيير يدوي للتواريخ: نُلغي الفترة السريعة لتجنّب الالتباس */
            const onDateManual = () => {
                if (elQuick && elQuick.value) elQuick.value = '';
                renderAll();
            };
            bind(elFrom, 'change', onDateManual);
            bind(elTo, 'change', onDateManual);

            /* الفلاتر تُعيد الحساب فوراً */
            bind(elDept, 'change', () => renderAll());
            bind(elType, 'change', () => renderAll());

            bind(elBtnRun, 'click', () => {
                if (elQuick && elQuick.value) applyQuickRange(elQuick.value);
                renderAll({ notify: true });
            });

            bind(elBtnExcel, 'click', exportExcel);

            /* عند تغيّر حجم النافذة نعيد رسم المخططات إن كان التبويب ظاهراً */
            bind(window, 'resize', () => {
                if (isVisible() && !needsDraw) {
                    try {
                        Object.keys(charts).forEach((k) => { if (charts[k]) charts[k].resize(); });
                    } catch (e) { /* تجاهل */ }
                }
            });

            /* أي تغيير في المخزن يجعل اللوحة قديمة — بلا إعادة حساب فورية */
            offStore = App.Store.on('change', () => {
                stale = true;
                needsDraw = true;
                /* إن كان التبويب ظاهراً نحدّث فوراً، وإلا ننتظر refresh() */
                if (isVisible()) renderAll();
            });

            bound = true;
        }

        const api = {

            /** تهيئة الوحدة — آمنة للاستدعاء أكثر من مرة */
            init() {
                if (inited) {
                    /* إعادة تهيئة ناعمة: نتأكد من المراجع ونحدّث */
                    api.refresh();
                    return api;
                }

                view = $('view-analytics');
                elFrom = $('anFrom');
                elTo = $('anTo');
                elQuick = $('anQuick');
                elDept = $('anDept');
                elType = $('anType');
                elBtnRun = $('btnRunAnalytics');
                elBtnExcel = $('btnAnalyticsExcel');

                kpiTotal = $('kpiTotal');
                kpiCurrent = $('kpiCurrent');
                kpiTopDept = $('kpiTopDept');
                kpiDays = $('kpiDays');

                inited = true;

                if (!elementsOk()) {
                    warn('عناصر تبويب الإحصائيات غير مكتملة في الصفحة');
                    return api;
                }

                /* النطاق الافتراضي: من بداية السنة الحالية حتى اليوم */
                const today = D.todayISO();
                if (!D.parseISO(D.formatISO(elFrom.value))) {
                    elFrom.value = D.yearRange(D.yearOf(today)).from;
                }
                if (!D.parseISO(D.formatISO(elTo.value))) {
                    elTo.value = today;
                }

                wire();
                renderAll();

                /* إن بدأ التبويب مخفياً تبقى الرسوم بانتظار refresh() */
                return api;
            },

            /**
             * يُستدعى عند فتح تبويب الإحصائيات أو عند تغيّر البيانات.
             * يعيد الحساب والرسم إن لزم فقط.
             */
            refresh() {
                if (!inited) return api.init();
                if (!elementsOk()) return api;

                /* renderAll تتكفّل بمنع الرسم أثناء إخفاء التبويب */
                if (stale || needsDraw) renderAll();
                return api;
            },

            /** إيقاف الوحدة: تدمير الرسوم وفصل المستمعين */
            destroy() {
                destroyCharts();
                unbindAll();
                if (typeof offStore === 'function') {
                    try { offStore(); } catch (e) { /* تجاهل */ }
                }
                offStore = null;
                if (emptyBox && emptyBox.parentNode) emptyBox.parentNode.removeChild(emptyBox);
                emptyBox = null;
                lastModel = null;
                stale = true;
                needsDraw = true;
                bound = false;
                inited = false;
                return api;
            }
        };

        return api;
    })();
})();
