/* ============================================================
   نقطة انطلاق النظام — التهيئة، التبويبات، حالة التخزين، الحمايات
   ============================================================ */
window.App = window.App || {};

App.App = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;
    const $ = (id) => document.getElementById(id);

    let currentTab = 'dashboard';
    let booted = false;

    /* ---------------- التبويبات ---------------- */

    function showTab(tabId) {
        document.querySelectorAll('.tab-view').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

        const view = $('view-' + tabId);
        if (view) view.classList.remove('hidden');

        const btn = document.querySelector('.tab-btn[data-app-tab="' + tabId + '"]');
        if (btn) btn.classList.add('active');

        currentTab = tabId;

        /* تحديث محتوى التبويب عند ظهوره */
        try {
            if (tabId === 'dashboard' && App.Dashboard) App.Dashboard.refresh();
            else if (tabId === 'entry' && App.Entry) App.Entry.refresh();
            else if (tabId === 'reports' && App.Reports && App.Reports.refresh) App.Reports.refresh();
            else if (tabId === 'analytics' && App.Analytics && App.Analytics.refresh) App.Analytics.refresh();
            else if (tabId === 'settings' && App.Settings) App.Settings.refresh();
        } catch (e) {
            console.error('[App] فشل تحديث التبويب', tabId, e);
        }

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /** تبديل التبويب مع حماية البيانات غير المحفوظة */
    async function goTab(tabId) {
        if (tabId === currentTab) return;

        if (currentTab === 'entry' && App.Entry && App.Entry.isDirty()) {
            const choice = await App.Notify.open({
                title: 'تغييرات غير محفوظة',
                message: 'لديك بيانات في نموذج الإدخال لم تُحفظ بعد. ماذا تريد أن تفعل؟',
                type: 'warning',
                actions: [
                    { label: 'متابعة التحرير', value: 'stay', variant: 'ghost' },
                    { label: 'مغادرة بدون حفظ', value: 'leave', variant: 'danger' },
                    { label: 'حفظ ثم مغادرة', value: 'save', variant: 'primary', icon: 'fa-check' }
                ]
            });

            if (choice === 'stay' || choice === null) return;
            if (choice === 'save') {
                await App.Entry.save(null);
                if (App.Entry.isDirty()) return;   /* فشل الحفظ — نبقى في النموذج */
                showTab(tabId);
                return;
            }
            App.Entry.clearDirty();
        }

        showTab(tabId);
    }

    /* ---------------- شريط حالة التخزين ---------------- */

    function setBanner(kind, textHtml, actionsHtml) {
        const wrap = $('storageBanner');
        const inner = $('storageBannerInner');
        const text = $('storageBannerText');
        const actions = $('storageBannerActions');
        if (!wrap || !inner || !text || !actions) return;

        if (!kind) {
            wrap.classList.add('hidden');
            return;
        }

        const styles = {
            danger: 'bg-rose-50 border border-rose-200 text-rose-900',
            warning: 'bg-amber-50 border border-amber-200 text-amber-900',
            info: 'bg-sky-50 border border-sky-200 text-sky-900',
            success: 'bg-emerald-50 border border-emerald-200 text-emerald-900'
        };

        inner.className = 'rounded-xl px-4 py-2.5 text-xs font-semibold flex flex-wrap items-center gap-2 justify-between ' +
            (styles[kind] || styles.info);
        text.innerHTML = textHtml;
        actions.innerHTML = actionsHtml || '';
        wrap.classList.remove('hidden');
    }

    function updateBanner() {
        const fsaSupported = App.FSA.supported();
        const connected = Store.isConnected();
        const pending = Store.hasPendingFolder();

        if (connected) {
            setBanner(null);
            return;
        }

        if (pending) {
            setBanner('warning',
                '<span><i class="fa-solid fa-link-slash"></i> مجلد البيانات «' + esc(Store.pendingFolderName() || '') +
                '» محفوظ لكن يحتاج إعادة تفعيل الإذن للكتابة فيه.</span>',
                '<button type="button" id="bannerReconnect" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold">إعادة تفعيل الاتصال</button>');
            const b = $('bannerReconnect');
            if (b) b.addEventListener('click', async () => {
                try {
                    const name = await Store.reconnectFolder();
                    App.Notify.toast('تم إعادة الحفظ في: ' + name, 'success');
                    updateBanner();
                } catch (e) {
                    App.Notify.alert('تعذّر إعادة الاتصال: ' + (e && e.message ? e.message : 'خطأ'), 'error');
                }
            });
            return;
        }

        if (fsaSupported) {
            const n = Store.get.leaves().length;
            setBanner('warning',
                '<span><i class="fa-solid fa-triangle-exclamation"></i> البيانات محفوظة داخل المتصفح فقط (' +
                App.num(n) + ' سجل) — لم يتم ربط مجلد على القرص بعد. أي تنظيف لبيانات المتصفح قد يحذفها.</span>',
                '<button type="button" id="bannerConnect" class="bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 rounded-lg font-bold">ربط مجلد البيانات</button>' +
                '<button type="button" id="bannerExport" class="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded-lg font-bold">تصدير نسخة</button>');
            const bc = $('bannerConnect');
            if (bc) bc.addEventListener('click', async () => {
                App.Settings.showSubTab('storage');
                showTab('settings');
                try {
                    await Store.connectFolder();
                    App.Notify.toast('تم ربط المجلد', 'success');
                    App.Settings.refresh();
                    updateBanner();
                } catch (e) {
                    if (e && e.name === 'AbortError') return;
                    App.Notify.alert('تعذّر ربط المجلد: ' + (e && e.message ? e.message : 'خطأ'), 'error');
                }
            });
            const be = $('bannerExport');
            if (be) be.addEventListener('click', () => {
                Store.exportToFile();
                App.Notify.toast('تم تصدير نسخة احتياطية', 'success');
            });
            return;
        }

        /* متصفح لا يدعم الحفظ في مجلد (Firefox) */
        setBanner('info',
            '<span><i class="fa-solid fa-circle-info"></i> هذا المتصفح لا يدعم الحفظ في مجلد على القرص، لذلك تُحفظ البيانات داخل المتصفح. ' +
            'استخدم «تصدير نسخة احتياطية» دورياً، أو افتح النظام بـ Chrome أو Edge للحفظ التلقائي.</span>',
            '<button type="button" id="bannerExport2" class="bg-white border border-slate-300 text-slate-700 px-3 py-1.5 rounded-lg font-bold">تصدير نسخة الآن</button>');
        const be2 = $('bannerExport2');
        if (be2) be2.addEventListener('click', () => {
            Store.exportToFile();
            App.Notify.toast('تم تصدير نسخة احتياطية', 'success');
        });
    }

    /* ---------------- تحديث شامل ---------------- */

    function safe(fn, label) {
        try { fn(); } catch (e) { console.error('[App] خطأ في ' + label, e); }
    }

    /** يطبع العرض الحالي عبر محرّك صفحات A4 المولّد.
     *  يُستدعى من زر الطباعة ومن اختصار Ctrl+P معاً حتى لا تختلف النتيجة. */
    function printCurrentView() {
        if (currentTab === 'reports') {
            const btn = $('btnReportPrint');
            if (btn) { btn.click(); return true; }
        }
        if (currentTab === 'analytics' || currentTab === 'settings') {
            App.Notify.toast('الطباعة متاحة من تبويبَي «الموقف اليومي» و«التقارير»', 'info');
            return false;
        }
        if (App.Dashboard && App.Dashboard.printNow) {
            App.Dashboard.printNow();
            return true;
        }
        return false;
    }

    function refreshAll() {
        safe(() => App.Settings && App.Settings.applyToUI(), 'applyToUI');
        safe(() => App.Org && App.Org.refresh(), 'Org');
        safe(() => App.LeaveTypes && App.LeaveTypes.refresh(), 'LeaveTypes');
        safe(() => App.Staff && App.Staff.refresh(), 'Staff');
        safe(() => App.Holidays && App.Holidays.refresh(), 'Holidays');
        safe(() => App.Entry && App.Entry.refresh(), 'Entry');
        safe(() => App.Dashboard && App.Dashboard.refresh(), 'Dashboard');
        safe(() => App.Reports && App.Reports.refresh && App.Reports.refresh(), 'Reports');
        safe(() => App.Settings && App.Settings.refresh(), 'Settings');
        safe(() => App.AuditView && App.AuditView.refresh(), 'AuditView');
        if (currentTab === 'analytics') {
            safe(() => App.Analytics && App.Analytics.refresh && App.Analytics.refresh(), 'Analytics');
        }
    }

    const debouncedRefresh = App.debounce(refreshAll, 120);

    /* ---------------- التهيئة ---------------- */

    async function bootstrap() {
        if (booted) return;
        booted = true;

        try {
            await Store.init();
        } catch (e) {
            console.error('[App] فشل تهيئة التخزين', e);
            App.Notify.alert('تعذّر تهيئة التخزين المحلي: ' + (e && e.message ? e.message : 'خطأ') +
                '\n\nقد تكون خاصية التخزين معطّلة في المتصفح (وضع التصفح المتخفي مثلاً).', 'error', 'خطأ في التخزين');
            return;
        }

        /* وحدات النظام — كل واحدة معزولة حتى لا يعطّل خطأٌ البقية */
        safe(() => App.Settings && App.Settings.init(), 'Settings.init');
        safe(() => App.Org && App.Org.init(), 'Org.init');
        safe(() => App.LeaveTypes && App.LeaveTypes.init(), 'LeaveTypes.init');
        safe(() => App.Staff && App.Staff.init(), 'Staff.init');
        safe(() => App.Holidays && App.Holidays.init(), 'Holidays.init');
        safe(() => App.Entry && App.Entry.init(), 'Entry.init');
        safe(() => App.Dashboard && App.Dashboard.init(), 'Dashboard.init');
        safe(() => App.Reports && App.Reports.init && App.Reports.init(), 'Reports.init');
        safe(() => App.Analytics && App.Analytics.init && App.Analytics.init(), 'Analytics.init');
        safe(() => App.AuditView && App.AuditView.init(), 'AuditView.init');

        /* التاريخ الافتراضي */
        const today = App.Dates.todayISO();
        const dashDate = $('dashboardFilterDate');
        if (dashDate && !dashDate.value) dashDate.value = today;
        const rptMonth = $('reportMonth');
        if (rptMonth && !rptMonth.value) rptMonth.value = today.slice(0, 7);
        const rptYear = $('reportYear');
        if (rptYear && !rptYear.value) rptYear.value = App.Dates.yearOf(today);
        const rptFrom = $('reportFrom');
        if (rptFrom && !rptFrom.value) rptFrom.value = App.Dates.yearRange(App.Dates.yearOf(today)).from;
        const rptTo = $('reportTo');
        if (rptTo && !rptTo.value) rptTo.value = today;

        /* التنقل */
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-app-tab]');
            if (!btn) return;
            e.preventDefault();
            goTab(btn.dataset.appTab);
        });

        /* أحداث المخزن */
        Store.on('change', () => {
            debouncedRefresh();
            updateBanner();
        });
        Store.on('folder', () => {
            updateBanner();
            safe(() => App.Settings && App.Settings.refresh(), 'Settings.refresh');
        });
        Store.on('backup', (d) => {
            safe(() => App.Settings && App.Settings.loadBackups(), 'loadBackups');
        });
        Store.on('imported', () => {
            refreshAll();
        });

        /* حفظ احتياطي عند إخفاء الصفحة أو إغلاقها */
        window.addEventListener('pagehide', () => { Store.flush(); });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                Store.flush();
            } else {
                Store.autoBackupIfNeeded().then((f) => {
                    if (f) App.Notify.toast('تم إنشاء نسخة احتياطية يومية', 'success');
                }).catch(() => { });
            }
        });

        /* تحذير عند الإغلاق مع وجود تغييرات */
        window.addEventListener('beforeunload', (e) => {
            Store.flush();
            if (App.Entry && App.Entry.isDirty()) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
            return undefined;
        });

        /* اختصارات لوحة المفاتيح */
        document.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;

            /* Ctrl+P: نمرّره على مسار الطباعة المولّد (صفحات A4 + تذييل + ترقيم)
               بدل طباعة المتصفح الخام التي تفقد الهوامش والترقيم. */
            if (e.key === 'p' || e.key === 'P') {
                e.preventDefault();
                printCurrentView();
                return;
            }

            if (e.key === 's') {
                e.preventDefault();
                if (currentTab === 'entry') {
                    App.Entry.save(null);
                } else {
                    Store.flush().then(function () { App.Notify.toast('تم حفظ البيانات', 'success'); });
                }
            }
        });

        showTab('dashboard');
        updateBanner();

        /* نسخة احتياطية يومية تلقائية */
        Store.autoBackupIfNeeded().then((f) => {
            if (f) App.Notify.toast('تم إنشاء نسخة احتياطية يومية: ' + f, 'success');
        }).catch(() => { });

        console.log('%cنظام موقف الإجازات اليومية ' + C.APP_VERSION + ' — جاهز',
            'color:#0284c7;font-weight:bold');
        console.log('واجهة التخزين:', Store.backend(), '| مجلد مرتبط:', Store.isConnected());
    }

    return {
        bootstrap: bootstrap,
        goTab: goTab,
        showTab: showTab,
        refreshAll: refreshAll,
        updateBanner: updateBanner,
        printCurrentView: printCurrentView,
        currentTab: () => currentTab
    };
})();

document.addEventListener('DOMContentLoaded', function () {
    App.App.bootstrap();
});
