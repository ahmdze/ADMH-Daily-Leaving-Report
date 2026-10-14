/* ============================================================
   Reproduces and verifies the report pagination.
   The bug: a table was forced onto a fresh page whenever ANY content
   preceded it, so every report wasted its first page (section heading
   on page 1, its table on page 2, ...).
   ============================================================ */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const OUT = path.join(ROOT, '_screenshots');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + detail + ']' : ''}`);
}

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
await page.goto(APP_URL, { waitUntil: 'load' });
await page.waitForFunction('window.App && App.Store && App.Store.isReady()', { timeout: 25000 });

/* بيانات: موظف واحد بإجازة واحدة في الشهر — كحالة المستخدم تماماً */
await page.evaluate(async () => {
    await App.Store.factoryReset();
    const t = App.Store.get.leaveTypes().find(x => /اعتيادية/.test(x.name));
    const staff = App.Store.upsertEmployee({
        name: 'احمد زياد رحيمه', jobTitle: 'تقني طبي',
        dept: 'قسم الباطنية', section: 'شعبة الباطنية أ', annualBalance: 36
    });
    App.Store.get.leaves().push({
        id: 'r1', empId: staff.id, empName: staff.name, jobTitle: staff.jobTitle,
        dept: staff.dept, section: staff.section,
        leaveTypeId: t.id, leaveType: t.name, leaveTypeIsHourly: false,
        fromDate: '2026-10-14', toDate: '2026-10-18',
        calendarDays: 5, daysCount: 5, deductedDays: 5, hoursCount: 0,
        compensatoryDays: 0, excludedHolidays: [], notes: '',
        status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    App.Store.save(['leaves', 'staff']);
    await new Promise(r => setTimeout(r, 400));
});

const MODES = ['employee', 'department', 'all', 'balance', 'compensation'];
const report = await page.evaluate(async (modes) => {
    const out = {};
    App.App.showTab('reports');
    const setSel = (id, v) => {
        const el = document.getElementById(id);
        if (el && v !== null && v !== undefined) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    for (const m of modes) {
        setSel('reportPeriodType', 'all');
        setSel('reportMode', m);
        /* اختر أول موظف/قسم حتى لا يكون التقرير فارغاً */
        const emp = document.getElementById('reportEmpName');
        if (emp && emp.options.length) { emp.selectedIndex = 0; emp.dispatchEvent(new Event('change', { bubbles: true })); }
        const dep = document.getElementById('reportDept');
        if (dep && dep.options.length) { dep.selectedIndex = 0; dep.dispatchEvent(new Event('change', { bubbles: true })); }
        await new Promise(r => setTimeout(r, 300));
        document.getElementById('btnRunReport').click();
        await new Promise(r => setTimeout(r, 600));

        const src = document.getElementById('reportOutput');
        if (!src) { out[m] = { error: 'no #reportOutput' }; continue; }

        document.body.classList.add('print-capturing');
        const res = await App.PrintLayout.paginate(src);
        const pages = [].slice.call(document.querySelectorAll('#printHost .print-page'));
        const flow0 = pages.length ? pages[0].querySelector('.print-page-flow') : null;
        out[m] = {
            total: res.total,
            firstPageHasRow: pages.length ? pages[0].querySelectorAll('tbody tr').length > 0 : false,
            firstPageBlocks: pages.length ? pages[0].querySelectorAll('.pa-block').length : 0,
            rowsPerPage: pages.map(p => p.querySelectorAll('tbody tr').length),
            blocksPerPage: pages.map(p => p.querySelectorAll('.pa-block').length),
            firstPageFill: (flow0 && pages.length)
                ? Math.round((flow0.getBoundingClientRect().height / pages[0].getBoundingClientRect().height) * 100)
                : 0,
            tablesOnFirst: pages.length ? pages[0].querySelectorAll('.print-table-host').length : 0,
            tablesPerPage: pages.map(p => p.querySelectorAll('.print-table-host').length),
            dupTemplatesPerPage: pages.map(p => {
                const ids = [].slice.call(p.querySelectorAll('.print-table-host'))
                    .map(h => h.getAttribute('data-tpl'));
                const seen = {};
                let dup = 0;
                ids.forEach(id => { if (seen[id]) dup++; seen[id] = 1; });
                return dup;
            })
        };
        App.PrintLayout.cleanup();
        document.body.classList.remove('print-capturing');
    }
    return out;
}, MODES);

console.log('--- per report mode ---');
console.log(JSON.stringify(report, null, 1));

/* التقرير الذي شكا منه المستخدم: تقرير موظف واحد بإجازة واحدة */
const s = report['employee'];
check('employee report with 1 record fits on ONE page',
    s && s.total === 1, s ? s.total + ' pages (rows: ' + (s.rowsPerPage || []).join(',') + ')' : 'n/a');
check('employee report: the first page carries the table rows (no wasted page)',
    s && s.firstPageHasRow === true, s ? 'rows on page 1: ' + (s.rowsPerPage[0] || 0) : 'n/a');
check('employee report: page 1 is actually used, not left blank',
    s && s.firstPageFill >= 25, s ? s.firstPageFill + '% filled' : 'n/a');

/* كل تقرير: لا صفحة أولى فارغة من الصفوف إن كان فيه صفوف أصلاً */
Object.keys(report).forEach(m => {
    const r = report[m];
    if (r.error) { check(m + ': report produced output', false, r.error); return; }
    const totalRows = (r.rowsPerPage || []).reduce((a, b) => a + b, 0);
    if (totalRows > 0) {
        check(m + ': no page is wasted before the first table',
            r.firstPageHasRow === true,
            'page1 rows=' + r.rowsPerPage[0] + '/' + totalRows + ', fill=' + r.firstPageFill + '%');
    }
    /* الجدول الواحد لا ينشقّ إلى مضيفين في الصفحة نفسها (رأس مكرر)،
       ويُسمح بجدولين مختلفين في الصفحة (ملخّص + تفاصيل) — وهذا مطلوب
       لتقليل عدد الصفحات بدل تفريق كل قسم في صفحة مستقلة. */
    check(m + ': no table is duplicated on the same page',
        (r.dupTemplatesPerPage || []).every(n => n === 0),
        'duplicate hosts/page: ' + (r.dupTemplatesPerPage || []).join(','));
    check(m + ': at most two distinct tables share a page',
        (r.tablesPerPage || []).every(n => n <= 2),
        'tables/page: ' + (r.tablesPerPage || []).join(','));
});

/* لقطة للتحقق البصري */
await page.evaluate(async () => {
    App.App.showTab('reports');
    const setSel = (id, v) => {
        const el = document.getElementById(id);
        if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    setSel('reportPeriodType', 'all');
    setSel('reportMode', 'employee');
    const emp = document.getElementById('reportEmpName');
    if (emp && emp.options.length) { emp.selectedIndex = 0; emp.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('btnRunReport').click();
    await new Promise(r => setTimeout(r, 700));
    document.body.classList.add('print-capturing');
    await App.PrintLayout.paginate(document.getElementById('reportOutput'));
});
const first = await page.$('#printHost .print-page');
if (first) await first.screenshot({ path: path.join(OUT, 'report-fixed-page1.png') });

/* التحقق من نص التذييل حرفياً + لقطة مكبّرة له */
const footerInfo = await page.evaluate(() => {
    const f = document.querySelector('#printHost .print-page .print-page-footer');
    const p = document.querySelector('#printHost .print-page [data-print-pageno]');
    const head = document.querySelector('#printHost .print-page .print-page-header');
    return {
        footerText: f ? f.textContent : 'MISSING',
        footerExpected: App.Constants.DEFAULT_SETTINGS.printFooterText,
        pageno: p ? p.textContent : 'MISSING',
        headerHasPageno: !!(head && head.querySelector('[data-print-pageno]'))
    };
});
console.log('--- footer ---');
console.log('text    : ' + JSON.stringify(footerInfo.footerText));
console.log('expected: ' + JSON.stringify(footerInfo.footerExpected));
console.log('page no : ' + JSON.stringify(footerInfo.pageno));
check('footer text is exactly the hard-coded credit', footerInfo.footerText.trim() === footerInfo.footerExpected.trim());
check('page number sits in the header, not the footer',
    footerInfo.headerHasPageno === true && !/\d+\s*(من|\/)\s*\d+/.test(footerInfo.footerText.replace(/07723064622/, '')));
const foot = await page.$('#printHost .print-page .print-page-footer');
if (foot) await foot.screenshot({ path: path.join(OUT, 'report-fixed-footer.png') });

await browser.close();

const failed = results.filter(r => !r.ok);
console.log('\n================ SUMMARY ================');
console.log(`total=${results.length}  passed=${results.length - failed.length}  failed=${failed.length}`);
failed.forEach(f => console.log(' - ' + f.name));
process.exit(failed.length ? 1 : 0);
