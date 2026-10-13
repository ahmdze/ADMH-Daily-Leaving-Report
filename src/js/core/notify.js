/* ============================================================
   نظام النوافذ المنبثقة والتنبيهات — بديل كامل عن alert/confirm/prompt
   ============================================================ */
window.App = window.App || {};

App.Notify = (function () {
    'use strict';

    var esc = App.Security.esc;

    var TYPE_STYLE = {
        success: { icon: 'fa-circle-check',        color: 'text-emerald-600', ring: 'bg-emerald-50' },
        error:   { icon: 'fa-circle-xmark',        color: 'text-rose-600',    ring: 'bg-rose-50' },
        warning: { icon: 'fa-triangle-exclamation',color: 'text-amber-600',   ring: 'bg-amber-50' },
        info:    { icon: 'fa-circle-info',         color: 'text-brand-600',   ring: 'bg-brand-50' },
        question:{ icon: 'fa-circle-question',     color: 'text-violet-600',  ring: 'bg-violet-50' }
    };

    var VARIANTS = {
        primary: 'bg-brand-600 hover:bg-brand-700 text-white',
        danger:  'bg-rose-600 hover:bg-rose-700 text-white',
        success: 'bg-emerald-600 hover:bg-emerald-700 text-white',
        warning: 'bg-amber-500 hover:bg-amber-600 text-white',
        ghost:   'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300'
    };

    var openCount = 0;

    function toastHost() {
        var host = document.getElementById('toastHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'toastHost';
            document.body.appendChild(host);
        }
        return host;
    }

    /* ------------------------------------------------------------
       نافذة منبثقة عامة
       cfg: { title, message, contentHtml, contentNode, type, wide,
              actions:[{label, value, variant, icon}], dismissible }
       تُرجع Promise بقيمة الإجراء المختار (أو null عند الإغلاق)
       ------------------------------------------------------------ */
    function open(cfg) {
        cfg = cfg || {};
        var type = TYPE_STYLE[cfg.type] ? cfg.type : 'info';
        var style = TYPE_STYLE[type];

        return new Promise(function (resolve) {
            var backdrop = document.createElement('div');
            backdrop.className = 'app-modal-backdrop';

            var modal = document.createElement('div');
            modal.className = 'app-modal' + (cfg.wide ? ' wide' : '');
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');

            /* الرأس */
            var head = document.createElement('div');
            head.className = 'flex items-start gap-3 px-5 pt-4 pb-3 border-b border-slate-200';

            var iconWrap = document.createElement('div');
            iconWrap.className = 'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ' + style.ring;
            var icon = document.createElement('i');
            icon.className = 'fa-solid ' + style.icon + ' ' + style.color;
            iconWrap.appendChild(icon);

            var titleWrap = document.createElement('div');
            titleWrap.className = 'flex-1 min-w-0';
            var h = document.createElement('h3');
            h.className = 'font-extrabold text-sm text-slate-800 leading-tight';
            h.textContent = cfg.title || '';
            titleWrap.appendChild(h);
            head.appendChild(iconWrap);
            head.appendChild(titleWrap);

            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'text-slate-400 hover:text-slate-700 p-1 -m-1 shrink-0';
            closeBtn.setAttribute('aria-label', 'إغلاق');
            closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            head.appendChild(closeBtn);

            /* المتن */
            var body = document.createElement('div');
            body.className = 'app-modal-body text-sm text-slate-700';

            if (cfg.message) {
                var p = document.createElement('p');
                p.className = 'leading-relaxed whitespace-pre-line';
                p.textContent = cfg.message;
                body.appendChild(p);
            }
            if (cfg.contentNode) {
                body.appendChild(cfg.contentNode);
            } else if (cfg.contentHtml) {
                /* المحتوى الداخلي يُبنى في الوحدات بعد تهريب كل مدخلاته */
                var holder = document.createElement('div');
                holder.innerHTML = cfg.contentHtml;
                body.appendChild(holder);
            }

            /* الأقدام */
            var foot = document.createElement('div');
            foot.className = 'flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50';

            var actions = cfg.actions && cfg.actions.length
                ? cfg.actions
                : [{ label: 'حسناً', value: true, variant: 'primary' }];

            var settled = false;

            function close(value) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey, true);
                backdrop.classList.remove('show');
                setTimeout(function () {
                    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                    openCount = Math.max(0, openCount - 1);
                    if (openCount === 0) document.body.style.overflow = '';
                }, 170);
                resolve(value);
            }

            actions.forEach(function (a, idx) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ' +
                    (VARIANTS[a.variant] || VARIANTS.primary);
                if (a.icon) {
                    var bi = document.createElement('i');
                    bi.className = 'fa-solid ' + a.icon;
                    btn.appendChild(bi);
                }
                btn.appendChild(document.createTextNode(a.label));
                btn.addEventListener('click', function () { close(a.value); });
                foot.appendChild(btn);
                if (idx === actions.length - 1) setTimeout(function () { btn.focus(); }, 60);
            });

            function onKey(e) {
                if (e.key === 'Escape' && cfg.dismissible !== false) {
                    e.stopPropagation();
                    close(null);
                }
            }
            document.addEventListener('keydown', onKey, true);

            closeBtn.addEventListener('click', function () {
                if (cfg.dismissible !== false) close(null);
            });
            backdrop.addEventListener('mousedown', function (e) {
                if (e.target === backdrop && cfg.dismissible !== false) close(null);
            });

            modal.appendChild(head);
            modal.appendChild(body);
            modal.appendChild(foot);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            openCount++;
            if (openCount === 1) document.body.style.overflow = 'hidden';

            requestAnimationFrame(function () { backdrop.classList.add('show'); });

            /* إتاحة الإغلاق البرمجي للمنادِينَ (مثل نافذة الانتظار) */
            if (typeof cfg.onReady === 'function') {
                cfg.onReady({ close: close, root: backdrop, body: body, modal: modal });
            }
        });
    }

    /* ---------------- واجهات جاهزة ---------------- */

    function alertBox(message, type, title) {
        return open({
            title: title || ({ success: 'تم', error: 'خطأ', warning: 'تنبيه' }[type] || 'معلومة'),
            message: message,
            type: type || 'info',
            actions: [{ label: 'حسناً', value: true, variant: 'primary' }]
        });
    }

    function confirmBox(message, opts) {
        opts = opts || {};
        return open({
            title: opts.title || 'تأكيد',
            message: message,
            type: opts.type || 'question',
            actions: [
                { label: opts.cancelText || 'إلغاء', value: false, variant: 'ghost' },
                { label: opts.confirmText || 'تأكيد', value: true, variant: opts.danger ? 'danger' : 'primary', icon: opts.icon }
            ]
        }).then(function (v) { return v === true; });
    }

    function promptBox(message, defaultValue, opts) {
        opts = opts || {};
        var wrap = document.createElement('div');
        wrap.className = 'space-y-2 mt-1';
        var input = document.createElement('input');
        input.type = opts.inputType || 'text';
        input.className = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500';
        input.value = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.maxLength) input.maxLength = opts.maxLength;
        wrap.appendChild(input);

        return open({
            title: opts.title || 'إدخال',
            message: message,
            type: opts.type || 'question',
            contentNode: wrap,
            actions: [
                { label: opts.cancelText || 'إلغاء', value: '__cancel__', variant: 'ghost' },
                { label: opts.confirmText || 'موافق', value: '__ok__', variant: 'primary' }
            ]
        }).then(function (v) {
            if (v !== '__ok__') return null;
            return App.Security.clean(input.value, opts.maxLength);
        });
    }

    /* نافذة إدخال متعددة الحقول */
    function formBox(cfg) {
        /* cfg: { title, message, type, fields:[{name,label,type,value,options,required,hint}], confirmText } */
        var wrap = document.createElement('div');
        wrap.className = 'space-y-3 mt-1';
        var inputs = {};

        (cfg.fields || []).forEach(function (f) {
            var box = document.createElement('div');
            var label = document.createElement('label');
            label.className = 'block text-xs font-bold text-slate-600 mb-1';
            label.textContent = f.label;
            box.appendChild(label);

            var inp;
            if (f.type === 'select') {
                inp = document.createElement('select');
                (f.options || []).forEach(function (o) {
                    var opt = document.createElement('option');
                    opt.value = o.value;
                    opt.textContent = o.label;
                    inp.appendChild(opt);
                });
                inp.value = f.value === undefined ? '' : String(f.value);
            } else if (f.type === 'checkbox') {
                inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.checked = !!f.value;
                inp.className = 'w-4 h-4 accent-brand-600';
            } else {
                inp = document.createElement('input');
                inp.type = f.type || 'text';
                inp.value = f.value === undefined ? '' : String(f.value);
                if (f.placeholder) inp.placeholder = f.placeholder;
                if (f.min !== undefined) inp.min = f.min;
                if (f.max !== undefined) inp.max = f.max;
            }
            if (inp.tagName !== 'INPUT' || inp.type !== 'checkbox') {
                inp.className = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500';
            }
            inp.dataset.fieldName = f.name;
            inputs[f.name] = inp;
            box.appendChild(inp);

            if (f.hint) {
                var hint = document.createElement('p');
                hint.className = 'text-[11px] text-slate-500 mt-1';
                hint.textContent = f.hint;
                box.appendChild(hint);
            }
            wrap.appendChild(box);
        });

        return open({
            title: cfg.title,
            message: cfg.message,
            type: cfg.type || 'question',
            contentNode: wrap,
            wide: cfg.wide,
            actions: [
                { label: cfg.cancelText || 'إلغاء', value: '__cancel__', variant: 'ghost' },
                { label: cfg.confirmText || 'حفظ', value: '__ok__', variant: 'primary', icon: 'fa-check' }
            ]
        }).then(function (v) {
            if (v !== '__ok__') return null;
            var out = {};
            Object.keys(inputs).forEach(function (name) {
                var inp = inputs[name];
                out[name] = inp.type === 'checkbox' ? inp.checked : App.Security.clean(inp.value);
            });
            return out;
        });
    }

    /* ---------------- التنبيه السريع ---------------- */
    function toast(message, type, duration) {
        var host = toastHost();
        var t = document.createElement('div');
        t.className = 'toast ' + (type || 'info');

        var style = TYPE_STYLE[type] || TYPE_STYLE.info;
        var icon = document.createElement('i');
        icon.className = 'fa-solid ' + style.icon + ' ' + style.color + ' mt-0.5';
        var span = document.createElement('span');
        span.className = 'flex-1';
        span.textContent = message;

        t.appendChild(icon);
        t.appendChild(span);
        host.appendChild(t);

        var ms = duration || 3200;
        setTimeout(function () {
            t.classList.add('hide');
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
        }, ms);
        return t;
    }

    /* نافذة انتظار — تُغلق برمجياً عبر الكائن المُعاد */
    function busy(message) {
        var box = document.createElement('div');
        box.className = 'flex items-center gap-3';
        var icon = document.createElement('i');
        icon.className = 'fa-solid fa-spinner fa-spin text-brand-600 text-lg';
        var span = document.createElement('span');
        span.className = 'text-sm font-semibold text-slate-600';
        span.textContent = message || 'جارٍ التنفيذ...';
        box.appendChild(icon);
        box.appendChild(span);

        var handle = { close: function () { } };
        var promise = open({
            title: 'يرجى الانتظار',
            contentNode: box,
            type: 'info',
            dismissible: false,
            actions: [],
            onReady: function (api) { handle.close = api.close; }
        });
        handle.done = promise;
        return handle;
    }

    return {
        open: open,
        alert: alertBox,
        confirm: confirmBox,
        prompt: promptBox,
        form: formBox,
        toast: toast,
        busy: busy
    };
})();
