/* ============================================================
   طبقة الأمان: تهريب النصوص قبل عرضها + التحقق من المدخلات
   القاعدة: لا يُدرج أي إدخال مستخدم في HTML دون المرور بـ esc()
   ============================================================ */
window.App = window.App || {};

App.Security = (function () {
    'use strict';

    /**
     * تهريب النص لعرضه كـ HTML — يمنع XSS.
     * تُستخدم مع كل نص مصدره المستخدم داخل قوالب HTML.
     */
    function esc(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /** تهريب قيمة تُوضع داخل خاصية (attribute) */
    function escAttr(value) {
        return esc(value).replace(/`/g, '&#096;');
    }

    /** تنظيف الإدخال النصي: إزالة الفراغات الزائدة وتوحيد المسافات */
    function clean(value, maxLength) {
        var s = (value === null || value === undefined) ? '' : String(value);
        s = s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
        if (maxLength && s.length > maxLength) s = s.slice(0, maxLength);
        return s;
    }

    /** التحقق من صيغة تاريخ YYYY-MM-DD والتحقق من صحته فعلياً */
    function isIsoDate(value) {
        if (typeof value !== 'string') return false;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!m) return false;
        var y = +m[1], mo = +m[2], d = +m[3];
        if (mo < 1 || mo > 12) return false;
        if (d < 1 || d > 31) return false;
        var dt = new Date(y, mo - 1, d);
        return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
    }

    /** التحقق من صيغة وقت HH:MM */
    function isTime(value) {
        if (typeof value !== 'string') return false;
        return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
    }

    /** رقم آمن داخل مدى محدد */
    function toInt(value, fallback, min, max) {
        var n = parseInt(value, 10);
        if (isNaN(n)) n = (fallback === undefined ? 0 : fallback);
        if (min !== undefined && n < min) n = min;
        if (max !== undefined && n > max) n = max;
        return n;
    }

    /** نص آمن للاستخدام في أسماء الملفات */
    function safeFileName(value, fallback) {
        var s = clean(value) || (fallback || 'file');
        s = s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
        return s.slice(0, 80) || 'file';
    }

    /** يحوّل نصاً إلى عنصر DOM بأمان (بديل عن innerHTML) */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    /** تمييز كلمة البحث داخل نص — مع تهريب آمن للمحتوى */
    function highlight(text, keyword) {
        var safe = esc(text);
        if (!keyword) return safe;
        var k = esc(keyword);
        if (!k) return safe;
        try {
            var re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
            return safe.replace(re, '<mark class="bg-amber-200 rounded px-0.5">$1</mark>');
        } catch (e) {
            return safe;
        }
    }

    return {
        esc: esc,
        escAttr: escAttr,
        clean: clean,
        isIsoDate: isIsoDate,
        isTime: isTime,
        toInt: toInt,
        safeFileName: safeFileName,
        el: el,
        highlight: highlight
    };
})();

/* ============================================================
   أدوات عامة مشتركة
   ============================================================ */

/** تأخير تنفيذ دالة حتى يتوقف المستخدم عن الكتابة */
App.debounce = function (fn, delay) {
    var timer = null;
    return function () {
        var args = arguments, ctx = this;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(ctx, args); }, delay || 300);
    };
};

/** تنفيذ دالة مرة واحدة على الأكثر كل فترة */
App.throttle = function (fn, wait) {
    var last = 0, timer = null;
    return function () {
        var args = arguments, ctx = this, now = Date.now();
        var remaining = wait - (now - last);
        if (remaining <= 0) {
            last = now;
            fn.apply(ctx, args);
        } else if (!timer) {
            timer = setTimeout(function () {
                last = Date.now();
                timer = null;
                fn.apply(ctx, args);
            }, remaining);
        }
    };
};

/** تنسيق رقم بفواصل الآلاف مع أرقام لاتينية */
App.num = function (n) {
    var v = Number(n) || 0;
    return v.toLocaleString('en-US');
};

