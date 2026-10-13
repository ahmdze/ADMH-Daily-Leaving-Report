/* ============================================================
   وحدة عرض سجل التدقيق
   ============================================================ */
window.App = window.App || {};

App.AuditView = (function () {
    'use strict';

    const esc = App.Security.esc;
    const $ = (id) => document.getElementById(id);
    let inited = false;

    function render() {
        const host = $('auditList');
        if (!host) return;

        const filter = {
            keyword: App.Security.clean(($('auditSearch') || {}).value || ''),
            action: ($('auditActionFilter') || {}).value || '',
            from: ($('auditFrom') || {}).value || '',
            to: ($('auditTo') || {}).value || ''
        };

        const list = App.Audit.list(filter);
        const countEl = $('auditCount');
        if (countEl) countEl.textContent = App.num(list.length) + ' عملية';

        if (!list.length) {
            host.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-slate-400 font-bold">لا توجد عمليات مطابقة</td></tr>';
            return;
        }

        /* نعرض آخر 300 عملية فقط للأداء */
        const shown = list.slice(0, 300);

        host.innerHTML = shown.map(e => {
            const changes = (e.action === 'update' && e.before && e.after)
                ? '<span class="badge bg-sky-100 text-sky-800 border-sky-200 mr-1">تغيير قيم</span>' : '';
            return `
                <tr class="hover:bg-slate-50 text-slate-800">
                    <td class="py-1.5 px-2 border border-slate-200 whitespace-nowrap">${esc(App.Audit.formatAt(e.at))}</td>
                    <td class="py-1.5 px-2 border border-slate-200">
                        <span class="status-chip ${App.Audit.actionClass(e.action)}">${esc(App.Audit.label(e.action))}</span>
                    </td>
                    <td class="py-1.5 px-2 border border-slate-200 text-right">
                        ${changes}${esc(e.label || '-')}
                        ${e.note ? '<div class="text-[10px] text-slate-500 mt-0.5">' + esc(e.note) + '</div>' : ''}
                    </td>
                    <td class="py-1.5 px-2 border border-slate-200 whitespace-nowrap">${esc(e.by || '-')}</td>
                </tr>`;
        }).join('') + (list.length > shown.length
            ? `<tr><td colspan="4" class="py-2 text-center text-[10px] text-slate-400">يُعرض آخر ${shown.length} عملية من ${App.num(list.length)}. استخدم البحث لتضييق النتائج.</td></tr>`
            : '');
    }

    function init() {
        if (inited) { render(); return; }
        inited = true;

        const bind = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

        bind('auditSearch', 'input', App.debounce(render, 300));
        bind('auditActionFilter', 'change', render);
        bind('auditFrom', 'change', render);
        bind('auditTo', 'change', render);

        bind('btnClearAudit', 'click', async () => {
            const ok = await App.Notify.confirm(
                'تفريغ سجل التدقيق بالكامل؟ لا يمكن التراجع عن هذه العملية.',
                { title: 'تفريغ السجل', danger: true, confirmText: 'تفريغ', type: 'warning' }
            );
            if (!ok) return;
            App.Audit.clearAll();
            App.Notify.toast('تم تفريغ سجل التدقيق', 'success');
            render();
        });

        render();
    }

    return { init: init, refresh: render, render: render };
})();
