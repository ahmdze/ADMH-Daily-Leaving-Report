/* ============================================================
   Real-browser functional test driver (puppeteer-core + installed Edge)
   Verifies boot, rendering, entry flow, conflict detection,
   holiday policy engine, tab switching and captures screenshots.
   Run:  node tools/browser-test.mjs
   ============================================================ */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, '_screenshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

/* ------------------------------------------------------------
   خادم ملفات ثابت مؤقت — يُستخدم فقط لاختبار طبقة الحفظ في الملفات،
   لأن واجهة OPFS (التي نستعملها كبديل لمقبض المجلد) محجوبة على file://
   ------------------------------------------------------------ */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

function startStaticServer() {
    const server = http.createServer((req, res) => {
        try {
            let rel = decodeURIComponent(req.url.split('?')[0]);
            if (rel === '/') rel = '/index.html';
            if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
            const full = path.join(ROOT, rel);
            if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
            fs.createReadStream(full).pipe(res);
        } catch (e) {
            res.writeHead(500); res.end('error');
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, condition, detail) {
    const ok = !!condition;
    results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
    return ok;
}

const consoleErrors = [];
const pageErrors = [];

const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000']
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    /* قبل مغادرة الصفحة قد يظهر تحذير التغييرات غير المحفوظة */
    page.on('dialog', async (d) => { await d.accept(); });

    /* ---------- Phase A: boot ---------- */
    await page.goto(APP_URL, { waitUntil: 'load' });
    await page.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });

    const boot = await page.evaluate(() => ({
        backend: App.Store.backend(),
        leaves: App.Store.get.leaves().length,
        staff: App.Store.get.staff().length,
        depts: App.Store.get.departments().length,
        types: App.Store.get.leaveTypes().length,
        holidays: App.Store.get.holidays().length,
        hospital: App.Store.get.settings().hospital,
        mods: ['Constants', 'Security', 'Notify', 'Dates', 'IDB', 'FSA', 'Store', 'Audit', 'Exporters',
            'Pagination', 'Org', 'LeaveTypes', 'Staff', 'Holidays', 'Settings', 'Conflicts',
            'Entry', 'Dashboard', 'Reports', 'Analytics', 'AuditView', 'App']
            .filter(k => typeof App[k] !== 'undefined').length
    }));

    check('store initialised', boot.leaves === 0, 'leaves=' + boot.leaves);
    check('all 22 modules loaded', boot.mods === 22, boot.mods + '/22');
    check('default departments seeded', boot.depts === 6, boot.depts);
    check('default leave types seeded', boot.types === 7, boot.types);
    check('iraqi holidays seeded for current year', boot.holidays === 7, boot.holidays);
    check('hospital from settings', !!boot.hospital, boot.hospital);

    const dropdowns = await page.evaluate(() => ({
        entryDept: document.querySelectorAll('#entryDept option').length,
        entryType: document.querySelectorAll('#entryType option').length,
        filterDept: document.querySelectorAll('#filterDept option').length,
        anDept: document.querySelectorAll('#anDept option').length,
        reportEmp: document.querySelectorAll('#reportEmpName option').length,
        holidayYear: document.querySelectorAll('#holidayYearFilter option').length,
        dashboardRows: document.querySelectorAll('#typeList > div').length,
        deptCards: document.querySelectorAll('#deptList > div').length,
        holidayRows: document.querySelectorAll('#holidayList tr').length
    }));
    check('entry dept dropdown populated', dropdowns.entryDept === 7, dropdowns.entryDept);
    check('entry type dropdown populated', dropdowns.entryType === 7, dropdowns.entryType);
    check('dashboard dept filter populated', dropdowns.filterDept === 7, dropdowns.filterDept);
    check('analytics dept filter populated', dropdowns.anDept === 7, dropdowns.anDept);
    check('leave types list rendered', dropdowns.dashboardRows === 7, dropdowns.dashboardRows);
    check('departments list rendered', dropdowns.deptCards === 6, dropdowns.deptCards);
    check('holidays list rendered', dropdowns.holidayRows === 7, dropdowns.holidayRows);

    await page.screenshot({ path: path.join(SHOTS, '01-dashboard-empty.png') });

    /* ---------- Phase B: add a leave through the real form ---------- */
    const addLeave = async (opts) => page.evaluate((o) => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('entryEmpName', o.name);
        set('entryJobTitle', o.title);

        const dept = document.getElementById('entryDept');
        dept.value = o.dept;
        dept.dispatchEvent(new Event('change', { bubbles: true }));

        /* pick leave type by visible text */
        const type = document.getElementById('entryType');
        const opt = Array.from(type.options).find(x => x.textContent.includes(o.typeText));
        type.value = opt ? opt.value : type.options[0].value;
        type.dispatchEvent(new Event('change', { bubbles: true }));

        set('entryFromDate', o.from);
        set('entryToDate', o.to);
        set('entryNotes', o.notes || '');

        document.getElementById('entryForm').requestSubmit();
        return true;
    }, opts);

    await page.evaluate(() => App.App.showTab('entry'));
    await addLeave({
        name: 'د. علي حسين كاظم', title: 'طبيب اختصاص باطنية', dept: 'قسم الباطنية',
        typeText: 'اعتيادية', from: '2026-10-05', to: '2026-10-08', notes: 'ظرف عائلي'
    });
    await new Promise(r => setTimeout(r, 700));

    let state = await page.evaluate(() => ({
        leaves: App.Store.get.leaves().length,
        staff: App.Store.get.staff().length,
        first: App.Store.get.leaves()[0],
        tab: App.App.currentTab(),
        dirty: App.Entry.isDirty(),
        rows: document.querySelectorAll('#dashboardTableBody tr').length
    }));

    check('leave saved from form', state.leaves === 1, 'leaves=' + state.leaves);
    check('employee auto-added to directory', state.staff === 1, 'staff=' + state.staff);
    check('deducted days computed', state.first && state.first.deductedDays === 4, state.first && state.first.deductedDays);
    check('record linked to employee id', state.first && !!state.first.empId);
    check('switched to dashboard after save', state.tab === 'dashboard', state.tab);
    check('form no longer dirty', state.dirty === false);
    check('dashboard shows 1 row', state.rows === 1, state.rows);

    /* ---------- Phase C: conflict detection ---------- */
    await page.evaluate(() => App.App.showTab('entry'));
    await addLeave({
        name: 'د. علي حسين كاظم', title: 'طبيب اختصاص باطنية', dept: 'قسم الباطنية',
        typeText: 'مرضية', from: '2026-10-07', to: '2026-10-10', notes: 'تعارض متوقع'
    });
    await new Promise(r => setTimeout(r, 900));

    const conflictModal = await page.evaluate(() => {
        const back = document.querySelector('.app-modal-backdrop');
        if (!back) return { shown: false };
        return {
            shown: true,
            title: (back.querySelector('h3') || {}).textContent || '',
            tableRows: back.querySelectorAll('tbody tr').length,
            buttons: Array.from(back.querySelectorAll('button')).map(b => b.textContent.trim())
        };
    });
    check('conflict modal appeared', conflictModal.shown, conflictModal.title);
    check('conflict modal listed the overlap', conflictModal.tableRows === 1, conflictModal.tableRows);
    check('conflict modal offers 3 choices', (conflictModal.buttons || []).length >= 3, (conflictModal.buttons || []).join(' | '));

    if (conflictModal.shown) {
        await page.screenshot({ path: path.join(SHOTS, '02-conflict-modal.png') });
        /* choose "إلغاء الحفظ" */
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('.app-modal-backdrop button'));
            const cancel = btns.find(b => b.textContent.includes('إلغاء الحفظ'));
            if (cancel) cancel.click();
        });
        await new Promise(r => setTimeout(r, 600));
    }

    state = await page.evaluate(() => ({
        leaves: App.Store.get.leaves().length,
        modalGone: !document.querySelector('.app-modal-backdrop')
    }));
    check('conflicting record was NOT saved', state.leaves === 1, 'leaves=' + state.leaves);
    check('modal closed after cancel', state.modalGone);

    /* ---------- Phase D: holiday policy engine through real settings ---------- */
    const holidayCalc = await page.evaluate(() => {
        const s = App.Store.get.settings();
        s.holidayMode = 'excluded';
        s.countWeekend = true;
        App.Store.save(['settings']);

        /* 2026-12-10 is a seeded Iraqi holiday (يوم النصر) and a Thursday */
        const a = App.Dates.analyze({
            fromDate: '2026-12-08', toDate: '2026-12-12',
            holidayMode: 'excluded', countWeekend: true, deductsBalance: true,
            holidays: App.Store.get.holidays()
        });
        const b = App.Dates.analyze({
            fromDate: '2026-12-08', toDate: '2026-12-12',
            holidayMode: 'inside', countWeekend: true, deductsBalance: true,
            holidays: App.Store.get.holidays()
        });
        return {
            excluded: [a.calendarDays, a.deductedDays, a.compensatoryDays, a.excludedHolidays.length],
            inside: [b.calendarDays, b.deductedDays, b.compensatoryDays],
            holidayName: a.excludedHolidays[0] ? a.excludedHolidays[0].name : ''
        };
    });
    check('excluded mode: 5 calendar / 4 deducted / 1 compensatory',
        holidayCalc.excluded.join('/') === '5/4/1/1', holidayCalc.excluded.join('/'));
    check('inside mode: 5 calendar / 5 deducted / 0 compensatory',
        holidayCalc.inside.join('/') === '5/5/0', holidayCalc.inside.join('/'));
    check('holiday identified by name', holidayCalc.holidayName.length > 2, holidayCalc.holidayName);

    /* add a leave spanning the holiday -> compensation ledger must be created */
    await page.evaluate(() => App.App.showTab('entry'));
    await addLeave({
        name: 'م.م مروة جاسم محمد', title: 'ممرض جامعي', dept: 'شعبة الطوارئ',
        typeText: 'اعتيادية', from: '2026-12-08', to: '2026-12-12', notes: 'يشمل عطلة رسمية'
    });
    await new Promise(r => setTimeout(r, 900));

    state = await page.evaluate(() => {
        const l = App.Store.get.leaves().find(x => x.empName.includes('مروة'));
        return {
            leaves: App.Store.get.leaves().length,
            deducted: l && l.deductedDays,
            comp: l && l.compensatoryDays,
            compEntries: App.Store.get.compensations().length,
            openComp: l ? App.Store.openCompensations(l.empId) : -1,
            note: l && l.holidayNote
        };
    });
    check('holiday-spanning leave saved', state.leaves === 2, 'leaves=' + state.leaves);
    check('leave deducted only chargeable days', state.deducted === 4, state.deducted);
    check('compensatory day recorded on leave', state.comp === 1, state.comp);
    check('compensation ledger entry created', state.compEntries === 1, state.compEntries);
    check('open compensation balance per employee', state.openComp === 1, state.openComp);
    check('automatic holiday note written', !!state.note, state.note);

    /* ---------- Phase E: tabs + charts + screenshots ---------- */
    await page.evaluate(() => App.App.showTab('dashboard'));
    await new Promise(r => setTimeout(r, 400));
    const focusedMonth = await page.evaluate(() => ({
        mode: document.getElementById('dashPeriodMode').value,
        date: document.getElementById('dashboardFilterDate').value,
        rows: document.querySelectorAll('#dashboardTableBody tr').length
    }));
    check('dashboard auto-focused the saved record month', focusedMonth.mode === 'month' && focusedMonth.date.startsWith('2026-12'),
        focusedMonth.mode + ' ' + focusedMonth.date);
    check('focused month shows the record', focusedMonth.rows === 1, focusedMonth.rows);

    /* switch to "all records" to see both */
    await page.evaluate(() => {
        const m = document.getElementById('dashPeriodMode');
        m.value = 'all';
        m.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));
    const dashRows = await page.evaluate(() => document.querySelectorAll('#dashboardTableBody tr').length);
    check('dashboard lists both records in "all" mode', dashRows === 2, dashRows);
    await page.screenshot({ path: path.join(SHOTS, '03-dashboard-filled.png') });

    /* sorting */
    await page.evaluate(() => document.querySelector('th[data-sort="empName"]').click());
    await new Promise(r => setTimeout(r, 300));
    const sorted = await page.evaluate(() => {
        const first = document.querySelector('#dashboardTableBody tr td:nth-child(2)');
        return { first: first ? first.textContent.trim() : '', icon: !!document.querySelector('th[data-sort="empName"] .fa-sort-up, th[data-sort="empName"] .fa-sort-down') };
    });
    check('sorting by name works', sorted.icon, sorted.first);

    /* analytics tab -> charts must render */
    await page.evaluate(() => App.App.showTab('analytics'));
    await new Promise(r => setTimeout(r, 1200));
    const charts = await page.evaluate(() => ({
        chartLib: typeof window.Chart !== 'undefined',
        kpiTotal: document.getElementById('kpiTotal').textContent.trim(),
        canvases: ['chartByDept', 'chartByType', 'chartTrend', 'chartTopEmp']
            .map(id => { const c = document.getElementById(id); return c ? c.width + 'x' + c.height : 'missing'; })
    }));
    check('Chart.js available locally', charts.chartLib);
    check('analytics KPI computed', charts.kpiTotal !== '' && charts.kpiTotal !== '0', charts.kpiTotal);
    check('all 4 canvases sized (charts drawn)', charts.canvases.every(c => !c.startsWith('missing') && c !== '0x0'), charts.canvases.join(' '));
    await page.screenshot({ path: path.join(SHOTS, '04-analytics.png'), fullPage: true });

    /* reports */
    await page.evaluate(() => App.App.showTab('reports'));
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
        const run = document.getElementById('btnRunReport');
        if (run) run.click();
    });
    await new Promise(r => setTimeout(r, 900));
    const report = await page.evaluate(() => {
        const out = document.getElementById('reportOutput');
        return {
            len: out.innerHTML.length,
            tables: out.querySelectorAll('table').length,
            hasArabicTitle: /تقرير|موقف/.test(out.textContent)
        };
    });
    check('report generated with content', report.len > 500, 'html length=' + report.len);
    check('report contains a table', report.tables >= 1, report.tables);
    check('report has Arabic heading', report.hasArabicTitle);
    await page.screenshot({ path: path.join(SHOTS, '05-reports.png'), fullPage: true });

    /* settings tabs */
    await page.evaluate(() => App.App.showTab('settings'));
    await new Promise(r => setTimeout(r, 400));
    const settingsProbe = await page.evaluate(() => {
        const vis = (panel) => {
            App.Settings.showSubTab(panel);
            const el = document.querySelector('.stab-panel[data-spanel="' + panel + '"]');
            return !!el && !el.classList.contains('hidden');
        };
        const holidayOK = vis('holidays');
        const staffOK = vis('staff');
        const storageOK = vis('storage');
        const typeOK = vis('types');
        return {
            holidayOK, staffOK, storageOK, typeOK,
            staffRows: document.querySelectorAll('#staffList tr').length,
            banner: document.getElementById('storageBannerText').textContent.trim().slice(0, 60)
        };
    });
    check('settings sub-tab switching works',
        settingsProbe.holidayOK && settingsProbe.staffOK && settingsProbe.storageOK && settingsProbe.typeOK,
        [settingsProbe.holidayOK, settingsProbe.staffOK, settingsProbe.storageOK, settingsProbe.typeOK].join(','));
    check('staff directory row rendered', settingsProbe.staffRows === 2, settingsProbe.staffRows);
    check('storage warning banner shown', settingsProbe.banner.length > 10, settingsProbe.banner);
    await page.screenshot({ path: path.join(SHOTS, '06-settings-storage.png'), fullPage: true });

    /* ---------- Phase F: persistence round-trip (reload) ---------- */
    /* نصفّر النموذج حتى لا يعترض تحذير المغادرة عملية إعادة التحميل */
    await page.evaluate(() => { App.App.showTab('entry'); App.Entry.resetForm(); });
    await new Promise(r => setTimeout(r, 300));
    check('form is clean before reload', (await page.evaluate(() => App.Entry.isDirty())) === false);

    await page.reload({ waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 600));
    const after = await page.evaluate(() => ({
        leaves: App.Store.get.leaves().length,
        staff: App.Store.get.staff().length,
        comp: App.Store.get.compensations().length,
        holidayMode: App.Store.get.settings().holidayMode,
        audit: App.Store.get.audit().length,
        rows: document.querySelectorAll('#dashboardTableBody tr').length
    }));
    check('records persisted across reload', after.leaves === 2, 'leaves=' + after.leaves);
    check('staff persisted across reload', after.staff === 2, 'staff=' + after.staff);
    check('compensation persisted across reload', after.comp === 1, after.comp);
    check('settings persisted across reload', after.holidayMode === 'excluded', after.holidayMode);
    check('audit log recorded both inserts', after.audit >= 2, after.audit);

    /* بعد إعادة التحويل يعود الموقف لوضع "اليوم" بلا سجلات — وهذا صحيح */
    const freshDayRows = await page.evaluate(() => document.querySelectorAll('#dashboardTableBody tr').length);
    check('dashboard defaults to today on reload (no rows)', freshDayRows === 0, freshDayRows);
    await page.evaluate(() => {
        const m = document.getElementById('dashPeriodMode');
        m.value = 'all';
        m.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 400));
    const afterAll = await page.evaluate(() => document.querySelectorAll('#dashboardTableBody tr').length);
    check('dashboard renders records in "all" mode after reload', afterAll === 2, afterAll);

    /* ---------- Phase G: XSS safety ---------- */
    const xss = await page.evaluate(async () => {
        /* نتأكد أن الموقف يعرض كل السجلات حتى يكون الفحص ذا معنى */
        const m = document.getElementById('dashPeriodMode');
        m.value = 'all';
        m.dispatchEvent(new Event('change', { bubbles: true }));

        const rec = {
            id: 'xss-test',
            empId: '',
            empName: '<img src=x onerror=window.__XSS=1>',
            jobTitle: '"><script>window.__XSS=2<\/script>',
            dept: 'قسم الباطنية',
            section: '<b>sec</b>',
            leaveTypeId: App.Store.get.leaveTypes()[0].id,
            leaveType: App.Store.get.leaveTypes()[0].name,
            leaveTypeIsHourly: false,
            fromDate: '2026-10-01', toDate: '2026-10-02',
            calendarDays: 2, daysCount: 2, deductedDays: 2, hoursCount: 0,
            compensatoryDays: 0, excludedHolidays: [], notes: '<b>bold</b><img src=x onerror=window.__XSS=3>',
            status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        App.Store.get.leaves().push(rec);
        App.Store.save(['leaves']);
        App.Dashboard.render();
        await new Promise(r => setTimeout(r, 500));

        const body = document.getElementById('dashboardTableBody');
        const rows = body.querySelectorAll('tr').length;
        const txt = body.textContent;

        /* فحص مباشر لدالة التهريب نفسها */
        const probe = App.Security.esc('<img src=x onerror=alert(1)>');

        return {
            rows,
            xssFired: typeof window.__XSS !== 'undefined',
            injectedImg: body.querySelectorAll('img').length,
            injectedScript: body.querySelectorAll('script').length,
            escapedNameShown: txt.includes('<img src=x onerror=window.__XSS=1>'),
            escapedNotesShown: txt.includes('<b>bold</b>'),
            escapedSectionShown: txt.includes('<b>sec</b>'),
            escWorks: probe === '&lt;img src=x onerror=alert(1)&gt;'
        };
    });
    check('xss probe record is rendered (test is meaningful)', xss.rows === 3, 'rows=' + xss.rows);
    check('esc() neutralises markup', xss.escWorks);
    check('no XSS execution from record data', xss.xssFired === false);
    check('no injected <img> element', xss.injectedImg === 0, xss.injectedImg);
    check('no injected <script> element', xss.injectedScript === 0, xss.injectedScript);
    check('malicious name escaped and shown literally', xss.escapedNameShown);
    check('malicious notes escaped literally', xss.escapedNotesShown);
    check('malicious section escaped literally', xss.escapedSectionShown);

    await page.evaluate(() => {
        const i = App.Store.get.leaves().findIndex(l => l.id === 'xss-test');
        if (i > -1) App.Store.get.leaves().splice(i, 1);
        App.Store.save(['leaves']);
    });

    /* ---------- Phase H: entry form screenshot + print layout ---------- */
    await page.evaluate(() => {
        App.App.showTab('entry');
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('entryEmpName', 'أحمد جبار عبد');
        set('entryJobTitle', 'ملاحظ إداري');
        const dept = document.getElementById('entryDept');
        dept.value = 'قسم الخدمات الإدارية';
        dept.dispatchEvent(new Event('change', { bubbles: true }));
        set('entryFromDate', '2026-12-08');
        set('entryToDate', '2026-12-12');
    });
    await new Promise(r => setTimeout(r, 500));
    const entryProbe = await page.evaluate(() => ({
        analysis: document.getElementById('entryAnalysis').textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
        policy: document.getElementById('entryPolicy').textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
        sections: document.querySelectorAll('#entrySection option').length,
        dirty: App.Entry.isDirty(),
        compShown: /تعويضي/.test(document.getElementById('entryAnalysis').textContent)
    }));
    check('live day analysis shown in entry form', entryProbe.analysis.length > 20, entryProbe.analysis.slice(0, 80));
    check('analysis reflects holiday policy (compensatory day)', entryProbe.compShown);
    check('policy panel rendered', entryProbe.policy.length > 20, entryProbe.policy.slice(0, 60));
    check('sections dropdown follows department', entryProbe.sections === 4, entryProbe.sections);
    check('form marked dirty after edits', entryProbe.dirty === true);
    await page.screenshot({ path: path.join(SHOTS, '07-entry-form.png') });

    /* print stylesheet layout */
    await page.evaluate(() => { App.Entry.resetForm(); App.App.showTab('dashboard'); });
    await new Promise(r => setTimeout(r, 300));
    await page.emulateMediaType('print');
    await new Promise(r => setTimeout(r, 400));
    const printProbe = await page.evaluate(() => {
        /* العنصر «مرسوم» فعلاً؟ getClientRects فارغة إذا أخفى أحد الآباء العنصر */
        const rendered = (sel) => {
            const el = document.querySelector(sel);
            return !!el && el.getClientRects().length > 0;
        };
        return {
            headerHidden: !rendered('header'),
            toolbarHidden: !rendered('#view-dashboard .no-print'),
            tableVisible: rendered('#dashboardTable'),
            pagerHidden: !rendered('#pagerControls'),
            actionsColumnHidden: !rendered('#dashboardTableBody td.no-print'),
            footerVisible: rendered('#printFooter')
        };
    });
    check('print: navigation header hidden', printProbe.headerHidden);
    check('print: filter toolbar hidden', printProbe.toolbarHidden);
    check('print: table visible', printProbe.tableVisible);
    check('print: pagination hidden', printProbe.pagerHidden);
    check('print: actions column hidden', printProbe.actionsColumnHidden);
    check('print: repeated footer present', printProbe.footerVisible);

    /* أهم فحص طباعة: ألا يتجاوز المحتوى عرض الصفحة (وإلا تُقتطع أعمدة) */
    const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        const table = document.getElementById('dashboardTable');
        const report = document.getElementById('reportOutput');
        const offenders = [];
        document.querySelectorAll('body *').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            if (r.right > de.clientWidth + 0.5 || r.left < -0.5) {
                offenders.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                    '.' + String(el.className || '').split(' ').slice(0, 2).join('.') +
                    '[l=' + Math.round(r.left) + ',r=' + Math.round(r.right) + ']');
            }
        });
        return {
            docScroll: de.scrollWidth,
            docClient: de.clientWidth,
            tableWidth: Math.round(table.getBoundingClientRect().width),
            reportScroll: report ? report.scrollWidth : 0,
            reportClient: report ? report.clientWidth : 0,
            worst: [].slice.call(document.querySelectorAll('.print-container, .print-table, table'))
                .map(el => Math.round(el.getBoundingClientRect().width))
                .reduce((a, b) => Math.max(a, b), 0),
            offenders: offenders.slice(0, 6)
        };
    });
    check('print: no horizontal overflow of the page',
        overflow.docScroll <= overflow.docClient + 2,
        'scroll=' + overflow.docScroll + ' client=' + overflow.docClient +
        ' widest=' + overflow.worst + ' offenders=' + (overflow.offenders.join(' | ') || 'none'));

    await page.screenshot({ path: path.join(SHOTS, '08-print-layout.png'), fullPage: true });

    /* ---------- Phase H2: real A4 width test ----------
       عرض محتوى A4 = 210mm - 2*8mm = 194mm ≈ 733px عند 96dpi.
       نضبط عرض النافذة على هذا الحد ونتحقق أن الجدول ما زال داخل الصفحة. */
    const A4_CONTENT_PX = 733;
    await page.setViewport({ width: A4_CONTENT_PX, height: 1123 });
    await new Promise(r => setTimeout(r, 500));
    const a4 = await page.evaluate(() => {
        const de = document.documentElement;
        const table = document.getElementById('dashboardTable');
        const cells = [].slice.call(document.querySelectorAll('#dashboardTable thead th'));
        const visible = cells.filter(th => th.getClientRects().length > 0);
        return {
            docScroll: de.scrollWidth,
            docClient: de.clientWidth,
            tableWidth: Math.round(table.getBoundingClientRect().width),
            headerCellsRendered: visible.length,
            visibleHeaders: visible.map(th => th.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
            lastVisibleText: visible.length ? visible[visible.length - 1].textContent.replace(/\s+/g, ' ').trim() : '',
            statusVisible: visible.some(th => th.textContent.indexOf('الحالة') !== -1)
        };
    });
    check('A4 width: no horizontal overflow', a4.docScroll <= a4.docClient + 2,
        'scroll=' + a4.docScroll + ' client=' + a4.docClient);
    check('A4 width: table fits the page', a4.tableWidth <= a4.docClient + 2,
        a4.tableWidth + ' <= ' + a4.docClient);
    /* عمودا «الحالة» و«إجراءات» مستثنيان من الطباعة فيبقى 7 أعمدة */
    check('A4 width: exactly 7 printed header cells', a4.headerCellsRendered === 7,
        a4.headerCellsRendered + ' :: ' + a4.visibleHeaders);
    check('A4 width: last printed column is the notes column', /الملاحظات/.test(a4.lastVisibleText),
        a4.lastVisibleText);
    check('A4 width: status column hidden in print', a4.statusVisible === false);
    await page.screenshot({ path: path.join(SHOTS, '09-print-a4.png'), fullPage: true });

    await page.emulateMediaType(null);
    await page.setViewport({ width: 1600, height: 1000 });
    await new Promise(r => setTimeout(r, 400));

    /* ---------- Phase I: real file exports (Excel + PDF) ---------- */
    const DL = path.join(ROOT, '_downloads');
    fs.rmSync(DL, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

    await page.evaluate(() => App.App.showTab('dashboard'));
    await new Promise(r => setTimeout(r, 400));

    await page.click('#btnDashExcel');
    let excelFile = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 300));
        const files = fs.readdirSync(DL).filter(f => f.endsWith('.xlsx'));
        if (files.length) { excelFile = files[0]; break; }
    }
    check('Excel export produced a real .xlsx file', !!excelFile, excelFile || 'none');
    if (excelFile) {
        const size = fs.statSync(path.join(DL, excelFile)).size;
        check('Excel file is non-trivial in size', size > 3000, size + ' bytes');
    }

    await page.evaluate(() => {
        const list = document.getElementById('reportMode');
        if (list) { list.value = 'employee'; list.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.evaluate(() => {
        App.App.showTab('reports');
        const b = document.getElementById('btnRunReport');
        if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 900));
    await page.click('#btnReportPdf');
    let pdfFile = null;
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const files = fs.readdirSync(DL).filter(f => f.endsWith('.pdf'));
        if (files.length) { pdfFile = files[0]; break; }
    }
    check('PDF export produced a real .pdf file', !!pdfFile, pdfFile || 'none');
    if (pdfFile) {
        const size = fs.statSync(path.join(DL, pdfFile)).size;
        check('PDF file is non-trivial in size', size > 10000, size + ' bytes');
    }

    /* نُنظّف ملفات الاختبار حتى لا تبقى في المستودع */
    fs.rmSync(DL, { recursive: true, force: true });

    /* ---------- Phase J: file storage layer (real filesystem I/O) ----------
       showDirectoryPicker يطلب نقرة مستخدم لا يمكن محاكاتها، لكن OPFS تُرجع
       FileSystemDirectoryHandle بنفس المواصفة، فنستعملها لاختبار طبقة المجلد
       والملفات والنسخ الاحتياطية اختباراً حقيقياً.
       OPFS محجوب على file:// لذا نشغّل خادماً محلياً مؤقتاً لهذه المرحلة. */
    const storageTest = await (async () => {
        const { server, port } = await startStaticServer();
        const p2 = await browser.newPage();
        await p2.setViewport({ width: 1400, height: 900 });
        const errs = [];
        p2.on('pageerror', (e) => errs.push(e.message));
        p2.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

        await p2.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
        await p2.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });
        const served = await p2.evaluate(() => ({
            modules: typeof App.Dashboard !== 'undefined' && typeof App.Reports !== 'undefined',
            typeRows: document.querySelectorAll('#typeList > div').length,
            backend: App.Store.backend()
        }));
        check('app also boots when served over http://', served.modules && served.typeRows > 0,
            'types=' + served.typeRows + ' backend=' + served.backend);

        const result = await p2.evaluate(async () => {
            const out = { steps: [] };
            const log = (s, v) => out.steps.push(s + '=' + v);

            try {
                const root = await navigator.storage.getDirectory();
                log('opfsRoot', !!root);

                /* نوجّه منتقي المجلد إلى جذر OPFS بدل نافذة المستخدم */
                App.FSA.pickDirectory = async () => root;
                App.FSA.supported = () => true;

            const name = await App.Store.connectFolder();
            log('connected', App.Store.isConnected());
            log('folderName', name);

            /* الملفات المتوقعة بعد الربط */
            const read = async (dir, file) => {
                try {
                    const fh = await dir.getFileHandle(file, { create: false });
                    return await (await fh.getFile()).text();
                } catch (e) { return null; }
            };

            /* نسرد ملفات الجذر للتشخيص */
            const rootFiles = [];
            for await (const [n, h] of root.entries()) {
                if (h.kind === 'file') rootFiles.push(n);
            }
            log('rootFiles', rootFiles.sort().join('|'));

            const settingsTxt = await read(root, 'settings.json');
            log('settings.json', settingsTxt ? 'ok(' + settingsTxt.length + ')' : 'MISSING');
            if (settingsTxt) {
                const s = JSON.parse(settingsTxt);
                log('settingsParsed', !!s.hospital && s.hospital.length > 2);
            }

            const typesTxt = await read(root, 'leave-types.json');
            log('leave-types.json', typesTxt ? 'ok' : 'MISSING');
            const deptsTxt = await read(root, 'departments.json');
            log('departments.json', deptsTxt ? 'ok' : 'MISSING');
            const holidaysTxt = await read(root, 'holidays.json');
            log('holidays.json', holidaysTxt ? 'ok' : 'MISSING');
            const indexTxt = await read(root, 'leaves-index.json');
            log('leaves-index.json', indexTxt || 'MISSING');

            const leavesDir = await root.getDirectoryHandle('leaves', { create: false });
            const yearFiles = [];
            for await (const [n, h] of leavesDir.entries()) {
                if (h.kind === 'file') yearFiles.push(n);
            }
            log('yearFiles', yearFiles.sort().join('|'));

            const y2026 = await read(leavesDir, 'leaves-2026.json');
            if (y2026) {
                const arr = JSON.parse(y2026);
                log('leaves-2026.count', arr.length);
                log('leaves-2026.firstHasFields',
                    !!(arr[0] && arr[0].empName && arr[0].fromDate && arr[0].deductedDays !== undefined));
            } else {
                log('leaves-2026.count', 'MISSING');
            }

            /* مجلد النسخ الاحتياطية */
            const backupsDir = await root.getDirectoryHandle('backups', { create: false });
            const backups = [];
            for await (const [n, h] of backupsDir.entries()) {
                if (h.kind === 'file') backups.push(n);
            }
            log('backups', backups.length);
            log('backupShape', backups.every(b => /^snapshot-\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(b)));
            log('backupListExcludesPrev', !backups.some(b => /\.prev\.json$/.test(b)));
            if (backups.length) {
                const b = JSON.parse(await read(backupsDir, backups.filter(x => !/\.prev\.json$/.test(x))[0]));
                log('backupFormat', b._format + '/' + b._version);
                log('backupHasLeaves', Array.isArray(b.leaves) ? b.leaves.length : 'no');
            }

            /* الكتابة التلقائية بعد إضافة سجل جديد */
            const t = App.Store.get.leaveTypes()[0];
            App.Store.get.leaves().push({
                id: 'file-test', empId: '', empName: 'اختبار الملف', jobTitle: 'فني',
                dept: 'شعبة الطوارئ', section: '', leaveTypeId: t.id, leaveType: t.name,
                leaveTypeIsHourly: false, fromDate: '2026-11-02', toDate: '2026-11-03',
                calendarDays: 2, daysCount: 2, deductedDays: 2, hoursCount: 0,
                compensatoryDays: 0, excludedHolidays: [], notes: '',
                status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
            App.Store.save(['leaves']);
            await App.Store.flush();   /* كتابة فورية بلا انتظار المؤقت */

            const y2026b = JSON.parse(await read(leavesDir, 'leaves-2026.json'));
            log('afterSave.count', y2026b.length);
            log('afterSave.hasNewRecord', y2026b.some(r => r.id === 'file-test'));
            log('recordFieldsPersisted',
                !!(y2026b[0] && y2026b[0].empName && y2026b[0].fromDate &&
                   y2026b[0].deductedDays !== undefined && y2026b[0].leaveType &&
                   y2026b[0].status && y2026b[0].calendarDays !== undefined));

            /* تدوير النسخة السابقة .prev — يحتاج كتابة ثانية */
            const rec = App.Store.get.leaves().find(r => r.id === 'file-test');
            if (rec) rec.notes = 'edit-2';
            App.Store.save(['leaves']);
            await App.Store.flush();
            const prevTxt = await read(leavesDir, 'leaves-2026.prev.json');
            log('prevBackupExists', !!prevTxt);
            log('afterSecondSave.count', JSON.parse(await read(leavesDir, 'leaves-2026.json')).length);

            /* نسخة احتياطية إضافية + التحقق من عدم تجاوز الحد */
            await App.Store.writeBackup('test');
            const backups2 = [];
            for await (const [n, h] of backupsDir.entries()) {
                if (h.kind === 'file') backups2.push(n);
            }
            log('backupsAfterSecond', backups2.length);
            const snapshots = backups2.filter(x => !/\.prev\.json$/.test(x)).sort();
            const newest = snapshots[snapshots.length - 1];
            const newestObj = JSON.parse(await read(backupsDir, newest));
            log('backupLeavesAfter', Array.isArray(newestObj.leaves) ? newestObj.leaves.length : 'no');

            /* قراءة المجلد كاملاً كما يفعل الاستيراد */
            const readBack = await App.Store.readFromFolder(root);
            log('readFromFolder.keys', Object.keys(readBack).sort().join(','));
            log('readFromFolder.leaves', readBack.leaves ? readBack.leaves.length : 'none');

            /* استعادة نسخة احتياطية فعلياً */
            const fileToRestore = backups2.sort().reverse()[0];
            App.Store.get.leaves().push({
                id: 'to-be-lost', empName: 'سجل سيُمحى', jobTitle: '', dept: '', section: '',
                leaveTypeId: t.id, leaveType: t.name, leaveTypeIsHourly: false,
                fromDate: '2026-11-05', toDate: '2026-11-05', calendarDays: 1, daysCount: 1,
                deductedDays: 1, hoursCount: 0, compensatoryDays: 0, excludedHolidays: [],
                notes: '', status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
            log('beforeRestore.hasExtra', App.Store.get.leaves().some(r => r.id === 'to-be-lost'));
            await App.Store.restoreBackup(fileToRestore);
            log('afterRestore.hasExtra', App.Store.get.leaves().some(r => r.id === 'to-be-lost'));
            log('afterRestore.count', App.Store.get.leaves().length);
        } catch (e) {
            log('EXCEPTION', e && e.message ? e.message : String(e));
        }
        return out;
        });

        await p2.close();
        server.close();
        result.httpErrors = errs;
        return result;
    })();

    const st = {};
    storageTest.steps.forEach(s => { const i = s.indexOf('='); st[s.slice(0, i)] = s.slice(i + 1); });
    console.log('--- storage steps ---');
    storageTest.steps.forEach(s => console.log('    ' + s));

    check('storage: folder connected', st.connected === 'true');
    check('storage: settings.json written', st['settings.json'] && st['settings.json'].startsWith('ok'), st['settings.json']);
    check('storage: settings.json content valid', st.settingsParsed === 'true');
    check('storage: leave-types.json written', st['leave-types.json'] === 'ok');
    check('storage: departments.json written', st['departments.json'] === 'ok');
    check('storage: holidays.json written', st['holidays.json'] === 'ok');
    check('storage: initial backup created', parseInt(st.backups, 10) >= 1, st.backups);
    check('storage: backup file naming correct', st.backupShape === 'true');
    check('storage: backup format is versioned', st.backupFormat === 'admh-leaves-backup/2', st.backupFormat);
    check('storage: backup list excludes internal .prev files', st.backupListExcludesPrev === 'true');
    check('storage: folder manifest written', /_معلومات-المجلد\.json/.test(st.rootFiles || ''), st.rootFiles);
    check('storage: empty start writes no year file', st.yearFiles === '' && st['leaves-2026.count'] === 'MISSING',
        'yearFiles="' + st.yearFiles + '" count=' + st['leaves-2026.count']);
    check('storage: record written to year file', st['afterSave.count'] === '1', st['afterSave.count']);
    check('storage: auto-write reached disk with new record', st['afterSave.hasNewRecord'] === 'true');
    check('storage: all record fields persisted', st.recordFieldsPersisted === 'true');
    check('storage: second save keeps one record', st['afterSecondSave.count'] === '1', st['afterSecondSave.count']);
    check('storage: previous file rotated to .prev', st.prevBackupExists === 'true');
    check('storage: second backup written', parseInt(st.backupsAfterSecond, 10) >= 2, st.backupsAfterSecond);
    check('storage: backup now contains the record', st.backupLeavesAfter === '1', st.backupLeavesAfter);
    check('storage: readFromFolder returns all 8 docs',
        st['readFromFolder.keys'] === 'audit,compensations,departments,holidays,leaveTypes,leaves,settings,staff',
        st['readFromFolder.keys']);
    check('storage: readFromFolder restores leaves', st['readFromFolder.leaves'] === '1', st['readFromFolder.leaves']);
    check('storage: extra record present before restore', st['beforeRestore.hasExtra'] === 'true');
    check('storage: restore reverted to snapshot', st['afterRestore.hasExtra'] === 'false', st['afterRestore.count']);
    check('storage: snapshot was the empty state', st['afterRestore.count'] === '0', st['afterRestore.count']);
    check('storage: no exception during file tests', !st.EXCEPTION, st.EXCEPTION || 'none');
    check('storage: no page errors while served over http', storageTest.httpErrors.length === 0,
        storageTest.httpErrors.slice(0, 2).join(' || '));

    /* نُعيد النظام لحالة نظيفة قبل فحص الأخطاء النهائي */
    await page.evaluate(async () => {
        App.Store.disconnectFolder();
        await App.Store.factoryReset();
    });
    await new Promise(r => setTimeout(r, 600));

    /* ---------- Phase K: legacy data migration ----------
       أهم مسار لحماية بيانات المستخدم: الترقية من النسخة القديمة
       (مفاتيح hosp_leave_*_v3 وملفات JSON القديمة) دون فقدان أي سجل. */
    const p3 = await browser.newPage();
    await p3.setViewport({ width: 1400, height: 900 });
    const migErrors = [];
    p3.on('pageerror', (e) => migErrors.push(e.message));
    p3.on('console', (m) => { if (m.type() === 'error') migErrors.push('console: ' + m.text()); });
    p3.on('dialog', async (d) => { await d.accept(); });

    await p3.goto(APP_URL, { waitUntil: 'load' });
    await p3.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });

    await p3.evaluate(async () => {
        await App.IDB.clear();
        localStorage.setItem('hosp_leave_settings_v3', JSON.stringify({
            ministry: 'وزارة الصحة', directorate: 'دائرة صحة اختبار',
            hospital: 'مستشفى الاختبار التعليمي', departmentUnit: 'شعبة الموارد البشرية',
            footerHR: 'مسؤول الموارد البشرية', footerManager: 'مدير المستشفى', logoBase64: ''
        }));
        localStorage.setItem('hosp_leave_types_v3', JSON.stringify(['إجازة اعتيادية', 'إجازة زمنية', 'إجازة مرضية']));
        localStorage.setItem('hosp_leave_depts_v3', JSON.stringify([
            { name: 'قسم الباطنية', sections: ['شعبة أ', 'شعبة ب'] },
            { name: 'شعبة الطوارئ', sections: [] }
        ]));
        localStorage.setItem('hosp_leave_staff_v3', JSON.stringify([
            { name: 'د. علي حسين كاظم', jobTitle: 'طبيب اختصاص', dept: 'قسم الباطنية' }
        ]));
        localStorage.setItem('hosp_leave_records_v3', JSON.stringify([
            {
                id: '1', empName: 'د. علي حسين كاظم', jobTitle: 'طبيب اختصاص', dept: 'قسم الباطنية',
                section: 'شعبة أ', leaveType: 'إجازة اعتيادية', fromDate: '2026-09-01', toDate: '2026-09-03',
                daysCount: 3, hoursCount: '', fromTime: '', toTime: '', notes: 'سجل مُرحَّل'
            },
            {
                id: '2', empName: 'م.م مروة جاسم', jobTitle: 'ممرض', dept: 'شعبة الطوارئ',
                section: '', leaveType: 'إجازة زمنية', fromDate: '2026-09-05', toDate: '2026-09-05',
                daysCount: '', hoursCount: 3, fromTime: '09:00', toTime: '12:00', notes: ''
            }
        ]));
    });

    await p3.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await p3.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 600));

    const mig = await p3.evaluate(() => {
        const leaves = App.Store.get.leaves();
        const types = App.Store.get.leaveTypes();
        const depts = App.Store.get.departments();
        const annual = leaves.find(l => l.id === '1');
        const hourly = leaves.find(l => l.id === '2');
        const annualType = types.find(t => /اعتيادية/.test(t.name));
        const hourlyType = types.find(t => /زمنية/.test(t.name));
        return {
            leaves: leaves.length,
            staff: App.Store.get.staff().length,
            types: types.length,
            typesAreObjects: types.every(t => t && typeof t === 'object' && !!t.id && !!t.name),
            annualIsHourly: annualType ? annualType.isHourly : null,
            annualDeducts: annualType ? annualType.deductsBalance : null,
            hourlyIsHourly: hourlyType ? hourlyType.isHourly : null,
            depts: depts.length,
            sectionsAreObjects: depts[0] && Array.isArray(depts[0].sections) &&
                depts[0].sections.every(s => s && typeof s === 'object' && !!s.id && !!s.name),
            sectionNames: depts[0] ? depts[0].sections.map(s => s.name).join('|') : '',
            hospital: App.Store.get.settings().hospital,
            annualDays: annual ? annual.deductedDays : null,
            annualNotes: annual ? annual.notes : '',
            annualTypeLinked: annual ? !!annual.leaveTypeId : false,
            annualTypeMatches: annual && annualType ? annual.leaveTypeId === annualType.id : false,
            annualEmpLinked: annual ? !!annual.empId : false,
            hourlyHours: hourly ? hourly.hoursCount : null,
            hourlyFlag: hourly ? !!hourly.leaveTypeIsHourly : null,
            hourlyDays: hourly ? hourly.deductedDays : null,
            rowsRendered: document.querySelectorAll('#staffList tr').length
        };
    });

    check('migration: both legacy records imported', mig.leaves === 2, mig.leaves);
    check('migration: legacy employee imported', mig.staff === 1, mig.staff);
    check('migration: legacy leave types became objects', mig.typesAreObjects, mig.types);
    check('migration: hourly type flag recovered', mig.hourlyIsHourly === true && mig.annualIsHourly === false);
    check('migration: balance-deduction flag recovered', mig.annualDeducts === true);
    check('migration: departments normalised', mig.depts === 2, mig.depts);
    check('migration: sections became objects with names', mig.sectionsAreObjects && mig.sectionNames === 'شعبة أ|شعبة ب', mig.sectionNames);
    check('migration: settings preserved', mig.hospital === 'مستشفى الاختبار التعليمي', mig.hospital);
    check('migration: calendar days preserved as deducted', mig.annualDays === 3, mig.annualDays);
    check('migration: notes preserved', mig.annualNotes === 'سجل مُرحَّل', mig.annualNotes);
    check('migration: record relinked to a leave type', mig.annualTypeLinked && mig.annualTypeMatches);
    check('migration: record relinked to an employee', mig.annualEmpLinked);
    check('migration: hourly record kept its hours', mig.hourlyHours === 3 && mig.hourlyFlag === true);
    check('migration: hourly record deducts no balance', mig.hourlyDays === 0, mig.hourlyDays);
    check('migration: interface rendered imported staff', mig.rowsRendered === 1, mig.rowsRendered);

    /* توافق ملفات النسخة الاحتياطية القديمة (أسماء الحقول القديمة) */
    const legacyImport = await p3.evaluate(async () => {
        await App.Store.importFromObject({
            settings: { hospital: 'مستشفى الاستيراد' },
            departments: [{ name: 'قسم الجراحة', sections: ['شعبة الجراحة'] }],
            staffList: [{ name: 'موظف مستورد', jobTitle: 'فني', dept: 'قسم الجراحة' }],
            leaveTypes: ['إجازة اعتيادية'],
            leavesList: [{
                id: 'L1', empName: 'موظف مستورد', jobTitle: 'فني', dept: 'قسم الجراحة',
                section: 'شعبة الجراحة', leaveType: 'إجازة اعتيادية',
                fromDate: '2026-08-01', toDate: '2026-08-02', daysCount: 2, notes: ''
            }]
        });
        const l = App.Store.get.leaves()[0];
        return {
            leaves: App.Store.get.leaves().length,
            hospital: App.Store.get.settings().hospital,
            staff: App.Store.get.staff().length,
            typeLinked: !!l.leaveTypeId,
            empLinked: !!l.empId,
            days: l.deductedDays
        };
    });
    check('legacy JSON import: old field names accepted', legacyImport.leaves === 1 && legacyImport.hospital === 'مستشفى الاستيراد',
        'leaves=' + legacyImport.leaves + ' hospital=' + legacyImport.hospital);
    check('legacy JSON import: staff + links rebuilt',
        legacyImport.staff === 1 && legacyImport.typeLinked && legacyImport.empLinked);
    check('legacy JSON import: days preserved', legacyImport.days === 2, legacyImport.days);
    check('migration: no console/page errors during migration', migErrors.length === 0, migErrors.slice(0, 2).join(' || '));

    await p3.close();

    /* ---------- Phase L: acceptance tests for the 11 reported issues ----------
       تغطي: صيغ التاريخ، حذف عمود الحالة، تنسيق الأعمدة، ترتيب التوقيعات،
       التذييل الثابت، ترقيم الصفحات، حجم الملاحظات، أعمدة التقرير الشامل،
       إخفاء أيقونات الفرز، وربط الرصيد السنوي الافتراضي. */
    const p4 = await browser.newPage();
    await p4.setViewport({ width: 1500, height: 950 });
    const reqErrors = [];
    p4.on('pageerror', (e) => reqErrors.push(e.message));
    p4.on('console', (m) => { if (m.type() === 'error') reqErrors.push('console: ' + m.text()); });
    p4.on('dialog', async (d) => { await d.accept(); });

    const DL2 = path.join(ROOT, '_downloads_req');
    fs.rmSync(DL2, { recursive: true, force: true });
    fs.mkdirSync(DL2, { recursive: true });
    const cdp2 = await p4.createCDPSession();
    await cdp2.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL2, eventsEnabled: true });

    await p4.goto(APP_URL, { waitUntil: 'load' });
    await p4.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 20000 });
    await p4.evaluate(async () => {
        await App.Store.factoryReset();
        const types = App.Store.get.leaveTypes();
        const annual = types.find(t => /اعتيادية/.test(t.name));
        const sick = types.find(t => /مرضية/.test(t.name));
        const hourly = types.find(t => /زمنية/.test(t.name));

        const mk = (o) => Object.assign({
            empId: '', section: '', fromTime: '', toTime: '', hoursCount: 0,
            compensatoryDays: 0, excludedHolidays: [], status: 'approved',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }, o);

        App.Store.get.leaves().push(
            mk({
                id: 'L1', empName: 'د. علي حسين كاظم', jobTitle: 'طبيب اختصاص باطنية',
                dept: 'قسم الباطنية', section: 'شعبة الباطنية أ',
                leaveTypeId: annual.id, leaveType: annual.name, leaveTypeIsHourly: false,
                fromDate: '2026-10-05', toDate: '2026-10-08',
                calendarDays: 4, daysCount: 4, deductedDays: 4, notes: 'ظرف عائلي طارئ'
            }),
            mk({
                id: 'L2', empName: 'م.م مروة جاسم محمد', jobTitle: 'ممرض جامعي',
                dept: 'شعبة الطوارئ', section: 'وحدة الإنعاش',
                leaveTypeId: sick.id, leaveType: sick.name, leaveTypeIsHourly: false,
                fromDate: '2026-10-06', toDate: '2026-10-07',
                calendarDays: 2, daysCount: 2, deductedDays: 2, notes: 'تقرير طبي'
            }),
            mk({
                id: 'L3', empName: 'أحمد جبار عبد', jobTitle: 'ملاحظ إداري',
                dept: 'قسم الخدمات الإدارية', section: 'شعبة الموارد البشرية',
                leaveTypeId: hourly.id, leaveType: hourly.name, leaveTypeIsHourly: true,
                fromDate: '2026-10-07', toDate: '2026-10-07',
                calendarDays: 1, daysCount: 0, deductedDays: 0, hoursCount: 3,
                fromTime: '09:00', toTime: '12:00', notes: 'مراجعة دائرة رسمية'
            })
        );

        App.Store.get.staff().push(
            { id: 'E1', name: 'د. علي حسين كاظم', jobTitle: 'طبيب اختصاص باطنية', dept: 'قسم الباطنية', section: 'شعبة الباطنية أ', employeeNumber: '', annualBalance: 21, isActive: true },
            { id: 'E2', name: 'م.م مروة جاسم محمد', jobTitle: 'ممرض جامعي', dept: 'شعبة الطوارئ', section: 'وحدة الإنعاش', employeeNumber: '', annualBalance: 21, isActive: true }
        );
        App.Store.get.leaves()[0].empId = 'E1';
        App.Store.get.leaves()[1].empId = 'E2';

        App.Store.save(['leaves', 'staff']);
        App.App.showTab('dashboard');
        document.getElementById('dashPeriodMode').value = 'all';
        document.getElementById('dashPeriodMode').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 700));

    /* --- Issue 1 + 2: date under the title and the issue date --- */
    const headerDates = await p4.evaluate(() => {
        const mode = document.getElementById('dashPeriodMode');
        const date = document.getElementById('dashboardFilterDate');
        mode.value = 'day';
        date.value = '2026-10-05';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        date.dispatchEvent(new Event('change', { bubbles: true }));
        return {
            rptDate: document.getElementById('rptDate').textContent.trim(),
            created: document.getElementById('rptCreatedDate').textContent.trim()
        };
    });
    check('issue 1: date under the title is "dd/mm/yyyy يوم <اليوم>"',
        /^\d{2}\/\d{2}\/\d{4} يوم \S+/.test(headerDates.rptDate), headerDates.rptDate);
    check('issue 2: issue date is short dd/mm/yyyy',
        /^\d{2}\/\d{2}\/\d{4}$/.test(headerDates.created), headerDates.created);

    const rangeDate = await p4.evaluate(() => {
        const mode = document.getElementById('dashPeriodMode');
        mode.value = 'range';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('dashFromDate').value = '2026-10-05';
        document.getElementById('dashToDate').value = '2026-10-08';
        document.getElementById('dashToDate').dispatchEvent(new Event('change', { bubbles: true }));
        return document.getElementById('rptDate').textContent.trim();
    });
    check('issue 1: range mode shows dd/mm/yyyy range',
        /من \d{2}\/\d{2}\/\d{4} إلى \d{2}\/\d{2}\/\d{4}/.test(rangeDate) && !/\d{4}-\d{2}-\d{2}/.test(rangeDate), rangeDate);

    /* --- Issue 3 + 4 + 8 + 10: table structure --- */
    await p4.evaluate(() => {
        const mode = document.getElementById('dashPeriodMode');
        mode.value = 'all';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));

    const cells = await p4.evaluate(() => {
        const ths = [].slice.call(document.querySelectorAll('#dashboardTable thead th'));
        const statusTh = ths.find(t => t.textContent.indexOf('الحالة') !== -1);
        const row = document.querySelector('#dashboardTableBody tr');
        const tds = [].slice.call(row.children);
        const notesTd = tds[6];
        return {
            statusThClass: statusTh ? statusTh.className : 'MISSING',
            statusTdClass: tds[7] ? tds[7].className : 'MISSING',
            nameClass: tds[1].className,
            jobClass: tds[2].className,
            deptHtml: tds[3].innerHTML,
            notesClass: notesTd.className,
            rowText: row.textContent.replace(/\s+/g, ' ').trim(),
            bodyText: document.getElementById('dashboardTableBody').textContent.replace(/\s+/g, ' ').trim(),
            sortIconsNoPrint: document.querySelectorAll('#dashboardTable thead i.no-print').length,
            sortIconsTotal: document.querySelectorAll('#dashboardTable thead i[class*="fa-sort"]').length
        };
    });
    check('issue 3: status header is excluded from print/export',
        /no-print/.test(cells.statusThClass) && /no-export/.test(cells.statusThClass), cells.statusThClass);
    check('issue 3: status cell is excluded from print/export',
        /no-print/.test(cells.statusTdClass) && /no-export/.test(cells.statusTdClass), cells.statusTdClass);
    check('issue 4: employee name kept on one line (p-name)', /p-name/.test(cells.nameClass), cells.nameClass);
    check('issue 4: job title clamped to two lines (p-job)', /p-job/.test(cells.jobClass), cells.jobClass);
    check('issue 4: department bold with section underneath',
        /p-dept-name/.test(cells.deptHtml) && /p-dept-section/.test(cells.deptHtml),
        cells.deptHtml.replace(/\s+/g, ' ').slice(0, 120));
    check('issue 8: notes cell uses the small class (p-notes)', /p-notes/.test(cells.notesClass), cells.notesClass);
    /* الصف الأول قد يكون إجازة زمنية بلا تواريخ، لذا نفحص كل صفوف الجدول:
       يجب أن توجد صيغة dd/mm/yyyy وألّا توجد أي صيغة ISO. */
    check('issue 2: table dates are dd/mm/yyyy',
        /\d{2}\/\d{2}\/\d{4}/.test(cells.bodyText) && !/\d{4}-\d{2}-\d{2}/.test(cells.bodyText),
        cells.bodyText.slice(0, 110));
    check('issue 10: every sort arrow is marked no-print',
        cells.sortIconsTotal > 0 && cells.sortIconsNoPrint === cells.sortIconsTotal,
        cells.sortIconsNoPrint + '/' + cells.sortIconsTotal);

    /* --- Issue 5: signature order on screen and in print --- */
    const sig = await p4.evaluate(() => {
        const hr = document.getElementById('rptFooterHR').closest('.signature-block');
        const mg = document.getElementById('rptFooterManager').closest('.signature-block');
        const a = hr.getBoundingClientRect(), b = mg.getBoundingClientRect();
        return {
            hrClass: hr.className, mgClass: mg.className,
            hrLeft: Math.round(a.left), mgLeft: Math.round(b.left),
            sameRow: Math.abs(a.top - b.top) < 5
        };
    });
    check('issue 5: HR signature sits to the right of the manager signature',
        sig.hrLeft > sig.mgLeft && sig.sameRow,
        'hr.left=' + sig.hrLeft + ' manager.left=' + sig.mgLeft);
    check('issue 5: signature layout uses floats (safe for html2canvas)',
        /signature-right/.test(sig.hrClass) && /signature-left/.test(sig.mgClass),
        sig.hrClass + ' / ' + sig.mgClass);

    /* --- Issues 6 + 7 + 8 + 10: the generated A4 pages --- */
    const pages = await p4.evaluate(async () => {
        const host = document.getElementById('printHost');
        const res = await App.PrintLayout.paginate(document.getElementById('printableArea'));
        const first = res.pages[0];
        const last = res.pages[res.pages.length - 1];
        const notes = first.querySelector('.p-notes');
        const onScreenNotes = document.querySelector('#dashboardTableBody .p-notes');
        const out = {
            total: res.total,
            pageWidth: first.getBoundingClientRect().width,
            pageHeight: first.getBoundingClientRect().height,
            credit: (first.querySelector('.pf-credit') || {}).textContent || '',
            page1: (first.querySelector('.pf-pageno') || {}).textContent || '',
            lastPage: (last.querySelector('.pf-pageno') || {}).textContent || '',
            noPrintLeft: first.querySelectorAll('.no-print').length,
            statusChips: first.querySelectorAll('.status-chip').length,
            statusHeaderCells: [].slice.call(first.querySelectorAll('th')).filter(function (th) { return th.textContent.indexOf('الحالة') !== -1; }).length,
            sortIcons: first.querySelectorAll('i[class*="fa-sort"]').length,
            headerRepeated: res.pages.every(p => p.textContent.indexOf('وزارة الصحة') !== -1),
            rowsOnPage1: first.querySelectorAll('tbody tr').length,
            rowsPerPage: res.pages.map(p => p.querySelectorAll('tbody tr').length),
            rowsTotal: res.pages.reduce((s, p) => s + p.querySelectorAll('tbody tr').length, 0),
            bodyOverflow: res.pages.map(p => {
                const body = p.querySelector('.print-page-body');
                if (!body) return 0;
                const kids = [].slice.call(body.children);
                if (!kids.length) return 0;
                const top = body.getBoundingClientRect().top;
                const bottom = Math.max.apply(null, kids.map(k => k.getBoundingClientRect().bottom));
                return Math.round(bottom - top);
            }),
            notesFontSize: notes ? getComputedStyle(notes).fontSize : 'none',
            screenNotesFontSize: onScreenNotes ? getComputedStyle(onScreenNotes).fontSize : 'none'
        };
        App.PrintLayout.cleanup();
        out.hostCleared = host.children.length === 0;
        return out;
    });
    check('engine: pages generated', pages.total >= 1, pages.total);
    check('engine: page is exactly A4 (794x1123)',
        Math.round(pages.pageWidth) === 794 && Math.round(pages.pageHeight) === 1123,
        pages.pageWidth + 'x' + pages.pageHeight);
    check('issue 6: fixed credit footer inside every page',
        /نظام موقف الإجازات اليومي الموحد/.test(pages.credit) &&
        /احمد زياد رحيمه/.test(pages.credit), pages.credit.slice(0, 70));
    check('issue 6: footer present on every page', pages.headerRepeated && pages.credit.length > 20);
    check('issue 7: page 1 footer reads "الصفحة 1 من N"',
        pages.page1 === 'الصفحة 1 من ' + pages.total, pages.page1);
    check('issue 7: last page footer reads "الصفحة N من N"',
        pages.lastPage === 'الصفحة ' + pages.total + ' من ' + pages.total, pages.lastPage);
    check('issue 3: no status chip survives into the pages', pages.statusChips === 0, pages.statusChips);
    check('issue 3: no status column header in the pages', pages.statusHeaderCells === 0, pages.statusHeaderCells);
    check('issue 10: sort arrows absent from generated pages', pages.sortIcons === 0, pages.sortIcons);
    check('engine: repeated official header on every page', pages.headerRepeated);
    check('engine: table rows rendered on page 1', pages.rowsOnPage1 === 3, pages.rowsOnPage1);
    /* الفحص الأهم: لا يجوز أن يضيع أي صف أثناء التقسيم */
    check('engine: no record lost during pagination (3 in, 3 out)',
        pages.rowsTotal === 3, 'sum=' + pages.rowsTotal + ' perPage=[' + pages.rowsPerPage.join(',') + ']');
    check('engine: no .no-print nodes survive pagination', pages.noPrintLeft === 0, pages.noPrintLeft);
    check('engine: cleanup empties the host', pages.hostCleared === true);
    check('issue 8: notes font is smaller inside the printed page',
        parseFloat(pages.notesFontSize) < parseFloat(pages.screenNotesFontSize),
        pages.notesFontSize + ' < ' + pages.screenNotesFontSize);

    /* --- لقطة بصرية لصفحة A4 مولّدة: تحقق بشري من التنسيق --- */
    await p4.evaluate(async () => {
        document.body.classList.add('print-capturing');
        await App.PrintLayout.paginate(document.getElementById('printableArea'));
    });
    await new Promise(r => setTimeout(r, 500));
    const pageShot = await p4.$('#printHost .print-page');
    check('engine: a generated A4 page exists for screenshot', !!pageShot);
    if (pageShot) await pageShot.screenshot({ path: path.join(SHOTS, '10-print-page.png') });
    await p4.evaluate(() => { App.PrintLayout.cleanup(); });
    await new Promise(r => setTimeout(r, 300));

    /* --- Issue 7 + 6 in the real PDF file --- */
    const pdfRes = await p4.evaluate(async () => {
        const res = await App.PrintLayout.toPdf(document.getElementById('printableArea'), 'req-test.pdf');
        App.PrintLayout.cleanup();
        return { pages: res.pages };
    });
    let reqPdf = null;
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const files = fs.readdirSync(DL2).filter(f => f.endsWith('.pdf'));
        if (files.length) { reqPdf = files[0]; break; }
    }
    check('engine: PDF produced by the paginated path', !!reqPdf, reqPdf || 'none');
    check('engine: PDF page count matches the pagination', pdfRes.pages === pages.total,
        pdfRes.pages + ' vs ' + pages.total);
    if (reqPdf) {
        const size = fs.statSync(path.join(DL2, reqPdf)).size;
        check('engine: PDF file is non-trivial', size > 10000, size + ' bytes');
    }

    /* --- Issue 9: comprehensive report columns --- */
    const repCols = await p4.evaluate(async () => {
        App.App.showTab('reports');
        const mode = document.getElementById('reportMode');
        mode.value = 'all';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btnRunReport').click();
        await new Promise(r => setTimeout(r, 1200));

        const out = document.getElementById('reportOutput');
        const tables = [].slice.call(out.querySelectorAll('table'));
        let details = null;
        tables.forEach(t => {
            const heads = [].slice.call(t.querySelectorAll('thead th')).map(th => th.textContent.replace(/\s+/g, ' ').trim());
            if (heads.some(h => h.indexOf('نوع الإجازة') !== -1)) details = heads;
        });
        const statusTh = out.querySelector('th.no-print');
        return {
            details: details || [],
            hasDeducted: !!details && details.some(h => h.indexOf('الأيام المخصومة') !== -1),
            durationIdx: details ? details.findIndex(h => h.indexOf('المدة') !== -1) : -1,
            typeIdx: details ? details.findIndex(h => h.indexOf('نوع الإجازة') !== -1) : -1,
            statusMarked: statusTh ? statusTh.className : 'none',
            datesDmy: /\d{2}\/\d{2}\/\d{4}/.test(out.textContent),
            isoLeft: /\d{4}-\d{2}-\d{2}/.test(out.textContent),
            headerRepeatable: !!out.querySelector('[data-print-header]'),
            sigFloats: !!out.querySelector('.signature-right') && !!out.querySelector('.signature-left')
        };
    });
    check('issue 9: comprehensive report dropped the deducted-days column',
        repCols.hasDeducted === false, repCols.details.join(' | '));
    check('issue 9: "المدة" column sits right after "نوع الإجازة"',
        repCols.typeIdx >= 0 && repCols.durationIdx === repCols.typeIdx + 1,
        'type@' + repCols.typeIdx + ' duration@' + repCols.durationIdx + ' :: ' + repCols.details.join(' | '));
    check('issue 3: report status column marked no-print', /no-print/.test(repCols.statusMarked), repCols.statusMarked);
    check('issue 2: report dates are dd/mm/yyyy', repCols.datesDmy && !repCols.isoLeft);
    check('engine: report header marked for repetition', repCols.headerRepeatable);
    check('issue 5: report signatures use the float layout', repCols.sigFloats);

    /* --- Issue 11: default annual balance must reach the reports --- */
    const bal = await p4.evaluate(async () => {
        App.App.showTab('settings');
        App.Settings.showSubTab('policy');
        document.getElementById('setDefaultBalance').value = '30';
        document.getElementById('btnApplyBalanceAll').click();
        await new Promise(r => setTimeout(r, 500));
        const btn = [].slice.call(document.querySelectorAll('.app-modal-backdrop button'))
            .find(b => b.textContent.indexOf('تطبيق') !== -1);
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 800));
        return {
            applied: App.Store.get.staff().map(p => p.annualBalance),
            setting: App.Store.get.settings().defaultAnnualBalance
        };
    });
    check('issue 11: apply-to-all updated every employee balance',
        bal.applied.length === 2 && bal.applied.every(v => v === 30), bal.applied.join(','));

    const balReport = await p4.evaluate(async () => {
        App.App.showTab('reports');
        const mode = document.getElementById('reportMode');
        mode.value = 'balance';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('btnRunReport').click();
        await new Promise(r => setTimeout(r, 1200));
        const txt = document.getElementById('reportOutput').textContent;
        return { has30: /30/.test(txt), has21: /21/.test(txt), sample: txt.replace(/\s+/g, ' ').slice(0, 400) };
    });
    check('issue 11: balance report reflects the new 30-day balance',
        balReport.has30 === true, balReport.has21 ? 'still contains 21' : 'ok');

    /* --- Issue 11b: changing the default in settings offers to apply to all --- */
    const promptFlow = await p4.evaluate(async () => {
        App.App.showTab('settings');
        App.Settings.showSubTab('policy');
        document.getElementById('setDefaultBalance').value = '25';
        document.getElementById('btnSavePolicy').click();
        await new Promise(r => setTimeout(r, 700));
        const modal = document.querySelector('.app-modal-backdrop');
        if (!modal) return { modal: false };
        const text = modal.textContent;
        const btn = [].slice.call(modal.querySelectorAll('button'))
            .find(b => b.textContent.indexOf('طبّقه على الكل') !== -1);
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 800));
        return {
            modal: true,
            asked: /تطبيق الرصيد الجديد|طبّقه على الكل/.test(text),
            balances: App.Store.get.staff().map(p => p.annualBalance)
        };
    });
    check('issue 11: saving a changed default asks whether to apply to everyone',
        promptFlow.modal === true && promptFlow.asked === true);
    check('issue 11: accepting the prompt updates all balances',
        promptFlow.balances && promptFlow.balances.every(v => v === 25), (promptFlow.balances || []).join(','));

    /* --- Stress: many records must paginate without losing a single row --- */
    const bulk = await p4.evaluate(async () => {
        const t = App.Store.get.leaveTypes().find(x => /اعتيادية/.test(x.name));
        for (let i = 0; i < 57; i++) {
            App.Store.get.leaves().push({
                id: 'bulk-' + i, empId: '', empName: 'موظف اختبار رقم ' + (i + 1),
                jobTitle: 'طبيب اختصاص', dept: 'قسم الباطنية', section: 'شعبة الباطنية أ',
                leaveTypeId: t.id, leaveType: t.name, leaveTypeIsHourly: false,
                fromDate: '2026-0' + (1 + (i % 9)) + '-' + String(1 + (i % 27)).padStart(2, '0'),
                toDate: '2026-0' + (1 + (i % 9)) + '-' + String(2 + (i % 27)).padStart(2, '0'),
                calendarDays: 2, daysCount: 2, deductedDays: 2, hoursCount: 0,
                compensatoryDays: 0, excludedHolidays: [],
                notes: 'ملاحظة اختبار طويلة نسبياً للتأكد من أنها تظهر كاملة في المطبوع',
                status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            });
        }
        App.Store.save(['leaves']);
        App.Dashboard.render();

        const mode = document.getElementById('dashPeriodMode');
        mode.value = 'all';
        mode.dispatchEvent(new Event('change', { bubbles: true }));

        /* نُظهر كل الصفوف لأن الجدول الحيّ مُقسَّم 50 في الصفحة */
        const sizeSel = document.getElementById('pageSize');
        sizeSel.value = '0';
        sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));

        const res = await App.PrintLayout.paginate(document.getElementById('printableArea'));
        const per = res.pages.map(p => p.querySelectorAll('tbody tr').length);
        const bodyMax = res.pages.map(p => {
            const body = p.querySelector('.print-page-body');
            const kids = body ? [].slice.call(body.children) : [];
            if (!kids.length) return 0;
            const top = body.getBoundingClientRect().top;
            return Math.round(Math.max.apply(null, kids.map(k => k.getBoundingClientRect().bottom)) - top);
        });
        const limit = res.pages.length
            ? Math.round(res.pages[0].querySelector('.print-page-body').getBoundingClientRect().height)
            : 0;
        App.PrintLayout.cleanup();
        return {
            totalRecords: App.Store.get.leaves().length,
            pages: res.total,
            per: per,
            sum: per.reduce((a, b) => a + b, 0),
            emptyPages: per.filter((n, i) => n === 0 && i < per.length - 1).length,
            maxBody: Math.max.apply(null, bodyMax),
            limit: limit
        };
    });
    check('engine stress: 60 records span several pages', bulk.pages > 1, bulk.pages);
    check('engine stress: every record survives pagination (60 in, 60 out)',
        bulk.sum === 60, 'sum=' + bulk.sum + ' pages=' + bulk.pages + ' perPage=[' + bulk.per.join(',') + ']');
    check('engine stress: no empty middle page', bulk.emptyPages === 0, bulk.emptyPages);
    check('engine stress: page content stays inside the page',
        bulk.maxBody <= bulk.limit + 2, bulk.maxBody + ' <= ' + bulk.limit);

    /* --- Critical: printing must include records beyond the on-screen page --- */
    const autoAll = await p4.evaluate(async () => {
        const prevPrint = window.print;
        let calls = 0;
        window.print = function () { calls++; };

        const sizeSel = document.getElementById('pageSize');
        sizeSel.value = '50';
        sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const before = document.querySelectorAll('#dashboardTableBody tr').length;

        document.getElementById('btnDashPrint').click();
        await new Promise(r => setTimeout(r, 700));

        let rows = 0, pages = 0;
        document.querySelectorAll('#printHost .print-page').forEach((p) => {
            pages++;
            rows += p.querySelectorAll('tbody tr').length;
        });

        await new Promise(r => setTimeout(r, 2600));
        const after = document.querySelectorAll('#dashboardTableBody tr').length;
        const sizeAfter = document.getElementById('pageSize').value;

        window.print = prevPrint;
        App.PrintLayout.cleanup();
        return { before, rows, pages, after, sizeAfter, printCalls: calls };
    });
    check('export: live table is paginated at 50 before printing', autoAll.before === 50, autoAll.before);
    check('export: printing covers ALL 60 records, not just the visible page',
        autoAll.rows === 60, 'printed=' + autoAll.rows + ' pages=' + autoAll.pages);
    check('export: printing happened exactly once', autoAll.printCalls === 1, autoAll.printCalls);
    check('export: on-screen pagination restored afterwards',
        autoAll.after === 50 && autoAll.sizeAfter === '50',
        'rows=' + autoAll.after + ' size=' + autoAll.sizeAfter);

    check('issues: no console/page errors during acceptance tests',
        reqErrors.length === 0, reqErrors.slice(0, 3).join(' || '));

    fs.rmSync(DL2, { recursive: true, force: true });
    await p4.close();

    /* ---------- Console cleanliness ---------- */
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

} catch (err) {
    console.log('FATAL: ' + err.message);
    console.log(err.stack);
    results.push({ name: 'FATAL', ok: false, detail: err.message });
} finally {
    await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
if (failed.length) {
    console.log('\nFAILED CHECKS:');
    failed.forEach(f => console.log(' - ' + f.name + (f.detail ? '  [' + f.detail + ']' : '')));
}
console.log(`screenshots -> ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
