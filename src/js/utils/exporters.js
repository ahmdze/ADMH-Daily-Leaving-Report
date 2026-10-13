/* ============================================================
   التصدير والطباعة — Excel و PDF وطباعة المتصفح
   كل المكتبات محلية فلا حاجة للإنترنت.

   ملاحظة مهمة حول PDF والطباعة:
   لم يعد التصدير يعتمد على html2pdf لتقسيم الصفحات، لأن jsPDF لا
   يُشكّل العربية. المسار الأساسي الآن هو App.PrintLayout: يبني
   صفحات A4 حقيقية في DOM (بترويسة متكررة وتذييل مع «الصفحة X من Y»)،
   ثم إمّا يطبعها أو يحوّل كل صفحة إلى صورة داخل jsPDF.
   ويبقى المسار القديم (html2pdf / window.print) احتياطاً فقط عند غياب
   المكتبات.
   ============================================================ */
window.App = window.App || {};

App.Exporters = (function () {
    'use strict';

    function hasXLSX() { return typeof window.XLSX !== 'undefined'; }
    function hasHtml2Pdf() { return typeof window.html2pdf !== 'undefined'; }

    /** هل محرّك الصفحات الجديد جاهز؟ */
    function hasPrintLayout() {
        return !!(window.App && App.PrintLayout &&
            typeof App.PrintLayout.paginate === 'function' &&
            typeof App.PrintLayout.print === 'function' &&
            typeof App.PrintLayout.toPdf === 'function' &&
            typeof App.PrintLayout.cleanup === 'function');
    }

    function stamp() {
        const d = new Date();
        return App.Dates.toISO(d) + '_' + App.Dates.pad2(d.getHours()) + App.Dates.pad2(d.getMinutes());
    }

    function download(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    /**
     * سطر التذييل الثابت — يُضاف آخر كل ورقة Excel كما يظهر أسفل كل صفحة مطبوعة.
     * نصّه من الإعدادات فيبقى قابلاً للتعديل.
     */
    function footerLine() {
        let s = null;
        try { s = App.Store && App.Store.get ? App.Store.get.settings() : null; } catch (e) { s = null; }
        return (s && s.printFooterText) ||
            (App.Constants && App.Constants.DEFAULT_SETTINGS
                ? App.Constants.DEFAULT_SETTINGS.printFooterText : '');
    }

    /** يُلحق سطر التذييل بورقة Excel (صف واحد فارغ قبله للفصل) */
    function appendFooter(ws) {
        const text = footerLine();
        if (!text) return;
        XLSX.utils.sheet_add_aoa(ws, [[''], [text]], { origin: -1 });
    }

    /* ------------------------------------------------------------
       Excel: عدة أوراق من مصفوفات صفوف
       sheets = [{ name, rows: [[...],[...]], widths: [12, 20] }]
       ------------------------------------------------------------ */
    function excel(sheets, fileName) {
        if (!hasXLSX()) {
            App.Notify.alert('مكتبة Excel المحلية لم تُحمّل. تأكد من وجود assets/js/xlsx.full.min.js', 'error');
            return false;
        }
        const wb = XLSX.utils.book_new();

        sheets.forEach(s => {
            const rows = (s.rows || []).slice();
            /* التذييل الثابت آخر كل ورقة */
            rows.push([''], [footerLine()]);
            const ws = XLSX.utils.aoa_to_sheet(rows);
            if (s.widths) ws['!cols'] = s.widths.map(w => ({ wch: w }));
            /* اتجاه الورقة من اليمين لليسار */
            if (!ws['!views']) ws['!views'] = [{ RTL: true }];
            const safeName = App.Security.safeFileName(s.name, 'ورقة').slice(0, 31);
            XLSX.utils.book_append_sheet(wb, ws, safeName);
        });

        XLSX.writeFile(wb, fileName || ('تصدير_' + stamp() + '.xlsx'));
        return true;
    }

    /** تصدير جدول HTML موجود مع استثناء الأعمدة المعلّمة بـ no-export */
    function excelFromTable(tableEl, fileName, sheetName) {
        if (!tableEl) return false;
        if (!hasXLSX()) {
            App.Notify.alert('مكتبة Excel المحلية لم تُحمّل.', 'error');
            return false;
        }
        const clone = tableEl.cloneNode(true);

        /* نحذف الأعمدة التي لا تُصدَّر (أعمدة الإجراءات) */
        const headRow = clone.querySelector('thead tr');
        const dropIdx = [];
        if (headRow) {
            Array.from(headRow.children).forEach((th, i) => {
                if (th.classList.contains('no-print') || th.classList.contains('no-export')) dropIdx.push(i);
            });
        }
        if (dropIdx.length) {
            clone.querySelectorAll('tr').forEach(tr => {
                dropIdx.slice().reverse().forEach(i => {
                    if (tr.children[i]) tr.deleteCell(i);
                });
            });
        }
        /* إزالة الأيقونات من الرأس */
        clone.querySelectorAll('i').forEach(i => i.remove());

        /* الخلايا المكوّنة من أسطر متعددة (القسم ثم الشعبة، والمدة ثم التاريخ)
           تُدمج في Excel كنص واحد فتتلاصق الكلمات («قسم الباطنيةشعبة الباطنية أ»).
           نُدخل فاصلاً بين الأسطر، بمسافة غير قابلة للطي (U+00A0) لأن المسافة
           العادية تُطوى عند استخراج نص الخلية. */
        clone.querySelectorAll('td').forEach(td => {
            let blocks;
            try { blocks = td.querySelectorAll(':scope > div, :scope > p'); }
            catch (e) { blocks = []; }
            for (let i = 1; i < blocks.length; i++) {
                blocks[i].insertAdjacentText('beforebegin', '\u00A0-\u00A0');
            }
        });

        const ws = XLSX.utils.table_to_sheet(clone, { raw: false });
        ws['!views'] = [{ RTL: true }];
        /* التذييل الثابت آخر الورقة كما في المطبوع */
        appendFooter(ws);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, App.Security.safeFileName(sheetName || 'ورقة', 'ورقة').slice(0, 31));
        XLSX.writeFile(wb, fileName || ('تصدير_' + stamp() + '.xlsx'));
        return true;
    }

    /* ------------------------------------------------------------
       المسار الاحتياطي القديم: html2pdf على عنصر محدد
       يعمل فقط عند غياب html2canvas أو jsPDF (مسار App.PrintLayout).
       ------------------------------------------------------------ */
    function legacyPdf(element, fileName, opts) {
        if (!element) return Promise.reject(new Error('لا يوجد محتوى للتصدير'));
        if (!hasHtml2Pdf()) {
            App.Notify.alert('مكتبة PDF المحلية لم تُحمّل. يمكنك استخدام زر الطباعة ثم «حفظ كـ PDF».', 'error');
            return Promise.reject(new Error('html2pdf غير متاح'));
        }
        opts = opts || {};

        const hidden = [];
        element.querySelectorAll('.no-print').forEach(el => {
            hidden.push([el, el.style.display]);
            el.style.display = 'none';
        });

        const opt = {
            margin: opts.margin || [8, 8, 12, 8],
            filename: fileName || ('تصدير_' + stamp() + '.pdf'),
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: {
                scale: opts.scale || 2,
                useCORS: true,
                scrollY: 0,
                backgroundColor: '#ffffff',
                windowWidth: element.scrollWidth
            },
            jsPDF: { unit: 'mm', format: 'a4', orientation: opts.orientation || 'portrait' },
            pagebreak: { mode: ['css', 'legacy'] }
        };

        const restore = () => hidden.forEach(([el, v]) => { el.style.display = v === undefined ? '' : v; });

        const busy = App.Notify.busy('جارٍ إنشاء ملف PDF...');
        return window.html2pdf().set(opt).from(element).save()
            .then(() => { restore(); busy.close(); return true; })
            .catch(err => {
                restore();
                busy.close();
                console.error('PDF export failed', err);
                App.Notify.alert('تعذّر إنشاء ملف PDF. جرّب زر الطباعة ثم «حفظ كـ PDF» للحصول على جودة أفضل.', 'error');
                throw err;
            });
    }

    /* ------------------------------------------------------------
       PDF: عبر محرّك صفحات A4 الحقيقي
       ------------------------------------------------------------ */
    function pdfFromElement(element, fileName, opts) {
        if (!element) {
            App.Notify.alert('لا يوجد محتوى للتصدير.', 'error');
            return Promise.resolve({ pages: 0 });
        }

        if (hasPrintLayout() && App.PrintLayout.available()) {
            return App.PrintLayout.toPdf(element, fileName, opts);
        }

        /* احتياط: المكتبات ناقصة → نسلك المسار القديم */
        return legacyPdf(element, fileName, opts);
    }

    /* ------------------------------------------------------------
       الطباعة — الطباعة تعطي أفضل جودة عربية (نص متجهي حقيقي)
       ------------------------------------------------------------ */
    function print(title) {
        const prev = document.title;
        if (title) document.title = title;
        window.print();
        setTimeout(() => { document.title = prev; }, 800);
    }

    /** المسار الاحتياطي القديم: عزل عنصر واحد عبر visibility */
    function legacyPrintElement(element, title) {
        if (!element) return print(title);
        const marker = 'print-isolate-' + Date.now();
        element.classList.add(marker);

        const style = document.createElement('style');
        style.id = marker + '-style';
        style.textContent =
            '@media print{body *{visibility:hidden !important;}' +
            '.' + marker + ', .' + marker + ' *{visibility:visible !important;}' +
            '.' + marker + '{position:absolute;left:0;top:0;width:100%;}' +
            '.no-print{display:none !important;}}';
        document.head.appendChild(style);

        const prev = document.title;
        if (title) document.title = title;
        window.print();

        setTimeout(() => {
            document.title = prev;
            const s = document.getElementById(marker + '-style');
            if (s) s.remove();
            element.classList.remove(marker);
        }, 1000);
    }

    /** طباعة عنصر معين فقط بصفحات A4 مولّدة */
    function printElement(element, title, opts) {
        if (!element) return print(title);

        if (hasPrintLayout()) {
            return App.PrintLayout.print(element, title, opts);
        }

        return legacyPrintElement(element, title);
    }

    return {
        excel: excel,
        excelFromTable: excelFromTable,
        pdfFromElement: pdfFromElement,
        print: print,
        printElement: printElement,
        stamp: stamp,
        download: download,
        hasXLSX: hasXLSX,
        hasHtml2Pdf: hasHtml2Pdf,
        hasPrintLayout: hasPrintLayout
    };
})();
