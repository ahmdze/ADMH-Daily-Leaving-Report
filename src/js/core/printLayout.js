/* ============================================================
   مولّد صفحات A4 الحقيقي للطباعة والتصدير — App.PrintLayout
   ------------------------------------------------------------
   الهدف: تقسيم مستند (موقف يومي أو تقرير) إلى صفحات A4 حقيقية، كل
   صفحة تحمل: الترويسة الرسمية المتكررة + رأس الجدول + تذييلاً ثابتاً
   في سطر واحد. رقم الصفحة «الصفحة X من Y» يُكتب داخل الترويسة
   المتكررة (أسفل «الحالة» و«عدد السجلات») لا في التذييل.

   سبب وجود هذا الملف:
     1) كروم لا يدعم counter(page) في CSS، فلا يمكن كتابة رقم الصفحة
        عبر قواعد الطباعة.
     2) jsPDF.text() لا يُشكّل العربية (لا وصل حروف ولا تراكيب)، لذا
        لا يمكن كتابة التذييل العربي عبر jsPDF مباشرة.
   الحل: نبني عناصر صفحات A4 فعلية في DOM (فيها التذييل والترقيم كنص
   عربي حقيقي)، ثم إمّا نطبعها مباشرة، أو نُحوّل كل صفحة إلى صورة عبر
   html2canvas ونضعها في صفحة A4 داخل jsPDF.

   لا نلمس المستند الأصلي أبداً: كل العمل يجري على نسخة مستنسخة
   (deep clone) تُبنى داخل #printHost.
   ============================================================ */
window.App = window.App || {};

App.PrintLayout = (function () {
    'use strict';

    /* مقاس A4 عند 96dpi: 210mm = 794px ، 297mm = 1123px */
    const A4 = {
        widthPx: 794,
        heightPx: 1123,
        padTopMm: 10,
        padSideMm: 8,
        padBottomMm: 10
    };

    const HOST_ID = 'printHost';
    const PAGE_STATE_CLASSES = ['paginating', 'print-capturing', 'print-measuring'];

    /* مُحدِّد مربع رقم الصفحة داخل الترويسة المتكررة */
    const PAGENO_SELECTOR = '[data-print-pageno]';

    /* النص الصلب للتذييل — نسخة طبق الأصل من
       App.Constants.DEFAULT_SETTINGS.printFooterText.
       وجوده هنا (بلا قراءة أي إعداد) يضمن ألا يُطبع تذييل فارغ أبداً
       حتى لو فُقد مُثبِّت constants.js أو أُفرغت قيمته. */
    const FALLBACK_FOOTER_TEXT =
        'طُبع هذا الموقف عبر نظام موقف الإجازات اليومي الموحد - جميع الحقوق محفوظة للمطور: تقني طبي - احمد زياد رحيمه 07723064622';

    /* معرّف تشغيل متزايد: يمنع تشغيلين متوازيين من إفساد بعضهما */
    let runToken = 0;

    /* العنوان الأصلي للنافذة قبل أي تجاوز */
    let savedTitle = null;

    /* ------------------------------------------------------------
       أدوات عامة
       ------------------------------------------------------------ */

    function available() {
        return typeof window.html2canvas === 'function' &&
            !!(window.jspdf && window.jspdf.jsPDF);
    }

    function defaults() {
        const c = (window.App && App.Constants) ? App.Constants : null;
        return (c && c.DEFAULT_SETTINGS) ? c.DEFAULT_SETTINGS : {};
    }

    /**
     * نص التذييل: صلب في الكود.
     * لم يعد يُقرأ من إعدادات المستخدم (حُذف حقل الإعدادات)، والمصدر
     * الوحيد هو App.Constants.DEFAULT_SETTINGS.printFooterText، مع
     * احتياط داخلي فلا يعود فارغاً أبداً.
     */
    function footerText() {
        let s = '';
        try {
            const d = defaults();
            if (d && d.printFooterText) s = String(d.printFooterText);
        } catch (e) {
            s = '';
        }
        if (!s) s = FALLBACK_FOOTER_TEXT;
        return s;
    }

    function host() {
        let h = document.getElementById(HOST_ID);
        if (!h) {
            /* احتياط: لو حُذفت الحاوية من الصفحة لأي سبب */
            h = document.createElement('div');
            h.id = HOST_ID;
            h.setAttribute('aria-hidden', 'true');
            document.body.appendChild(h);
        }
        return h;
    }

    function toEl(target) {
        if (!target) return null;
        if (typeof target === 'string') {
            try { return document.querySelector(target); } catch (e) { return null; }
        }
        return (target.nodeType === 1) ? target : null;
    }

    function stripNoPrint(root) {
        if (!root || !root.querySelectorAll) return;
        const doomed = root.querySelectorAll('.no-print');
        for (let i = 0; i < doomed.length; i++) {
            if (doomed[i] && doomed[i].parentNode) doomed[i].parentNode.removeChild(doomed[i]);
        }
    }

    /**
     * إزالة كل خصائص id من النسخة.
     * سبب ذلك: النسخة تحتوي عناصر مثل dashboardTable و dashboardTableBody،
     * فتصبح الهويات مكررة في المستند وتُفسد getElementById على الواجهة
     * الحيّة. لا نحتاج أي id داخل الصفحات المولّدة.
     */
    function stripIds(root) {
        if (!root) return;
        if (root.nodeType === 1 && root.id) root.removeAttribute('id');
        if (!root.querySelectorAll) return;
        const withId = root.querySelectorAll('[id]');
        for (let i = 0; i < withId.length; i++) withId[i].removeAttribute('id');
    }

    /** هل هذا العنصر جدول طباعة (أو يحتوي عليه)؟ */
    function findPrintTable(node) {
        if (!node || node.nodeType !== 1) return null;
        if (node.classList && node.classList.contains('print-table')) return node;
        if (!node.querySelector) return null;
        return node.querySelector('table.print-table');
    }

    /* ------------------------------------------------------------
       تجهيز التدفق: قوالب الجداول + عناصر التدفق
       ------------------------------------------------------------ */

    /**
     * يستخرج من جدول مُستنسخ: قالباً (رأس فقط + جسم فارغ) وصفوف جسمه.
     * الصفوف بأعمدتها كما هي — صف المجموع بـ colspan يبقى دون قصّ.
     */
    function tableTemplateFrom(wrapEl, tableEl, seenTemplates) {
        const tpl = {
            id: 'ptpl-' + (seenTemplates.length + 1),
            table: tableEl.cloneNode(true),
            wrapClass: (wrapEl && wrapEl.classList) ? (wrapEl.className || '') : ''
        };

        /* جسم فارغ في القالب — الصفوف تُضاف صفحة بصفحة */
        const tbody = tpl.table.querySelector('tbody');
        if (tbody) while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

        /* نُزيل تذييل الجدول: الصفوف تتكرر لكل صفحة فلا معنى لتكرار المجموع */
        const foots = tpl.table.querySelectorAll('tfoot');
        for (let f = 0; f < foots.length; f++) {
            if (foots[f] && foots[f].parentNode) foots[f].parentNode.removeChild(foots[f]);
        }

        /* صفوف الجسم: أبناء tbody المباشرون فقط، وإلا التقطنا صفوف جدول داخلي */
        const realBody = tableEl.querySelector('tbody');
        let rows = [];
        if (realBody) {
            rows = Array.prototype.filter.call(realBody.children, function (n) {
                return n.nodeType === 1 && n.tagName === 'TR';
            });
        } else {
            rows = Array.prototype.filter.call(tableEl.children, function (n) {
                return n.nodeType === 1 && n.tagName === 'TR';
            });
        }

        seenTemplates.push(tpl);
        return { tpl: tpl, rows: rows };
    }

    /**
     * يحوّل محتوى المستند إلى قائمة عناصر تدفق متسلسلة.
     * kind: 'block' (كتلة ذرّية) أو 'row' (صف داخل قالب جدول).
     */
    function collectFlow(clone, seenTemplates) {
        const flow = [];
        const kids = Array.prototype.slice.call(clone.childNodes);

        kids.forEach(function (node) {
            /* العُقد النصية الفارغة بين العناصر تُهمَل */
            if (node.nodeType === 3) {
                if (!String(node.nodeValue || '').replace(/[\s\u00A0]+/g, '')) return;
            }
            if (node.nodeType !== 1) return;

            const table = findPrintTable(node);

            if (table && table === node) {
                /* الحالة 1: الجدول نفسه عنصر مباشر */
                const built = tableTemplateFrom(null, table, seenTemplates);
                built.rows.forEach(function (r) {
                    flow.push({ kind: 'row', row: r, tpl: built.tpl.id });
                });
                return;
            }

            if (table) {
                /* الحالة 2: جدول داخل غلاف — نستخرج الجدول كقالب، ونحوّل
                   باقي أبناء الغلاف (إن وُجدوا) إلى كتلة ذرّية واحدة */
                const built = tableTemplateFrom(node, table, seenTemplates);
                built.rows.forEach(function (r) {
                    flow.push({ kind: 'row', row: r, tpl: built.tpl.id });
                });

                const parent = table.parentNode;
                if (parent) {
                    parent.removeChild(table);
                    const leftover = document.createElement('div');
                    while (parent.firstChild) leftover.appendChild(parent.firstChild);
                    if (leftover.children.length) flow.push({ kind: 'block', node: leftover });
                }
                return;
            }

            /* كتلة ذرّية عادية (ترويسة عنوان، بطاقات، تواقيع...) */
            flow.push({ kind: 'block', node: node });
        });

        return flow;
    }

    function tplById(list, id) {
        for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    /* ------------------------------------------------------------
       بناء الصفحات
       ------------------------------------------------------------ */

    function buildHeaderBlock(headerTpl) {
        const d = document.createElement('div');
        d.className = 'print-page-header';
        if (headerTpl) d.appendChild(headerTpl.cloneNode(true));
        return d;
    }

    /**
     * يكتب «الصفحة X من Y» في مربع الترقيم داخل الترويسة المتكررة.
     * محصّن: قد لا تحتوي الترويسة على [data-print-pageno] إطلاقاً
     * (تقارير أقدم)، أو قد يكون الاستعلام نفسه مرفوضاً.
     */
    function setPageNo(root, index, total) {
        if (!root || !root.querySelector) return null;
        let box = null;
        try { box = root.querySelector(PAGENO_SELECTOR); } catch (e) { box = null; }
        if (!box) return null;
        box.textContent = 'الصفحة ' + index + ' من ' + total;
        return box;
    }

    /**
     * التذييل: سطر واحد بعرض الصفحة كاملاً، في وسطه نص الإسناد الصلب.
     * لا رقم صفحة هنا إطلاقاً — الترقيم انتقل إلى الترويسة المتكررة.
     */
    function buildFooterBlock(text) {
        const f = document.createElement('div');
        f.className = 'print-page-footer';

        const credit = document.createElement('span');
        credit.className = 'pf-credit';
        credit.textContent = String(text || FALLBACK_FOOTER_TEXT);

        f.appendChild(credit);
        return f;
    }

    function buildPage(headerTpl, footerTextValue) {
        const page = document.createElement('div');
        page.className = 'print-page';

        const head = buildHeaderBlock(headerTpl);
        const body = document.createElement('div');
        body.className = 'print-page-body';

        /* حاوية التدفق: ارتفاعها تلقائي (لا flex) فتُقاس بدقة.
           لو قسنا .print-page-body نفسه لكان دائماً بارتفاع الصفحة لأنه
           عنصر مرن يتمدد ليملأ الفراغ، فتغدو كل إضافة «طفحاً». */
        const flow = document.createElement('div');
        flow.className = 'print-page-flow';
        body.appendChild(flow);

        const foot = buildFooterBlock(footerTextValue);

        page.appendChild(head);
        page.appendChild(body);
        page.appendChild(foot);

        /* مراجع مباشرة للقياس السريع */
        page.__head = head;
        page.__body = body;
        page.__flow = flow;
        page.__foot = foot;
        page.__tables = {};
        return page;
    }

    /** يضمن وجود نسخة من قالب الجدول في جسم الصفحة ويعيد جسم الجدول */
    function tableBodyOnPage(page, tpl) {
        const cached = page.__tables[tpl.id];
        if (cached) {
            const tb = cached.querySelector('tbody');
            if (tb) return tb;
        }

        let holder = page.__flow.querySelector('.print-table-host[data-tpl="' + tpl.id + '"]');
        if (!holder) {
            holder = document.createElement('div');
            /* نُبقي أصناف الغلاف الأصلي (overflow-x-auto مثلاً) مع صنفنا */
            holder.className = 'print-table-host' + (tpl.wrapClass ? ' ' + tpl.wrapClass : '');
            holder.setAttribute('data-tpl', tpl.id);
            holder.appendChild(tpl.table.cloneNode(true));
            page.__flow.appendChild(holder);
        }

        const tableEl = holder.querySelector('table');
        if (!tableEl) return null;
        page.__tables[tpl.id] = tableEl;

        let tb = tableEl.querySelector('tbody');
        if (!tb) {
            tb = document.createElement('tbody');
            tableEl.appendChild(tb);
        }
        return tb;
    }

    function dropTableHost(page, tplId) {
        const holder = page.__flow.querySelector('.print-table-host[data-tpl="' + tplId + '"]');
        if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
        delete page.__tables[tplId];
    }

    /** ارتفاع الصفحة الأساس (الترويسة + التذييل) بعد أن تُركَّب فعلاً */
    function baseHeightOf(page) {
        return (page.__head.getBoundingClientRect().height || 0) +
            (page.__foot.getBoundingClientRect().height || 0);
    }

    /** المساحة المتاحة فعلياً للمحتوى داخل الصفحة */
    function capacityOf(page) {
        const pageH = page.getBoundingClientRect().height || A4.heightPx;
        const cs = window.getComputedStyle(page);
        const padT = parseFloat(cs.paddingTop) || 0;
        const padB = parseFloat(cs.paddingBottom) || 0;
        const avail = pageH - padT - padB - baseHeightOf(page);
        return avail > 80 ? avail : 80;
    }

    /**
     * الارتفاع الحقيقي للمحتوى.
     * نقيس حاوية التدفق نفسها: ارتفاعها تلقائي (بلا flex) فيساوي مجموع
     * محتواها فعلاً، بخلاف .print-page-body الممتد الذي يعطي دائماً
     * ارتفاع الصفحة كاملاً.
     */
    function contentHeightOf(page) {
        const f = page.__flow;
        if (!f || !f.children.length) return 0;
        return f.getBoundingClientRect().height || 0;
    }

    function startPage(hostEl, state) {
        const p = buildPage(state.headerTpl, state.footerTextValue);
        hostEl.appendChild(p);
        state.pages.push(p);
        state.current = p;
        state.used = 0;
        state.itemCount = 0;
        return p;
    }

    /* ------------------------------------------------------------
       إضافة العناصر إلى الصفحات (جشِع)
       ------------------------------------------------------------ */

    function placeRow(hostEl, item, state, templates) {
        const tpl = tplById(templates, item.tpl);
        if (!tpl) return;                      /* قالب مفقود: نتجاوز بلا رمي خطأ */

        if (!state.current) startPage(hostEl, state);
        let page = state.current;

        /* الجدول يُعاد في كل صفحة: لو الصفحة تحمل محتوى ولا تحمل هذا
           الجدول بعد، نبدأ صفحة جديدة بدل خلط جدولين في صفحة واحدة. */
        const holderHere = page.__flow.querySelector('.print-table-host[data-tpl="' + tpl.id + '"]');
        if (!holderHere && contentHeightOf(page) > 0) {
            page = startPage(hostEl, state);
        }

        const countBefore = state.itemCount;

        const tb = tableBodyOnPage(page, tpl);
        if (!tb) return;
        const tr = item.row.cloneNode(true);
        tb.appendChild(tr);

        let cap = capacityOf(page);
        let used = contentHeightOf(page);

        /* عند بداية الصفحة لا نحذف شيئاً حتى لو كان الصف أطول من صفحة
           كاملة — نضعه وحده ونتركه يفيض، فلا نُسقط محتوى ولا ندور بلا نهاية */
        if (used > cap && countBefore > 0) {
            /* نحذف الصف المضاف وحده، ونُزيل المضيف فقط إن صار فارغاً */
            if (tr.parentNode) tr.parentNode.removeChild(tr);
            if (holderHere && !holderHere.querySelector('tbody tr')) {
                dropTableHost(page, tpl.id);
            }

            page = startPage(hostEl, state);
            const tb2 = tableBodyOnPage(page, tpl);
            if (tb2) tb2.appendChild(item.row.cloneNode(true));

            cap = capacityOf(page);
            used = contentHeightOf(page);
            state.itemCount = 1;
        } else {
            state.itemCount = countBefore + 1;
        }

        state.used = used;
        page.__body.setAttribute('data-cap', String(Math.round(cap)));
        page.setAttribute('data-rows', String(state.itemCount));
    }

    function placeBlock(hostEl, item, state) {
        if (!state.current) startPage(hostEl, state);
        let page = state.current;

        const countBefore = state.itemCount;

        /* نُبقي أصناف الكتلة الأصلية (الهوامش والقياسات) مع صنفنا */
        const node = item.node.cloneNode(true);
        if (node.classList) node.classList.add('pa-block');
        page.__flow.appendChild(node);

        let cap = capacityOf(page);
        let used = contentHeightOf(page);

        if (used > cap && countBefore > 0) {
            page.__flow.removeChild(node);
            page = startPage(hostEl, state);
            page.__flow.appendChild(node);
            cap = capacityOf(page);
            used = contentHeightOf(page);
            state.itemCount = 1;
        } else {
            state.itemCount = countBefore + 1;
        }

        state.used = used;
        page.__body.setAttribute('data-cap', String(Math.round(cap)));
    }

    /* ------------------------------------------------------------
       الترقيم
       ------------------------------------------------------------ */

    function build(src, opts) {
        const hostEl = host();
        const token = runToken;

        /* نبدأ من حالة نظيفة دائماً */
        while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);

        document.body.classList.add('print-measuring');

        /* 1) استنساخ بعيداً عن المستند الحي */
        const clone = src.cloneNode(true);

        /* 2) إزالة كل ما هو للواجهة فقط (الحالة، الإجراءات، أسهم الفرز...) */
        stripNoPrint(clone);

        /* 2ب) إزالة الهويات المتكررة (dashboardTable، dashboardTableBody...)
           كي لا تتعارض مع عناصر الواجهة الحيّة عند getElementById */
        stripIds(clone);

        /* 3) استخراج الترويسة المتكررة وإخراجها من التدفق */
        const headerSel = opts.headerSelector || '[data-print-header]';
        let headerNode = null;
        try { headerNode = clone.querySelector(headerSel); } catch (e) { headerNode = null; }
        if (!headerNode) {
            try { headerNode = clone.querySelector('[data-print-header]'); } catch (e2) { headerNode = null; }
        }

        let headerTpl;
        if (headerNode) {
            headerTpl = headerNode.cloneNode(true);
            if (headerNode.parentNode) headerNode.parentNode.removeChild(headerNode);
        } else {
            /* بلا ترويسة: عنصر فارغ يحفظ بنية الصفحة */
            headerTpl = document.createElement('div');
        }

        /* 3ب) نحجز ارتفاع سطر «الصفحة X من Y» في الترويسة قبل أي قياس:
           نضع نصاً مؤقتاً بنفس الشكل، فيُحسب ارتفاع الترويسة الحقيقي في
           capacityOf()، ولا يتغيّر القياس لاحقاً عند كتابة الرقم النهائي
           (وإلا فقد يدفع سطر جديد صفاً إلى ما بعد حدّ الصفحة). */
        setPageNo(headerTpl, 1, 1);

        /* 4) تفكيك التدفق: قوالب جداول + صفوف + كتل ذرّية */
        const templates = [];
        const flow = collectFlow(clone, templates);

        const state = {
            pages: [],
            current: null,
            used: 0,
            itemCount: 0,
            headerTpl: headerTpl,
            footerTextValue: (opts.footerText !== undefined && opts.footerText !== null && opts.footerText !== '')
                ? String(opts.footerText)
                : footerText()
        };

        /* 5) البناء الجشع: نضيف حتى نتجاوز السعة ثم ننتقل لصفحة جديدة */
        for (let i = 0; i < flow.length; i++) {
            if (token !== runToken) break;      /* تشغيل أحدث حلّ محلّنا */
            const item = flow[i];
            if (item.kind === 'row') placeRow(hostEl, item, state, templates);
            else placeBlock(hostEl, item, state);
        }

        /* مستند بلا أي محتوى: صفحة واحدة بترويسة وتذييل */
        if (!state.pages.length) startPage(hostEl, state);

        /* 6) الترقيم: الآن فقط صار المجموع معروفاً. نكتب «الصفحة X من Y»
           في ترويسة كل صفحة (المربع [data-print-pageno] داخل الترويسة
           المستنسخة). التذييل لا يحمل أي رقم. */
        const total = state.pages.length;
        state.pages.forEach(function (p, idx) {
            setPageNo(p.__head, idx + 1, total);
            /* وسم الصفحات التي لا تحمل أي محتوى (مستند فارغ) */
            if (!p.__flow.children.length) p.setAttribute('data-empty', '1');
        });

        document.body.classList.remove('print-measuring');

        return { pages: state.pages.slice(), total: total };
    }

    /**
     * paginate(documentEl, opts) -> Promise<{pages, total}>
     * opts: { headerSelector, footerText }
     * لا يرمي خطأ أبداً — يعيد {pages: [], total: 0} عند أي فشل.
     */
    function paginate(documentEl, opts) {
        opts = opts || {};
        const src = toEl(documentEl);
        if (!src) return Promise.resolve({ pages: [], total: 0 });

        runToken++;
        const token = runToken;

        /* ننتظر جاهزية الخطوط لضمان قياسات صحيحة (الخطوط محلية) */
        const fontsReady = (document.fonts && document.fonts.ready)
            ? document.fonts.ready.then(function () { }, function () { })
            : Promise.resolve();

        return fontsReady.then(function () {
            /* تشغيل أحدث حلّ محلّنا: لا نبني صفحات يتيمة */
            if (token !== runToken) return { pages: [], total: 0 };
            try {
                return build(src, opts);
            } catch (err) {
                console.error('[PrintLayout] فشل ترقيم الصفحات', err);
                const h = document.getElementById(HOST_ID);
                if (h) while (h.firstChild) h.removeChild(h.firstChild);
                if (document.body && document.body.classList) {
                    PAGE_STATE_CLASSES.forEach(function (c) { document.body.classList.remove(c); });
                }
                return { pages: [], total: 0 };
            }
        });
    }

    /* ------------------------------------------------------------
       الطباعة
       ------------------------------------------------------------ */

    /**
     * print(documentEl, title, opts) -> Promise<{pages}>
     * يبني الصفحات ثم يفتح نافذة الطباعة، وينظّف بعد إغلاقها.
     */
    function print(documentEl, title, opts) {
        opts = opts || {};
        const src = toEl(documentEl);
        if (!src) {
            if (App.Notify) App.Notify.toast('لا يوجد محتوى للطباعة', 'warning');
            return Promise.resolve({ pages: 0 });
        }

        cleanup();

        return paginate(src, opts).then(function (res) {
            const total = (res && res.total) || 0;
            const built = document.querySelectorAll('#printHost .print-page');
            const hasRealContent = !!document.querySelector('#printHost .print-page:not([data-empty])');

            /* مستند بلا محتوى: لا معنى لطباعة صفحة ترويسة وتذييل فقط */
            if (!total || !built.length || !hasRealContent) {
                if (App.Notify) App.Notify.toast('لا يوجد محتوى للطباعة', 'warning');
                cleanup();
                return { pages: 0 };
            }

            document.body.classList.add('paginating');
            injectPageRule();

            if (title) {
                if (savedTitle === null) savedTitle = document.title;
                document.title = String(title);
            }

            let finished = false;
            let timer = null;

            function finish() {
                if (finished) return;
                finished = true;
                if (timer) clearTimeout(timer);
                window.removeEventListener('afterprint', finish);
                cleanup();
            }

            window.addEventListener('afterprint', finish);
            /* احتياط: بعض البيئات لا تُطلق afterprint إطلاقاً */
            timer = setTimeout(finish, 1500);

            try {
                /* نُجبر المتصفح على تثبيت التخطيط قبل فتح نافذة الطباعة */
                void document.body.offsetHeight;
                window.print();
            } catch (err) {
                console.error('[PrintLayout] فشل استدعاء الطباعة', err);
                finish();
                if (App.Notify) App.Notify.alert('تعذّر فتح نافذة الطباعة.', 'error');
                return { pages: 0 };
            }

            return { pages: total };
        });
    }

    /* ------------------------------------------------------------
       PDF
       ------------------------------------------------------------ */

    /**
     * toPdf(documentEl, fileName, opts) -> Promise<{pages}>
     * كل صفحة A4 ← صورة عبر html2canvas ← صفحة داخل jsPDF.
     */
    function toPdf(documentEl, fileName, opts) {
        opts = opts || {};

        if (!available()) {
            return Promise.reject(new Error('مكتبات التصدير غير متاحة'));
        }

        const src = toEl(documentEl);
        if (!src) {
            if (App.Notify) App.Notify.alert('لا يوجد محتوى للتصدير.', 'error');
            return Promise.resolve({ pages: 0 });
        }

        cleanup();

        const name = fileName || ('تصدير_' + Date.now() + '.pdf');
        let busy = null;
        let busySpan = null;

        /* التحويل الفعلي لصفحة صفحة */
        function renderPdf(pages, total) {
            busy = App.Notify ? App.Notify.busy('جارٍ إنشاء الصفحة 1 من ' + total + '...') : null;
            /* نافذة الانتظار قد لا تُعطي مرجعاً للعنصر؛ نجرّب بتحفّظ شديد
               كي لا يسقط التصدير كله بسبب نص التقدّم */
            try {
                busySpan = busy && busy.root ? busy.root.querySelector('.app-modal-body span') : null;
            } catch (e) {
                busySpan = null;
            }

            document.body.classList.add('print-capturing');
            /* نُثبّت الأنماط قبل أول التقاط (html2canvas يستنسخ المستند) */
            void document.body.offsetHeight;

            const pdf = new window.jspdf.jsPDF({
                unit: 'mm',
                format: 'a4',
                orientation: 'portrait',
                compress: true
            });

            let chain = Promise.resolve();

            pages.forEach(function (pageEl, idx) {
                chain = chain.then(function () {
                    if (busySpan) busySpan.textContent = 'جارٍ إنشاء الصفحة ' + (idx + 1) + ' من ' + total + '...';

                    return window.html2canvas(pageEl, {
                        scale: 2,
                        backgroundColor: '#ffffff',
                        useCORS: true,
                        logging: false,
                        width: 794,
                        height: 1123,
                        windowWidth: 794,
                        windowHeight: 1123
                    }).then(function (canvas) {
                        if (idx > 0) pdf.addPage();
                        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297);
                    });
                });
            });

            return chain.then(function () {
                pdf.save(name);
                return { pages: total };
            });
        }

        return paginate(src, opts)
            .then(function (res) {
                const pages = (res && res.pages) || [];
                const total = (res && res.total) || 0;

                if (!total || !pages.length) {
                    if (App.Notify) App.Notify.alert('لا يوجد محتوى لتصديره إلى PDF.', 'error');
                    return { pages: 0 };
                }

                /* تصدير ضخم (أكثر من 150 صفحة): نستأذن المستخدم أولاً */
                if (total > 150) {
                    const ask = (App.Notify && App.Notify.confirm)
                        ? App.Notify.confirm('عدد الصفحات كبير (' + total + ' صفحة) وقد يستغرق التصدير وقتاً طويلاً. هل تريد المتابعة؟',
                            { title: 'تصدير كبير', confirmText: 'متابعة', cancelText: 'إلغاء', type: 'warning' })
                        : Promise.resolve(true);

                    return ask.then(function (ok) {
                        if (!ok) return { pages: 0 };
                        return renderPdf(pages, total);
                    });
                }

                return renderPdf(pages, total);
            })
            .catch(function (err) {
                console.error('[PrintLayout] فشل تصدير PDF', err && err.message ? err.message : err);
                if (App.Notify) App.Notify.alert('تعذّر إنشاء ملف PDF. جرّب زر الطباعة ثم «حفظ كـ PDF».', 'error');
                return { pages: 0 };
            })
            .then(function (out) {
                if (busy) { try { busy.close(); } catch (e) { /* تجاهل */ } }
                /* دائماً ننظّف، حتى عند الخطأ */
                cleanup();
                return out;
            });
    }

    /* ------------------------------------------------------------
       التنظيف — آمن في أي وقت ومرتين متتاليتين
       ------------------------------------------------------------ */

    /**
     * إغلاق نوافذ الانتظار التي فتحها هذا الملف إن بقيت معلّقة.
     * نافذة الانتظار في App.Notify غير قابلة للإغلاق بالنقر (dismissible: false)
     * فلا بدّ من إغلاقها برمجياً، وإلا بقيت الواجهة محجوبة بعد أي خطأ.
     */
    function closeProgressModals() {
        const backs = document.querySelectorAll('.app-modal-backdrop');
        for (let i = 0; i < backs.length; i++) {
            const b = backs[i];
            if (b.querySelector('.app-modal-body .fa-spinner')) {
                b.classList.remove('show');
                if (b.parentNode) b.parentNode.removeChild(b);
            }
        }
        if (!document.querySelector('.app-modal-backdrop.show')) document.body.style.overflow = '';
    }

    /** حقن قاعدة @page الصفرية وقت الطباعة المولّدة فقط.
     *  سبب وجودها هنا لا في الملف: الصفحات المولّدة بعرض A4 كامل (794×1123)
     *  وتحمل هوامشها داخلياً، فتحتاج هامش صفحة صفرياً. ولو بقيت القاعدة
     *  مطبَّقة دائماً لفقدت الطباعة المباشرة (Ctrl+P) هوامشها وتُقتطع. */
    const PAGE_RULE_ID = 'printLayoutPageRule';

    function injectPageRule() {
        if (document.getElementById(PAGE_RULE_ID)) return;
        const st = document.createElement('style');
        st.id = PAGE_RULE_ID;
        st.textContent = '@page { size: A4 portrait; margin: 0; }';
        (document.head || document.documentElement).appendChild(st);
    }

    function removePageRule() {
        const st = document.getElementById(PAGE_RULE_ID);
        if (st && st.parentNode) st.parentNode.removeChild(st);
    }

    function cleanup() {
        runToken++;

        const h = document.getElementById(HOST_ID);
        if (h) while (h.firstChild) h.removeChild(h.firstChild);

        if (document.body && document.body.classList) {
            PAGE_STATE_CLASSES.forEach(function (c) { document.body.classList.remove(c); });
        }

        removePageRule();
        closeProgressModals();

        if (savedTitle !== null) {
            document.title = savedTitle;
            savedTitle = null;
        }
    }

    return {
        A4: A4,
        available: available,
        footerText: footerText,
        paginate: paginate,
        print: print,
        toPdf: toPdf,
        cleanup: cleanup
    };
})();
