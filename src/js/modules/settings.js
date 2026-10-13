/* ============================================================
   وحدة الإعدادات: الترويسة، سياسة الأيام، التخزين، حول النظام
   ============================================================ */
window.App = window.App || {};

App.Settings = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    const $ = (id) => document.getElementById(id);
    let inited = false;

    /* ---------------- الترويسة ---------------- */

    function applyToUI() {
        const s = Store.get.settings();

        const setText = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };
        setText('navHospitalName', s.hospital || 'المستشفى');
        setText('navDeptName', s.departmentUnit || 'شعبة الموارد البشرية');

        setText('rptMinistry', s.ministry || '');
        setText('rptDirectorate', s.directorate || '');
        setText('rptHospital', s.hospital || '');
        setText('rptDepartmentUnit', s.departmentUnit || '');
        setText('rptFooterHR', s.footerHR || '');
        setText('rptFooterManager', s.footerManager || '');
        setText('rptTitle', s.rptTitle || 'موقف الإجازات اليومي للموظفين');

        const footer = $('printFooterText');
        if (footer) {
            footer.textContent = s.printFooterText || C.DEFAULT_SETTINGS.printFooterText;
        }

        /* الشعار */
        const imgs = ['navLogoImg', 'rptLogoImg', 'logoPreviewImg'];
        const defaults = ['navLogoDefault', 'rptLogoDefault', 'logoPreviewPlaceholder'];
        imgs.forEach(id => {
            const el = $(id);
            if (!el) return;
            if (s.logoBase64) {
                el.src = s.logoBase64;
                el.classList.remove('hidden');
            } else {
                el.removeAttribute('src');
                el.classList.add('hidden');
            }
        });
        defaults.forEach(id => {
            const el = $(id);
            if (!el) return;
            if (s.logoBase64) el.classList.add('hidden');
            else el.classList.remove('hidden');
        });
        const removeBtn = $('removeLogoBtn');
        if (removeBtn) removeBtn.classList.toggle('hidden', !s.logoBase64);

        /* حقول النموذج */
        const fields = {
            setMinistry: s.ministry, setDirectorate: s.directorate,
            setHospital: s.hospital, setDepartmentUnit: s.departmentUnit,
            setFooterHR: s.footerHR, setFooterManager: s.footerManager,
            setOperatorName: s.operatorName, setRptTitle: s.rptTitle
        };
        Object.keys(fields).forEach(id => {
            const el = $(id);
            if (el) el.value = fields[id] || '';
        });

        /* السياسة */
        document.querySelectorAll('input[name="setHolidayMode"]').forEach(r => {
            r.checked = (r.value === (s.holidayMode || 'inside'));
        });
        const cw = $('setCountWeekend');
        if (cw) cw.checked = s.countWeekend !== false;
        const db = $('setDefaultBalance');
        if (db) db.value = App.Security.toInt(s.defaultAnnualBalance, 21, 0, 365);
        const ds = $('setDefaultStatus');
        if (ds) ds.value = s.defaultStatus || 'approved';
    }

    function saveGeneral() {
        const s = Store.get.settings();
        const read = (id, max) => { const el = $(id); return el ? App.Security.clean(el.value, max || 200) : ''; };

        const before = Object.assign({}, s);
        s.ministry = read('setMinistry');
        s.directorate = read('setDirectorate');
        s.hospital = read('setHospital');
        s.departmentUnit = read('setDepartmentUnit');
        s.footerHR = read('setFooterHR');
        s.footerManager = read('setFooterManager');
        s.operatorName = read('setOperatorName') || 'موظف الإجازات';
        s.rptTitle = read('setRptTitle') || 'موقف الإجازات اليومي للموظفين';
        /* نص التذييل صلب في الكود — انظر App.Constants.DEFAULT_SETTINGS.printFooterText */
        s.printFooterText = C.DEFAULT_SETTINGS.printFooterText;

        Store.save([C.KEYS.SETTINGS]);
        App.Audit.log({ action: 'update', entity: 'settings', label: 'تحديث بيانات الترويسة', before: before, after: s });
        applyToUI();
        App.Notify.toast('تم حفظ بيانات الترويسة', 'success');
    }

    /** يطبّق رصيداً واحداً على كل الموظفين الحاليين */
    function applyBalanceToAll(value) {
        const v = App.Security.toInt(value, C.DEFAULT_SETTINGS.defaultAnnualBalance, 0, 365);
        const staff = Store.get.staff();
        if (!staff.length) {
            App.Notify.toast('لا يوجد موظفون في الدليل', 'warning');
            return 0;
        }

        const before = staff.map(p => ({ id: p.id, name: p.name, annualBalance: p.annualBalance }));
        staff.forEach(p => { p.annualBalance = v; });

        Store.save([C.KEYS.STAFF]);
        App.Audit.log({
            action: 'update', entity: 'staff',
            label: 'تطبيق الرصيد السنوي ' + v + ' يوم على ' + staff.length + ' موظف',
            before: before
        });
        App.Notify.toast('تم تطبيق ' + v + ' يوم على ' + staff.length + ' موظف', 'success');
        return staff.length;
    }

    async function savePolicy() {
        const s = Store.get.settings();
        const before = Object.assign({}, s);

        const picked = document.querySelector('input[name="setHolidayMode"]:checked');
        s.holidayMode = picked ? picked.value : 'inside';
        const cw = $('setCountWeekend');
        s.countWeekend = cw ? cw.checked : true;
        const db = $('setDefaultBalance');
        s.defaultAnnualBalance = App.Security.toInt(db ? db.value : C.DEFAULT_SETTINGS.defaultAnnualBalance,
            C.DEFAULT_SETTINGS.defaultAnnualBalance, 0, 365);
        const ds = $('setDefaultStatus');
        s.defaultStatus = ds ? ds.value : 'approved';

        Store.save([C.KEYS.SETTINGS]);
        App.Audit.log({ action: 'update', entity: 'settings', label: 'تحديث سياسة احتساب الأيام', before: before, after: s });
        applyToUI();
        if (App.Entry && App.Entry.refresh) App.Entry.refresh();
        App.Notify.toast('تم حفظ السياسة', 'success');

        /* الرصيد الافتراضي يُطبَّق على الموظفين الجدد فقط،
           فرصيد كل موظف حالي محفوظ على حدة. لذلك نسأل عند تغييره. */
        const oldBalance = App.Security.toInt(before.defaultAnnualBalance, 0, 0, 365);
        if (s.defaultAnnualBalance !== oldBalance && Store.get.staff().length) {
            const apply = await App.Notify.confirm(
                'تغيّر الرصيد السنوي الافتراضي من ' + oldBalance + ' إلى ' + s.defaultAnnualBalance + ' يوم.\n\n' +
                'هذا الرصيد يُطبَّق تلقائياً على الموظفين الجدد فقط، أما الموظفون الحاليون ' +
                '(' + Store.get.staff().length + ' موظف) فلكل واحد رصيده المحفوظ.\n\n' +
                'هل تريد تطبيق الرصيد الجديد على كل الموظفين الحاليين أيضاً؟',
                {
                    title: 'تطبيق الرصيد الجديد',
                    confirmText: 'طبّقه على الكل',
                    cancelText: 'الجدد فقط',
                    type: 'question',
                    icon: 'fa-users-gear'
                }
            );
            if (apply) applyBalanceToAll(s.defaultAnnualBalance);
        }
    }

    /** يعيد احتساب كل السجلات وفق السياسة والعطل الحالية */
    async function recalcAll() {
        const ok = await App.Notify.confirm(
            'سيتم إعادة احتساب الأيام المخصومة والأيام التعويضية لكل السجلات وفق سياسة الأيام والعطل الرسمية الحالية.\n\n' +
            'ملاحظة: هذا لا يغيّر تواريخ الإجازات، لكنه قد يغيّر عدد الأيام المخصومة.',
            { title: 'إعادة احتساب كل السجلات', confirmText: 'إعادة الاحتساب', type: 'warning' }
        );
        if (!ok) return;

        const s = Store.get.settings();
        const holidays = Store.get.holidays();
        const leaves = Store.get.leaves();
        let changed = 0;

        leaves.forEach(l => {
            const type = Store.leaveTypeById(l.leaveTypeId) || Store.leaveTypeByName(l.leaveType);
            const a = App.Dates.analyze({
                isHourly: !!(l.leaveTypeIsHourly || (type && type.isHourly)),
                fromDate: l.fromDate,
                toDate: l.toDate,
                hoursCount: l.hoursCount,
                deductsBalance: type ? type.deductsBalance : true,
                holidayMode: s.holidayMode,
                countWeekend: s.countWeekend,
                holidays: holidays
            });
            if (!a.valid) return;

            if (l.deductedDays !== a.deductedDays ||
                l.calendarDays !== a.calendarDays ||
                (l.compensatoryDays || 0) !== a.compensatoryDays) changed++;

            l.calendarDays = a.calendarDays;
            l.daysCount = a.isHourly ? 0 : a.calendarDays;
            l.deductedDays = a.deductedDays;
            l.compensatoryDays = a.compensatoryDays;
            l.excludedHolidays = a.excludedHolidays;
            l.holidayNote = a.excludedHolidays.length
                ? 'من ضمن الإجازة عطلة رسمية: ' + a.excludedHolidays.map(h => h.name + ' (' + h.date + ')').join('، ')
                : '';
            l.updatedAt = new Date().toISOString();

            if (App.Entry && App.Entry.syncCompensations) App.Entry.syncCompensations(l);
        });

        Store.save([C.KEYS.LEAVES, C.KEYS.COMPENSATIONS]);
        App.Audit.log({
            action: 'system', entity: 'leaves',
            label: 'إعادة احتساب كل السجلات — تغيّر ' + changed + ' سجل من ' + leaves.length
        });
        App.Notify.toast('تمت إعادة الاحتساب. تغيّر ' + changed + ' سجل.', 'success');
    }

    /* ---------------- الشعار ---------------- */

    function pickLogo() {
        const input = $('logoInput');
        if (input) input.click();
    }

    function handleLogo(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        if (file.size > 2 * 1024 * 1024) {
            App.Notify.alert('حجم الصورة كبير. يرجى اختيار صورة أقل من 2 ميجابايت.', 'warning', 'صورة كبيرة');
            event.target.value = '';
            return;
        }
        if (!/^image\//.test(file.type)) {
            App.Notify.alert('الملف المختار ليس صورة.', 'warning');
            event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const s = Store.get.settings();
            s.logoBase64 = e.target.result;
            Store.save([C.KEYS.SETTINGS]);
            App.Audit.log({ action: 'update', entity: 'settings', label: 'تحديث شعار المؤسسة' });
            applyToUI();
            App.Notify.toast('تم حفظ الشعار', 'success');
        };
        reader.onerror = () => App.Notify.alert('تعذّر قراءة ملف الصورة.', 'error');
        reader.readAsDataURL(file);
    }

    async function removeLogo() {
        const ok = await App.Notify.confirm('حذف شعار المؤسسة؟', { title: 'تأكيد', danger: true, confirmText: 'احذف' });
        if (!ok) return;
        const s = Store.get.settings();
        s.logoBase64 = '';
        Store.save([C.KEYS.SETTINGS]);
        const input = $('logoInput');
        if (input) input.value = '';
        applyToUI();
        App.Notify.toast('تم حذف الشعار', 'success');
    }

    /* ---------------- التخزين ---------------- */

    function renderStorage() {
        const localEl = $('storageLocalStatus');
        if (localEl) {
            if (App.IDB.supported()) {
                const n = Store.get.leaves().length;
                localEl.textContent = 'فعّال — ' + App.num(n) + ' سجل إجازة محفوظ في المتصفح';
                localEl.className = 'font-bold text-emerald-700';
            } else {
                localEl.textContent = 'غير مدعوم في هذا المتصفح';
                localEl.className = 'font-bold text-rose-700';
            }
        }

        const folderEl = $('storageFolderStatus');
        const connected = Store.isConnected();
        if (folderEl) {
            if (connected) {
                folderEl.textContent = 'مرتبط: ' + (Store.folderName() || 'مجلد البيانات') + ' — الحفظ تلقائي';
                folderEl.className = 'font-bold text-emerald-700';
            } else if (Store.hasPendingFolder()) {
                folderEl.textContent = 'مجلد محفوظ (' + (Store.pendingFolderName() || '') + ') يحتاج إعادة تفعيل الإذن';
                folderEl.className = 'font-bold text-amber-700';
            } else if (!App.FSA.supported()) {
                folderEl.textContent = 'غير مدعوم في هذا المتصفح (استخدم Chrome أو Edge)';
                folderEl.className = 'font-bold text-slate-500';
            } else {
                folderEl.textContent = 'غير مرتبط';
                folderEl.className = 'font-bold text-slate-600';
            }
        }

        const connectBtn = $('btnConnectFolder');
        if (connectBtn) connectBtn.classList.toggle('hidden', connected || !App.FSA.supported());
        const reconnectBtn = $('btnReconnectFolder');
        if (reconnectBtn) reconnectBtn.classList.toggle('hidden', !Store.hasPendingFolder() || connected);
        const disconnectBtn = $('btnDisconnectFolder');
        if (disconnectBtn) disconnectBtn.classList.toggle('hidden', !connected);
    }

    async function connectFolder() {
        try {
            await App.Notify.confirm(
                'سيُطلب منك اختيار مجلد لحفظ البيانات فيه.\n\n' +
                'يُنصح بإنشاء مجلد باسم «بيانات موقف الإجازات» داخل المستندات أو على قرص النسخ الاحتياطي، ثم اختياره.\n\n' +
                'بعد الربط تُحفظ كل التعديلات في المجلد تلقائياً مع نسخ احتياطية يومية.',
                { title: 'ربط مجلد البيانات', confirmText: 'اختيار المجلد', type: 'question' }
            ).then(ok => { if (!ok) throw { cancelled: true }; });

            const name = await Store.connectFolder();
            renderStorage();
            App.Notify.toast('تم ربط المجلد: ' + name, 'success');
            loadBackups();
        } catch (e) {
            if (e && e.cancelled) return;
            if (e && e.name === 'AbortError') return;
            App.Notify.alert('تعذّر ربط المجلد: ' + (e && e.message ? e.message : 'خطأ غير معروف'), 'error');
        }
    }

    async function reconnectFolder() {
        try {
            const name = await Store.reconnectFolder();
            renderStorage();
            App.Notify.toast('تم إعادة تفعيل الحفظ في: ' + name, 'success');
            loadBackups();
        } catch (e) {
            App.Notify.alert('تعذّر إعادة الاتصال: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    async function disconnectFolder() {
        const ok = await App.Notify.confirm(
            'فصل المجلد يعني توقف الحفظ التلقائي عليه. البيانات ستبقى محفوظة داخل المتصفح، والملفات في المجلد لن تُحذف.',
            { title: 'فصل مجلد البيانات', confirmText: 'فصل', danger: true, type: 'warning' }
        );
        if (!ok) return;
        Store.disconnectFolder();
        renderStorage();
        App.Notify.toast('تم فصل المجلد', 'info');
    }

    async function backupNow() {
        if (!Store.isConnected()) {
            App.Notify.alert('اربط مجلد البيانات أولاً حتى يمكن إنشاء نسخة احتياطية عليه.\n\nيمكنك أيضاً استخدام «تصدير نسخة احتياطية (JSON)» لحفظ ملف على أي مكان.', 'warning', 'لا يوجد مجلد');
            return;
        }
        try {
            const name = await Store.writeBackup('manual');
            App.Audit.log({ action: 'system', entity: 'backup', label: 'نسخة احتياطية يدوية', note: name });
            App.Notify.toast('تم إنشاء نسخة احتياطية: ' + name, 'success');
            loadBackups();
        } catch (e) {
            App.Notify.alert('تعذّر إنشاء النسخة الاحتياطية: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    async function loadBackups() {
        const host = $('backupList');
        if (!host) return;

        if (!Store.isConnected()) {
            host.innerHTML = '<p class="text-slate-400 font-bold text-center py-4">اربط مجلد البيانات لعرض النسخ الاحتياطية</p>';
            return;
        }

        const files = await Store.listBackups();
        if (!files.length) {
            host.innerHTML = '<p class="text-slate-400 font-bold text-center py-4">لا توجد نسخ احتياطية بعد</p>';
            return;
        }

        host.innerHTML = files.map(f => `
            <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                <span class="font-bold text-slate-700">${esc(f)}</span>
                <button type="button" class="text-[11px] font-bold text-brand-700 hover:text-brand-900" data-bact="restore" data-file="${esc(f)}">استعادة</button>
            </div>`).join('');
    }

    async function restoreBackup(fileName) {
        const ok = await App.Notify.confirm(
            'استعادة النسخة «' + fileName + '»؟\n\nسيتم استبدال كل البيانات الحالية بمحتوى هذه النسخة. يُنصح بتصدير نسخة من الوضع الحالي أولاً.',
            { title: 'تأكيد الاستعادة', confirmText: 'استعادة', danger: true, type: 'warning' }
        );
        if (!ok) return;
        try {
            await Store.restoreBackup(fileName);
            App.Audit.log({ action: 'system', entity: 'backup', label: 'استعادة نسخة احتياطية', note: fileName });
            applyToUI();
            App.App.refreshAll();
            renderStorage();
            App.Notify.toast('تمت الاستعادة بنجاح', 'success');
        } catch (e) {
            App.Notify.alert('تعذّرت الاستعادة: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    function exportJson() {
        try {
            const name = Store.exportToFile();
            App.Audit.log({ action: 'system', entity: 'backup', label: 'تصدير نسخة احتياطية JSON', note: name });
            App.Notify.toast('تم تصدير النسخة الاحتياطية', 'success');
        } catch (e) {
            App.Notify.alert('تعذّر التصدير: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    function importJson(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const obj = JSON.parse(ev.target.result);
                const leavesCount = (obj.leaves || obj.leavesList || []).length;

                const ok = await App.Notify.confirm(
                    'الملف: ' + file.name + '\n' +
                    'يحتوي على ' + leavesCount + ' سجل إجازة.\n\n' +
                    'سيتم استبدال البيانات الحالية بمحتوى الملف. متابعة؟',
                    { title: 'تأكيد الاستيراد', confirmText: 'استيراد', danger: true, type: 'warning' }
                );
                if (!ok) return;

                await Store.importFromObject(obj);
                App.Audit.log({ action: 'system', entity: 'backup', label: 'استيراد ملف نسخة احتياطية', note: file.name });
                applyToUI();
                App.App.refreshAll();
                renderStorage();
                App.Notify.toast('تم الاستيراد بنجاح — ' + leavesCount + ' سجل', 'success');
            } catch (e) {
                App.Notify.alert('تعذّر الاستيراد: ' + (e && e.message ? e.message : 'ملف غير صالح'), 'error');
            } finally {
                event.target.value = '';
            }
        };
        reader.onerror = () => App.Notify.alert('تعذّرت قراءة الملف', 'error');
        reader.readAsText(file);
    }

    async function importFolder() {
        try {
            const ok = await App.Notify.confirm(
                'اختر مجلد بيانات سابق للنظام لاستيراد محتواه.\n\nسيتم استبدال البيانات الحالية.',
                { title: 'استيراد من مجلد بيانات', confirmText: 'اختيار المجلد', danger: true, type: 'warning' }
            );
            if (!ok) return;

            const data = await Store.importFromFolder();
            App.Audit.log({ action: 'system', entity: 'backup', label: 'استيراد من مجلد بيانات' });
            applyToUI();
            App.App.refreshAll();
            renderStorage();
            App.Notify.toast('تم الاستيراد من المجلد — ' + (data.leaves ? data.leaves.length : 0) + ' سجل', 'success');
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            App.Notify.alert('تعذّر الاستيراد: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    async function factoryReset() {
        const ok = await App.Notify.confirm(
            'تحذير: سيتم حذف كل البيانات نهائياً (السجلات، الموظفون، الأقسام، العطل، الإعدادات) من هذا المتصفح.\n\n' +
            'ملفات النسخ الاحتياطية داخل المجلد المرتبط لن تُحذف، لكن النظام سيفقد ارتباطه بها.\n\n' +
            'هل صدّرت نسخة احتياطية؟',
            { title: 'تصفير النظام', confirmText: 'متابعة', danger: true, type: 'warning' }
        );
        if (!ok) return;

        const confirmText = await App.Notify.prompt(
            'اكتب كلمة «تصفير» لتأكيد العملية:', '',
            { title: 'تأكيد نهائي', confirmText: 'تصفير النظام' }
        );
        if (confirmText !== 'تصفير') {
            App.Notify.toast('أُلغيت العملية', 'info');
            return;
        }

        try {
            await Store.factoryReset();
            App.Notify.alert('تم تصفير النظام. سيُعاد تحميل الصفحة.', 'success', 'تم');
            setTimeout(() => location.reload(), 900);
        } catch (e) {
            App.Notify.alert('تعذّر التصفير: ' + (e && e.message ? e.message : 'خطأ'), 'error');
        }
    }

    /* ---------------- حول النظام ---------------- */

    function renderAbout() {
        const info = $('aboutInfo');
        if (info) {
            const s = Store.get.settings();
            const leaves = Store.get.leaves();
            const years = {};
            leaves.forEach(l => { const y = App.Dates.yearOf(l.fromDate); if (y) years[y] = (years[y] || 0) + 1; });

            const row = (k, v) => `
                <div class="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                    <span class="text-slate-500">${esc(k)}</span><span class="font-bold text-slate-800">${esc(v)}</span>
                </div>`;

            info.innerHTML =
                row('إصدار النظام', C.APP_VERSION) +
                row('إصدار مخطط البيانات', String(C.SCHEMA_VERSION)) +
                row('المؤسسة', s.hospital || '—') +
                row('مشغّل النظام', s.operatorName || '—') +
                row('عدد سجلات الإجازات', App.num(leaves.length)) +
                row('عدد الموظفين', App.num(Store.get.staff().length)) +
                row('عدد العطل الرسمية', App.num(Store.get.holidays().length)) +
                row('السنوات المسجّلة', Object.keys(years).sort().join('، ') || '—') +
                row('نوع التخزين الحالي', Store.backend() === 'idb' ? 'IndexedDB (المتصفح)' : 'localStorage') +
                row('حالة مجلد البيانات', Store.isConnected() ? 'مرتبط' : 'غير مرتبط') +
                row('آخر نسخة احتياطية', Store.get.meta().lastBackupDate || '—');
        }

        const caps = $('browserCaps');
        if (caps) {
            const ua = navigator.userAgent;
            let browser = 'غير معروف';
            if (/Edg\//.test(ua)) browser = 'Microsoft Edge';
            else if (/Chrome\//.test(ua)) browser = 'Google Chrome';
            else if (/Firefox\//.test(ua)) browser = 'Mozilla Firefox';
            else if (/Safari\//.test(ua)) browser = 'Safari';

            const cap = (label, ok, note) => `
                <div class="flex items-center gap-2">
                    <i class="fa-solid ${ok ? 'fa-circle-check text-emerald-600' : 'fa-circle-xmark text-rose-500'}"></i>
                    <span class="font-bold text-slate-700">${esc(label)}</span>
                    <span class="text-slate-500">${esc(note || '')}</span>
                </div>`;

            caps.innerHTML =
                cap('المتصفح', true, browser) +
                cap('التخزين المحلي IndexedDB', App.IDB.supported(), App.IDB.supported() ? 'يعمل' : 'غير متاح — البيانات في localStorage فقط') +
                cap('الحفظ في مجلد على القرص', App.FSA.supported(), App.FSA.supported() ? 'مدعوم' : 'غير مدعوم في Firefox — استخدم التصدير') +
                cap('تصدير Excel', App.Exporters.hasXLSX(), App.Exporters.hasXLSX() ? 'جاهز' : 'المكتبة مفقودة') +
                cap('تصدير PDF', App.Exporters.hasHtml2Pdf(), App.Exporters.hasHtml2Pdf() ? 'جاهز' : 'استخدم الطباعة ثم حفظ كـ PDF') +
                cap('العمل بدون إنترنت', true, 'كل المكتبات والخطوط محلية');
        }
    }

    /* ---------------- تبويبات الإعدادات ---------------- */

    function showSubTab(name) {
        document.querySelectorAll('.stab-btn').forEach(b => {
            const active = b.dataset.stab === name;
            b.classList.toggle('bg-brand-600', active);
            b.classList.toggle('text-white', active);
            b.classList.toggle('text-slate-600', !active);
        });
        document.querySelectorAll('.stab-panel').forEach(p => {
            p.classList.toggle('hidden', p.dataset.spanel !== name);
        });
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const bind = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

        bind('btnSaveSettings', 'click', saveGeneral);
        bind('btnSavePolicy', 'click', savePolicy);
        bind('btnRecalcAll', 'click', recalcAll);
        bind('btnApplyBalanceAll', 'click', async () => {
            const db = $('setDefaultBalance');
            const v = App.Security.toInt(db ? db.value : C.DEFAULT_SETTINGS.defaultAnnualBalance,
                C.DEFAULT_SETTINGS.defaultAnnualBalance, 0, 365);
            const n = Store.get.staff().length;
            if (!n) { App.Notify.toast('لا يوجد موظفون في الدليل', 'warning'); return; }

            const ok = await App.Notify.confirm(
                'سيتم ضبط الرصيد السنوي لجميع الموظفين (' + n + ' موظف) على ' + v + ' يوم.\n\n' +
                'هذا يستبدل أي رصيد مخصّص لموظف معيّن.',
                { title: 'تطبيق الرصيد على الكل', confirmText: 'تطبيق', type: 'warning' }
            );
            if (ok) applyBalanceToAll(v);
        });
        bind('btnPickLogo', 'click', pickLogo);
        bind('logoInput', 'change', handleLogo);
        bind('removeLogoBtn', 'click', removeLogo);

        bind('btnConnectFolder', 'click', connectFolder);
        bind('btnReconnectFolder', 'click', reconnectFolder);
        bind('btnDisconnectFolder', 'click', disconnectFolder);
        bind('btnBackupNow', 'click', backupNow);
        bind('btnRefreshBackups', 'click', loadBackups);
        bind('btnExportJson', 'click', exportJson);
        bind('btnImportJson', 'click', () => { const i = $('importJsonInput'); if (i) i.click(); });
        bind('importJsonInput', 'change', importJson);
        bind('btnImportFolder', 'click', importFolder);
        bind('btnResetFactory', 'click', factoryReset);

        const backupHost = $('backupList');
        if (backupHost) {
            backupHost.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-bact="restore"]');
                if (btn) restoreBackup(btn.dataset.file);
            });
        }

        const tabsHost = $('settingsTabs');
        if (tabsHost) {
            tabsHost.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-stab]');
                if (btn) showSubTab(btn.dataset.stab);
            });
        }

        showSubTab('general');
        refresh();
    }

    function refresh() {
        applyToUI();
        renderStorage();
        renderAbout();
        loadBackups();
    }

    return {
        init: init,
        refresh: refresh,
        applyToUI: applyToUI,
        renderStorage: renderStorage,
        renderAbout: renderAbout,
        showSubTab: showSubTab,
        loadBackups: loadBackups
    };
})();
