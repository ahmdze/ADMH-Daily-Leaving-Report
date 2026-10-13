/* ============================================================
   وحدة الأقسام والشعب — إضافة وتعديل وحذف
   ============================================================ */
window.App = window.App || {};

App.Org = (function () {
    'use strict';

    const C = App.Constants;
    const esc = App.Security.esc;
    const Store = App.Store;

    let inited = false;

    function depts() { return Store.get.departments(); }

    /** مفتاح مطابقة يتجاهل حالة الأحرف والمسافات — نفس منطق المخزن */
    function matchKey(s) { return Store.normalizeName(s).toLowerCase(); }

    function findByName(name) {
        const key = matchKey(name);
        if (!key) return null;
        return depts().find(d => d && matchKey(d.name) === key) || null;
    }

    function sectionsOf(deptName) {
        const d = findByName(deptName);
        return d ? d.sections : [];
    }

    /* ---------------- القوائم المنسدلة ----------------
       حقول نموذج الإدخال (#entryDept و#entrySection) أصبحت حقول كتابة
       مع قوائم اقتراح (datalist)، أما بقية الحقول فما زالت selects. */

    /** يبني قائمة الاقتراحات لأقسام نموذج الإدخال */
    function populateDeptDatalist() {
        const list = document.getElementById('entryDeptList');
        if (!list) return;
        list.innerHTML = depts()
            .map(d => `<option value="${esc(d.name)}"></option>`)
            .join('');
    }

    /**
     * يبني قائمة اقتراحات الشعب لقسم معيّن.
     * لا يلمس قيمة #entrySection إطلاقاً حتى لا يُمحى ما كتبه المستخدم.
     */
    function populateSectionDatalist(deptName) {
        const list = document.getElementById('entrySectionList');
        if (!list) return;
        list.innerHTML = sectionsOf(deptName)
            .map(s => `<option value="${esc(s.name)}"></option>`)
            .join('');
    }

    function populateSelects() {
        const list = depts();

        /* فلتر الموقف اليومي */
        const filterDept = document.getElementById('filterDept');
        if (filterDept) {
            const cur = filterDept.value;
            filterDept.innerHTML = '<option value="">جميع الأقسام</option>' +
                list.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
            filterDept.value = cur;
        }

        /* نموذج الإدخال: قسم قابل للكتابة ← قائمة اقتراحات */
        populateDeptDatalist();

        /* إضافة شعبة */
        const newSectionDept = document.getElementById('newSectionDept');
        if (newSectionDept) {
            const cur = newSectionDept.value;
            newSectionDept.innerHTML = list.length
                ? list.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('')
                : '<option value="">لا توجد أقسام</option>';
            newSectionDept.value = cur || (list[0] ? list[0].name : '');
        }

        /* فلتر الإحصائيات */
        const anDept = document.getElementById('anDept');
        if (anDept) {
            const cur = anDept.value;
            anDept.innerHTML = '<option value="">جميع الأقسام</option>' +
                list.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
            anDept.value = cur;
        }

        /* فلتر التقرير */
        const reportDept = document.getElementById('reportDept');
        if (reportDept) {
            const cur = reportDept.value;
            reportDept.innerHTML = '<option value="">جميع الأقسام</option>' +
                list.map(d => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
            reportDept.value = cur;
        }
    }

    /* ---------------- الرسم ---------------- */

    function render() {
        const host = document.getElementById('deptList');
        if (!host) return;

        const kw = App.Security.clean((document.getElementById('deptSearch') || {}).value || '').toLowerCase();
        const leaves = Store.get.leaves();
        const staff = Store.get.staff();

        const list = depts().filter(d => {
            if (!kw) return true;
            if (d.name.toLowerCase().includes(kw)) return true;
            return d.sections.some(s => s.name.toLowerCase().includes(kw));
        });

        if (!list.length) {
            host.innerHTML = '<p class="text-center py-6 text-slate-400 text-xs font-bold">لا توجد أقسام مطابقة</p>';
            return;
        }

        host.innerHTML = list.map(d => {
            const secs = d.sections || [];
            const leavesCount = leaves.filter(l => l.dept === d.name).length;
            const staffCount = staff.filter(p => p.dept === d.name).length;

            const secHtml = secs.length
                ? secs.map(s => {
                    const cnt = leaves.filter(l => l.dept === d.name && l.section === s.name).length;
                    return `
                        <span class="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-700">
                            <span>${esc(s.name)}</span>
                            ${cnt ? `<span class="text-[9px] text-slate-400">(${cnt})</span>` : ''}
                            <button type="button" class="text-slate-400 hover:text-brand-700" data-act="rename-section" data-dept="${esc(d.id)}" data-sec="${esc(s.id)}" title="تعديل الاسم"><i class="fa-solid fa-pen text-[9px]"></i></button>
                            <button type="button" class="text-rose-400 hover:text-rose-700" data-act="del-section" data-dept="${esc(d.id)}" data-sec="${esc(s.id)}" title="حذف الشعبة"><i class="fa-solid fa-xmark text-[10px]"></i></button>
                        </span>`;
                }).join('')
                : '<span class="text-[11px] text-slate-400">لا توجد شعب</span>';

            return `
                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3">
                    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div class="flex items-center gap-2">
                            <i class="fa-solid fa-building text-brand-600 text-xs"></i>
                            <h4 class="font-extrabold text-xs text-slate-800">${esc(d.name)}</h4>
                            <span class="text-[10px] text-slate-500">
                                ${secs.length} شعبة · ${staffCount} موظف · ${leavesCount} سجل
                            </span>
                        </div>
                        <div class="flex items-center gap-1">
                            <button type="button" class="text-brand-600 hover:text-brand-800 p-1 text-[11px]" data-act="rename-dept" data-dept="${esc(d.id)}" title="تعديل اسم القسم"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="text-rose-600 hover:text-rose-800 p-1 text-[11px]" data-act="del-dept" data-dept="${esc(d.id)}" title="حذف القسم"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-1.5">${secHtml}</div>
                </div>`;
        }).join('');
    }

    /* ---------------- العمليات ---------------- */

    function addDept() {
        const input = document.getElementById('newDeptName');
        if (!input) return;
        const name = App.Security.clean(input.value, 120);
        if (!name) { App.Notify.toast('يرجى كتابة اسم القسم', 'warning'); return; }
        if (findByName(name)) { App.Notify.toast('هذا القسم موجود مسبقاً', 'warning'); return; }

        depts().push({ id: C.uid('d'), name: name, sections: [] });
        Store.save([C.KEYS.DEPARTMENTS]);
        App.Audit.log({ action: 'insert', entity: 'departments', label: 'إضافة قسم: ' + name, after: { name: name } });
        input.value = '';
        App.Notify.toast('تمت إضافة القسم', 'success');
    }

    function addSection() {
        const deptSel = document.getElementById('newSectionDept');
        const nameInput = document.getElementById('newSectionName');
        if (!deptSel || !nameInput) return;

        const dept = findByName(deptSel.value);
        const name = App.Security.clean(nameInput.value, 120);

        if (!dept) { App.Notify.toast('يرجى اختيار القسم أولاً', 'warning'); return; }
        if (!name) { App.Notify.toast('يرجى كتابة اسم الشعبة', 'warning'); return; }
        if (dept.sections.some(s => s.name === name)) {
            App.Notify.toast('هذه الشعبة موجودة في القسم نفسه', 'warning');
            return;
        }

        dept.sections.push({ id: C.uid('s'), name: name });
        Store.save([C.KEYS.DEPARTMENTS]);
        App.Audit.log({ action: 'insert', entity: 'sections', label: 'إضافة شعبة: ' + name + ' في ' + dept.name });
        nameInput.value = '';
        App.Notify.toast('تمت إضافة الشعبة', 'success');
    }

    async function renameDept(id) {
        const dept = depts().find(d => d.id === id);
        if (!dept) return;
        const newName = await App.Notify.prompt('الاسم الجديد للقسم:', dept.name, { title: 'تعديل اسم القسم', maxLength: 120 });
        if (!newName || newName === dept.name) return;
        if (findByName(newName)) { App.Notify.toast('يوجد قسم بهذا الاسم', 'warning'); return; }

        const old = dept.name;
        dept.name = newName;

        /* تحديث المراجع النصية في السجلات والموظفين */
        Store.get.leaves().forEach(l => { if (l.dept === old) l.dept = newName; });
        Store.get.staff().forEach(p => { if (p.dept === old) p.dept = newName; });

        Store.save([C.KEYS.DEPARTMENTS, C.KEYS.LEAVES, C.KEYS.STAFF]);
        App.Audit.log({ action: 'update', entity: 'departments', recordId: id, label: 'تعديل قسم: ' + old + ' ← ' + newName });
        App.Notify.toast('تم تعديل اسم القسم', 'success');
    }

    async function renameSection(deptId, secId) {
        const dept = depts().find(d => d.id === deptId);
        if (!dept) return;
        const sec = dept.sections.find(s => s.id === secId);
        if (!sec) return;

        const newName = await App.Notify.prompt('الاسم الجديد للشعبة:', sec.name, { title: 'تعديل اسم الشعبة', maxLength: 120 });
        if (!newName || newName === sec.name) return;
        if (dept.sections.some(s => s.name === newName && s.id !== secId)) {
            App.Notify.toast('يوجد شعبة بهذا الاسم في القسم نفسه', 'warning');
            return;
        }

        const old = sec.name;
        sec.name = newName;
        Store.get.leaves().forEach(l => {
            if (l.dept === dept.name && l.section === old) l.section = newName;
        });
        Store.get.staff().forEach(p => {
            if (p.dept === dept.name && p.section === old) p.section = newName;
        });

        Store.save([C.KEYS.DEPARTMENTS, C.KEYS.LEAVES, C.KEYS.STAFF]);
        App.Audit.log({ action: 'update', entity: 'sections', recordId: secId, label: 'تعديل شعبة: ' + old + ' ← ' + newName });
        App.Notify.toast('تم تعديل اسم الشعبة', 'success');
    }

    async function deleteDept(id) {
        const dept = depts().find(d => d.id === id);
        if (!dept) return;

        const used = Store.get.leaves().filter(l => l.dept === dept.name).length;
        const staffUsed = Store.get.staff().filter(p => p.dept === dept.name).length;

        let msg = 'سيتم حذف القسم «' + dept.name + '» وجميع شعبه.';
        if (used || staffUsed) {
            msg += '\n\nتنبيه: يوجد ' + used + ' سجل إجازة و' + staffUsed +
                   ' موظف مسجّلون على هذا القسم. لن تُحذف سجلاتهم، لكن سيبقى اسم القسم كنص فيها.';
        }

        const ok = await App.Notify.confirm(msg, {
            title: 'تأكيد حذف القسم', danger: true, confirmText: 'نعم، احذف', type: 'warning'
        });
        if (!ok) return;

        const list = depts();
        const idx = list.findIndex(d => d.id === id);
        if (idx === -1) return;
        list.splice(idx, 1);

        Store.save([C.KEYS.DEPARTMENTS]);
        App.Audit.log({ action: 'delete', entity: 'departments', recordId: id, label: 'حذف قسم: ' + dept.name, before: dept });
        App.Notify.toast('تم حذف القسم', 'success');
    }

    async function deleteSection(deptId, secId) {
        const dept = depts().find(d => d.id === deptId);
        if (!dept) return;
        const sec = dept.sections.find(s => s.id === secId);
        if (!sec) return;

        const used = Store.get.leaves().filter(l => l.dept === dept.name && l.section === sec.name).length;
        const ok = await App.Notify.confirm(
            'حذف الشعبة «' + sec.name + '»؟' + (used ? '\n\nيوجد ' + used + ' سجل مرتبط بها (لن تُحذف السجلات).' : ''),
            { title: 'تأكيد الحذف', danger: true, confirmText: 'احذف', type: 'warning' }
        );
        if (!ok) return;

        dept.sections = dept.sections.filter(s => s.id !== secId);
        Store.save([C.KEYS.DEPARTMENTS]);
        App.Audit.log({ action: 'delete', entity: 'sections', recordId: secId, label: 'حذف شعبة: ' + sec.name + ' من ' + dept.name });
        App.Notify.toast('تم حذف الشعبة', 'success');
    }

    /* ---------------- التهيئة ---------------- */

    function init() {
        if (inited) { refresh(); return; }
        inited = true;

        const onClick = (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'del-dept') deleteDept(btn.dataset.dept);
            else if (act === 'rename-dept') renameDept(btn.dataset.dept);
            else if (act === 'del-section') deleteSection(btn.dataset.dept, btn.dataset.sec);
            else if (act === 'rename-section') renameSection(btn.dataset.dept, btn.dataset.sec);
        };

        const host = document.getElementById('deptList');
        if (host) host.addEventListener('click', onClick);

        const addDeptBtn = document.getElementById('btnAddDept');
        if (addDeptBtn) addDeptBtn.addEventListener('click', addDept);

        const addSecBtn = document.getElementById('btnAddSection');
        if (addSecBtn) addSecBtn.addEventListener('click', addSection);

        const search = document.getElementById('deptSearch');
        if (search) {
            search.addEventListener('input', App.debounce(() => render(), 250));
        }

        const newDeptName = document.getElementById('newDeptName');
        if (newDeptName) {
            newDeptName.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); addDept(); }
            });
        }
        const newSectionName = document.getElementById('newSectionName');
        if (newSectionName) {
            newSectionName.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); addSection(); }
            });
        }

        refresh();
    }

    function refresh() {
        populateSelects();
        /* قائمة الشعب تتبع ما هو مكتوب في حقل القسم حالياً */
        const entryDept = document.getElementById('entryDept');
        populateSectionDatalist(entryDept ? entryDept.value : '');
        render();
    }

    return {
        init: init,
        refresh: refresh,
        render: render,
        populateSelects: populateSelects,
        populateSectionDatalist: populateSectionDatalist,
        findByName: findByName,
        sectionsOf: sectionsOf,
        addDept: addDept,
        addSection: addSection
    };
})();
