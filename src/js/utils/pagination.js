/* ============================================================
   الترقيم (Pagination) والفرز
   ============================================================ */
window.App = window.App || {};

App.Pagination = (function () {
    'use strict';

    const esc = App.Security.esc;

    /**
     * ينشئ حالة ترقيم.
     * pageSize = 0 يعني عرض الكل.
     */
    function create(opts) {
        return {
            page: 1,
            pageSize: (opts && opts.pageSize) || 50,
            total: 0,
            sortKey: (opts && opts.sortKey) || '',
            sortDir: (opts && opts.sortDir) || 'asc'
        };
    }

    function pageCount(st) {
        if (!st.pageSize) return 1;
        return Math.max(1, Math.ceil(st.total / st.pageSize));
    }

    function clamp(st) {
        const pc = pageCount(st);
        if (st.page > pc) st.page = pc;
        if (st.page < 1) st.page = 1;
        return st;
    }

    /** يقتطع الصفوف الظاهرة حسب الصفحة الحالية */
    function slice(st, rows) {
        st.total = rows.length;
        clamp(st);
        if (!st.pageSize) return rows;
        const start = (st.page - 1) * st.pageSize;
        return rows.slice(start, start + st.pageSize);
    }

    function rangeText(st) {
        if (!st.total) return '0 من 0';
        if (!st.pageSize) return '1 - ' + st.total + ' من ' + st.total;
        const start = (st.page - 1) * st.pageSize + 1;
        const end = Math.min(st.total, st.page * st.pageSize);
        return start + ' - ' + end + ' من ' + st.total;
    }

    /**
     * فرز مصفوفة حسب مفتاح مع دعم القيم النصية والتاريخية والرقمية.
     * المفتاح قد يكون دالة أو اسم حقل.
     */
    function sortRows(rows, key, dir) {
        if (!key) return rows;
        const sign = dir === 'desc' ? -1 : 1;
        const getter = typeof key === 'function' ? key : (r) => r[key];

        return rows.slice().sort((a, b) => {
            let va = getter(a);
            let vb = getter(b);
            if (va === undefined || va === null) va = '';
            if (vb === undefined || vb === null) vb = '';

            /* تواريخ ISO تُقارن نصياً بشكل صحيح */
            const na = parseFloat(va);
            const nb = parseFloat(vb);
            const bothNumeric = !isNaN(na) && !isNaN(nb) &&
                String(va).trim() !== '' && String(vb).trim() !== '' &&
                /^-?[\d.]+$/.test(String(va).trim()) && /^-?[\d.]+$/.test(String(vb).trim());
            if (bothNumeric) return (na - nb) * sign;

            const sa = String(va);
            const sb = String(vb);
            return sa.localeCompare(sb, 'ar') * sign;
        });
    }

    /** تبديل اتجاه الفرز على نفس المفتاح */
    function toggleSort(st, key) {
        if (st.sortKey === key) {
            st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            st.sortKey = key;
            st.sortDir = 'asc';
        }
        return st;
    }

    /** تحديث أيقونات الفرز في رؤوس الجدول */
    function paintSortHeaders(tableEl, st) {
        if (!tableEl) return;
        tableEl.querySelectorAll('th[data-sort]').forEach(th => {
            const icon = th.querySelector('i');
            if (!icon) return;
            const active = th.dataset.sort === st.sortKey;
            /* no-print تُبقي أيقونة الفرز خارج الطباعة والتصدير */
            icon.className = 'no-print fa-solid ' + (active
                ? (st.sortDir === 'asc' ? 'fa-sort-up' : 'fa-sort-down')
                : 'fa-sort') + ' text-[9px] ' + (active ? 'opacity-100' : 'opacity-60');
        });
    }

    /** رسم أزرار أرقام الصفحات */
    function renderPager(container, st, onGo) {
        if (!container) return;
        container.innerHTML = '';
        const pc = pageCount(st);
        if (pc <= 1) return;

        const add = (label, page, disabled, active) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'px-2.5 py-1.5 rounded-lg border text-xs font-bold transition ' +
                (active
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-100');
            if (disabled) b.disabled = true;
            b.textContent = label;
            b.addEventListener('click', () => { if (!disabled && !active) onGo(page); });
            container.appendChild(b);
        };

        const cur = st.page;
        const windowSize = 2;
        let from = Math.max(1, cur - windowSize);
        let to = Math.min(pc, cur + windowSize);

        if (from > 1) {
            add('1', 1, false, cur === 1);
            if (from > 2) {
                const dots = document.createElement('span');
                dots.className = 'px-1 text-slate-400 text-xs';
                dots.textContent = '…';
                container.appendChild(dots);
            }
        }
        for (let i = from; i <= to; i++) add(String(i), i, false, i === cur);
        if (to < pc) {
            if (to < pc - 1) {
                const dots = document.createElement('span');
                dots.className = 'px-1 text-slate-400 text-xs';
                dots.textContent = '…';
                container.appendChild(dots);
            }
            add(String(pc), pc, false, cur === pc);
        }
    }

    return {
        create: create,
        pageCount: pageCount,
        clamp: clamp,
        slice: slice,
        rangeText: rangeText,
        sortRows: sortRows,
        toggleSort: toggleSort,
        paintSortHeaders: paintSortHeaders,
        renderPager: renderPager
    };
})();
