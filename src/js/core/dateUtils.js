/* ============================================================
   محرّك التواريخ واحتساب أيام الإجازة
   ملاحظة مهمة: لا نستخدم toISOString() لأنها تحوّل للتوقيت العالمي
   وتُزيح التاريخ حسب فرق التوقيت. كل الحسابات هنا محلية بحتة.
   ============================================================ */
window.App = window.App || {};

App.Dates = (function () {
    'use strict';

    var C = App.Constants;

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    /** تاريخ اليوم بصيغة YYYY-MM-DD بالتوقيت المحلي */
    function todayISO() {
        return toISO(new Date());
    }

    /** يحوّل كائن Date إلى YYYY-MM-DD محلياً دون إزاحة */
    function toISO(date) {
        if (!date || isNaN(date.getTime())) return '';
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    /** يحوّل YYYY-MM-DD إلى Date عند منتصف الليل المحلي */
    function parseISO(iso) {
        if (!iso || typeof iso !== 'string') return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.slice(0, 10));
        if (!m) return null;
        var d = new Date(+m[1], +m[2] - 1, +m[3]);
        return isNaN(d.getTime()) ? null : d;
    }

    /** إضافة أيام إلى تاريخ */
    function addDays(iso, n) {
        var d = parseISO(iso);
        if (!d) return '';
        d.setDate(d.getDate() + (+n || 0));
        return toISO(d);
    }

    /** فرق الأيام التقويمية بين تاريخين (غير شامل) */
    function diffDays(fromIso, toIso) {
        var a = parseISO(fromIso), b = parseISO(toIso);
        if (!a || !b) return 0;
        return Math.round((b - a) / 86400000);
    }

    /** عدد الأيام التقويمية شاملاً الطرفين */
    function inclusiveDays(fromIso, toIso) {
        var d = diffDays(fromIso, toIso);
        return d < 0 ? 0 : d + 1;
    }

    /** مصفوفة بكل الأيام بين تاريخين شاملاً الطرفين */
    function eachDay(fromIso, toIso) {
        var out = [];
        var a = parseISO(fromIso), b = parseISO(toIso);
        if (!a || !b || b < a) return out;
        var cur = new Date(a.getTime());
        var guard = 0;
        while (cur <= b && guard < 4000) {
            out.push(toISO(cur));
            cur.setDate(cur.getDate() + 1);
            guard++;
        }
        return out;
    }

    /** يوم الأسبوع: 0=الأحد ... 5=الجمعة 6=السبت */
    function dayOfWeek(iso) {
        var d = parseISO(iso);
        return d ? d.getDay() : -1;
    }

    function dayName(iso) {
        var i = dayOfWeek(iso);
        return i < 0 ? '' : C.WEEKDAY_NAMES[i];
    }

    function monthName(monthIndex1) {
        return C.MONTH_NAMES[monthIndex1 - 1] || '';
    }

    function isWeekend(iso, weekendDays) {
        var i = dayOfWeek(iso);
        return (weekendDays || C.WEEKEND_DAYS).indexOf(i) !== -1;
    }

    /* ---------------- التنسيق للعرض ---------------- */

    /** 2026-10-13 */
    function formatISO(iso) { return iso ? String(iso).slice(0, 10) : ''; }

    /** 22/10/2026 — الصيغة القصيرة المعتمدة في الطباعة والتصدير */
    function formatDMY(iso) {
        var d = parseISO(iso);
        if (!d) return '';
        return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    /** 22/10/2026 يوم الثلاثاء — الصيغة المعتمدة تحت عنوان الموقف */
    function formatDMYWithDay(iso) {
        var d = parseISO(iso);
        if (!d) return '';
        return formatDMY(iso) + ' يوم ' + dayName(iso);
    }

    /** من 22/10/2026 إلى 25/10/2026 */
    function formatDMYRange(fromIso, toIso) {
        if (!fromIso) return '';
        if (!toIso || fromIso === toIso) return formatDMY(fromIso);
        return 'من ' + formatDMY(fromIso) + ' إلى ' + formatDMY(toIso);
    }

    /** 13 تشرين الأول 2026 */
    function formatFull(iso) {
        var d = parseISO(iso);
        if (!d) return '';
        return d.getDate() + ' ' + monthName(d.getMonth() + 1) + ' ' + d.getFullYear();
    }

    /** الثلاثاء 13 تشرين الأول 2026 */
    function formatWithDay(iso) {
        var d = parseISO(iso);
        if (!d) return '';
        return dayName(iso) + ' ' + d.getDate() + ' ' + monthName(d.getMonth() + 1) + ' ' + d.getFullYear();
    }

    /** آذار 2026 */
    function formatMonth(year, month) {
        return monthName(month) + ' ' + year;
    }

    function isoMonth(iso) { return iso ? String(iso).slice(0, 7) : ''; }

    function monthOf(iso) { return parseInt(String(iso).slice(5, 7), 10); }
    function yearOf(iso) { return parseInt(String(iso).slice(0, 4), 10); }

    /** نطاق شهر كامل */
    function monthRange(year, month) {
        var from = year + '-' + pad2(month) + '-01';
        var last = new Date(year, month, 0).getDate();
        return { from: from, to: year + '-' + pad2(month) + '-' + pad2(last) };
    }

    /** نطاق سنة كاملة */
    function yearRange(year) {
        return { from: year + '-01-01', to: year + '-12-31' };
    }

    /* ---------------- فهرس العطل الرسمية ---------------- */

    /**
     * يبني فهرساً سريعاً للعطل.
     * العطلة المتكررة (recurring) تُطابق بحسب الشهر واليوم في أي سنة.
     */
    function buildHolidayIndex(holidays) {
        var exact = {};
        var recurring = {};
        (holidays || []).forEach(function (h) {
            if (!h || !h.date) return;
            var iso = String(h.date).slice(0, 10);
            if (iso.length < 10) return;
            if (h.recurring) recurring[iso.slice(5)] = h;
            else exact[iso] = h;
        });
        return {
            exact: exact,
            recurring: recurring,
            lookup: function (iso) {
                return exact[iso] || recurring[String(iso).slice(5)] || null;
            },
            has: function (iso) {
                return !!(exact[iso] || recurring[String(iso).slice(5)]);
            }
        };
    }

    /* ============================================================
       التحليل الكامل لمدة الإجازة
       ============================================================
       opt = {
         fromDate, toDate,
         isHourly, hoursCount,
         deductsBalance,          // هل نوع الإجازة يخصم من الرصيد
         holidayMode,             // 'inside' | 'excluded'
         countWeekend,            // هل تُحسب الجمعة والسبت
         holidays                 // مصفوفة العطل الرسمية
       }
       ------------------------------------------------------------
       inside   : العطلة الرسمية من ضمن الإجازة ولا تؤثر على عدد الأيام
       excluded : العطلة الرسمية تُستثنى فيُنشأ يوم تعويضي على الموظف
       ============================================================ */
    function analyze(opt) {
        opt = opt || {};
        var from = formatISO(opt.fromDate);
        var to = formatISO(opt.toDate) || from;
        var isHourly = !!opt.isHourly;
        var holidayMode = opt.holidayMode === 'excluded' ? 'excluded' : 'inside';
        var countWeekend = opt.countWeekend !== false;

        var result = {
            isHourly: isHourly,
            fromDate: from,
            toDate: to,
            calendarDays: 0,
            deductedDays: 0,
            workingDays: 0,
            weekendDays: 0,
            hoursCount: 0,
            holidays: [],            /* كل العطل الواقعة داخل المدة */
            excludedHolidays: [],    /* العطل التي استُثنيت فعلاً */
            compensatoryDays: 0,
            days: [],
            valid: false,
            error: ''
        };

        if (isHourly) {
            result.hoursCount = App.Security.toInt(opt.hoursCount, 0, 0, 24);
            result.calendarDays = from ? 1 : 0;
            result.deductedDays = 0;
            result.valid = !!from && result.hoursCount > 0;
            if (!result.valid) result.error = 'يرجى تحديد التاريخ وعدد الساعات';
            return result;
        }

        if (!from || !to) {
            result.error = 'يرجى تحديد تاريخ البداية والنهاية';
            return result;
        }
        if (diffDays(from, to) < 0) {
            result.error = 'تاريخ النهاية قبل تاريخ البداية';
            return result;
        }

        var index = buildHolidayIndex(opt.holidays);
        var all = eachDay(from, to);

        result.calendarDays = all.length;

        all.forEach(function (iso) {
            var dow = dayOfWeek(iso);
            var weekend = (C.WEEKEND_DAYS.indexOf(dow) !== -1);
            var hol = index.lookup(iso);
            var counted = true;
            var reason = '';

            /* الأولوية لراية العطلة نفسها، وإلا فالسياسة العامة */
            var isExcluded = false;
            if (hol) {
                if (hol.excluded === true) isExcluded = true;
                else if (hol.excluded === false) isExcluded = false;
                else isExcluded = (holidayMode === 'excluded');
            }

            if (hol && isExcluded) {
                counted = false;
                reason = 'عطلة رسمية مستثناة';
                var entry = { date: iso, name: hol.name || 'عطلة رسمية', recurring: !!hol.recurring };
                result.holidays.push(entry);
                result.excludedHolidays.push(entry);
            } else if (hol) {
                reason = 'عطلة رسمية (من ضمن الإجازة)';
                result.holidays.push({ date: iso, name: hol.name || 'عطلة رسمية', recurring: !!hol.recurring });
            } else if (weekend && !countWeekend) {
                counted = false;
                reason = 'راحة أسبوعية';
            }

            if (weekend) result.weekendDays++;
            if (!weekend && !hol) result.workingDays++;
            if (counted) result.deductedDays++;

            result.days.push({
                date: iso,
                dayName: C.WEEKDAY_NAMES[dow],
                isWeekend: weekend,
                isHoliday: !!hol,
                holidayName: hol ? (hol.name || 'عطلة رسمية') : '',
                counted: counted,
                reason: reason
            });
        });

        /* اليوم التعويضي يُستحق فقط عن عطلة رسمية مستثناة،
           أما الراحة الأسبوعية فلا تُنشئ ديناً على الموظف. */
        result.compensatoryDays = result.excludedHolidays.length;

        result.deductedDays = isHourly ? 0 : (opt.deductsBalance === false ? 0 : result.deductedDays);
        result.balanceAffected = opt.deductsBalance !== false && !isHourly;

        result.valid = true;
        return result;
    }

    /** وصف نصي مختصر لمدة الإجازة — للجداول والتقارير */
    function describeDuration(record) {
        if (!record) return '';
        if (record.leaveTypeIsHourly || (record.hoursCount && !record.daysCount)) {
            return (record.hoursCount || 0) + ' ساعة';
        }
        return (record.deductedDays || record.daysCount || 0) + ' يوم';
    }

    /** ملخص عربي لتفصيل الأيام — لسطر الملاحظة الآلي */
    function summarize(a) {
        if (!a || !a.valid) return '';
        if (a.isHourly) return a.hoursCount + ' ساعة';
        var parts = [];
        parts.push('إجمالي تقويمي ' + a.calendarDays + ' يوم');
        if (a.excludedHolidays.length) {
            parts.push('بعد استثناء ' + a.excludedHolidays.length + ' عطلة رسمية: ' +
                a.deductedDays + ' يوم');
            if (a.compensatoryDays > 0) {
                parts.push('على الموظف ' + a.compensatoryDays + ' يوم تعويضي');
            }
        }
        return parts.join(' — ');
    }

    return {
        pad2: pad2,
        todayISO: todayISO,
        toISO: toISO,
        parseISO: parseISO,
        addDays: addDays,
        diffDays: diffDays,
        inclusiveDays: inclusiveDays,
        eachDay: eachDay,
        dayOfWeek: dayOfWeek,
        dayName: dayName,
        monthName: monthName,
        isWeekend: isWeekend,
        formatISO: formatISO,
        formatDMY: formatDMY,
        formatDMYWithDay: formatDMYWithDay,
        formatDMYRange: formatDMYRange,
        formatFull: formatFull,
        formatWithDay: formatWithDay,
        formatMonth: formatMonth,
        isoMonth: isoMonth,
        monthOf: monthOf,
        yearOf: yearOf,
        monthRange: monthRange,
        yearRange: yearRange,
        buildHolidayIndex: buildHolidayIndex,
        analyze: analyze,
        describeDuration: describeDuration,
        summarize: summarize
    };
})();
