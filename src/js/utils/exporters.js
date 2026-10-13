/* ============================================================
   التصدير والطباعة — Excel و PDF وطباعة المتصفح
   كل المكتبات محلية فلا حاجة للإنترنت.
   ============================================================ */
window.App = window.App || {};

App.Exporters = (function () {
    'use strict';

    const esc = App.Security.esc;

    function hasXLSX() { return typeof window.XLSX !== 'undefined'; }
    function hasHtml2Pdf() { return typeof window.html2pdf !== 'undefined'; }

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
            const ws = XLSX.utils.aoa_to_sheet(s.rows || []);
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

        const ws = XLSX.utils.table_to_sheet(clone, { raw: false });
        ws['!views'] = [{ RTL: true }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, App.Security.safeFileName(sheetName || 'ورقة', 'ورقة').slice(0, 31));
        XLSX.writeFile(wb, fileName || ('تصدير_' + stamp() + '.xlsx'));
        return true;
    }

    /* ------------------------------------------------------------
       PDF: عبر html2pdf على عنصر محدد — بمقاس A4
       ------------------------------------------------------------ */
    function pdfFromElement(element, fileName, opts) {
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
       الطباعة — الطباعة تعطي أفضل جودة عربية (نص متجهي حقيقي)
       ------------------------------------------------------------ */
    function print(title) {
        const prev = document.title;
        if (title) document.title = title;
        window.print();
        setTimeout(() => { document.title = prev; }, 800);
    }

    /** طباعة عنصر معين فقط: نخفي بقية الصفحة مؤقتاً */
    function printElement(element, title) {
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

    return {
        excel: excel,
        excelFromTable: excelFromTable,
        pdfFromElement: pdfFromElement,
        print: print,
        printElement: printElement,
        stamp: stamp,
        download: download,
        hasXLSX: hasXLSX,
        hasHtml2Pdf: hasHtml2Pdf
    };
})();
