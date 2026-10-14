/* ============================================================
   الثوابت والإعدادات الافتراضية
   ============================================================ */
window.App = window.App || {};

App.Constants = (function () {
    'use strict';

    /* مفاتيح التخزين الجديدة (وثيقة واحدة لكل مفتاح) */
    var KEYS = {
        SETTINGS: 'settings',
        LEAVE_TYPES: 'leaveTypes',
        DEPARTMENTS: 'departments',
        STAFF: 'staff',
        HOLIDAYS: 'holidays',
        LEAVES: 'leaves',
        COMPENSATIONS: 'compensations',
        AUDIT: 'audit',
        META: 'meta'
    };

    var ALL_KEYS = [
        KEYS.SETTINGS, KEYS.LEAVE_TYPES, KEYS.DEPARTMENTS, KEYS.STAFF,
        KEYS.HOLIDAYS, KEYS.LEAVES, KEYS.COMPENSATIONS, KEYS.AUDIT, KEYS.META
    ];

    /* مفاتيح النسخة القديمة — للترحيل التلقائي */
    var LEGACY_KEYS = {
        SETTINGS: 'hosp_leave_settings_v3',
        LEAVES: 'hosp_leave_records_v3',
        DEPTS: 'hosp_leave_depts_v3',
        STAFF: 'hosp_leave_staff_v3',
        TYPES: 'hosp_leave_types_v3'
    };

    /* حقول ملف النسخة الاحتياطية القديمة */
    var LEGACY_BACKUP_FIELDS = ['settings', 'departments', 'staffList', 'leaveTypes', 'leavesList'];

    /* حالات سجل الإجازة */
    var STATUS = {
        PENDING: 'pending',
        APPROVED: 'approved',
        REJECTED: 'rejected',
        CANCELLED: 'cancelled'
    };

    var STATUS_LABEL = {
        pending: 'معلّقة',
        approved: 'معتمدة',
        rejected: 'مرفوضة',
        cancelled: 'ملغاة'
    };

    var STATUS_CLASS = {
        pending: 'bg-amber-100 text-amber-800',
        approved: 'bg-emerald-100 text-emerald-800',
        rejected: 'bg-rose-100 text-rose-800',
        cancelled: 'bg-slate-200 text-slate-700'
    };

    /* الحالات التي تُحتسب في كشف التداخل */
    var ACTIVE_STATUSES = [STATUS.PENDING, STATUS.APPROVED];

    /* الإعدادات الافتراضية */
    var DEFAULT_SETTINGS = {
        ministry: 'وزارة الصحة',
        directorate: 'دائرة صحة بغداد / الرصافة',
        hospital: 'مستشفى الكندي التعليمي',
        departmentUnit: 'شعبة الموارد البشرية - وحدة الإجازات',
        footerHR: 'مسؤول الموارد البشرية',
        footerManager: 'مدير المستشفى',
        operatorName: 'موظف الإجازات',
        rptTitle: 'موقف الإجازات اليومي للموظفين',
        /* نص التذييل الثابت أسفل كل صفحة مطبوعة أو مصدَّرة */
        printFooterText: 'طُبع هذا الموقف عبر نظام موقف الإجازات اليومي الموحد - جميع الحقوق محفوظة للمطور: تقني طبي - احمد زياد رحيمه 07723064622',
        logoBase64: '',

        /* سياسة احتساب الأيام — كلها قابلة للتغيير من شاشة الإعدادات */
        holidayMode: 'inside',      // inside = العطلة من ضمن الإجازة ولا تؤثر
                                    // excluded = العطلة تُستثنى ويُستحق يوم تعويضي
        countWeekend: true,         // هل تُحسب أيام الجمعة والسبت من الإجازة
        defaultAnnualBalance: 21,   // الرصيد السنوي الافتراضي للموظف الجديد
        defaultStatus: 'approved'   // حالة السجل الجديد
    };

    /* أيام الراحة الأسبوعية في العراق: الجمعة=5 والسبت=6 (getDay) */
    var WEEKEND_DAYS = [5, 6];

    var WEEKDAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    var MONTH_NAMES = [
        'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
        'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'
    ];

    var MONTH_NAMES_SHORT = [
        'ك2', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
        'تموز', 'آب', 'أيلول', 'ت1', 'ت2', 'ك1'
    ];

    /* أنواع الإجازات الافتراضية عند أول تشغيل */
    var DEFAULT_LEAVE_TYPES = [
        { id: 'lt-annual',   name: 'إجازة اعتيادية', isHourly: false, deductsBalance: true,  color: '#0284c7', isActive: true },
        { id: 'lt-hourly',   name: 'إجازة زمنية',    isHourly: true,  deductsBalance: false, color: '#d97706', isActive: true },
        { id: 'lt-sick',     name: 'إجازة مرضية',    isHourly: false, deductsBalance: false, color: '#7c3aed', isActive: true },
        { id: 'lt-maternity',name: 'إجازة أمومة',    isHourly: false, deductsBalance: false, color: '#db2777', isActive: true },
        { id: 'lt-study',    name: 'إجازة دراسية',   isHourly: false, deductsBalance: false, color: '#0891b2', isActive: true },
        { id: 'lt-forced',   name: 'إجازة إجبارية',  isHourly: false, deductsBalance: false, color: '#64748b', isActive: true },
        { id: 'lt-mission',  name: 'إفاد / مهمة رسمية', isHourly: false, deductsBalance: false, color: '#16a34a', isActive: true }
    ];

    /* الأقسام الافتراضية عند أول تشغيل */
    var DEFAULT_DEPARTMENTS = [
        { id: 'd1', name: 'شعبة الطوارئ', sections: [{ id: 'd1s1', name: 'وحدة الإنعاش' }, { id: 'd1s2', name: 'وحدة الملاحظة' }] },
        { id: 'd2', name: 'قسم العناية المركزة', sections: [{ id: 'd2s1', name: 'العناية الجراحية' }, { id: 'd2s2', name: 'العناية الباطنية' }] },
        { id: 'd3', name: 'قسم الباطنية', sections: [{ id: 'd3s1', name: 'شعبة الباطنية أ' }, { id: 'd3s2', name: 'شعبة الباطنية ب' }] },
        { id: 'd4', name: 'قسم الجراحة العامة', sections: [{ id: 'd4s1', name: 'شعبة الجراحة' }, { id: 'd4s2', name: 'جراحة اليوم الواحد' }] },
        { id: 'd5', name: 'قسم العمليات', sections: [{ id: 'd5s1', name: 'صالة العمليات الكبرى' }, { id: 'd5s2', name: 'التعقيم المركزي' }] },
        { id: 'd6', name: 'قسم الخدمات الإدارية', sections: [{ id: 'd6s1', name: 'شعبة الموارد البشرية' }, { id: 'd6s2', name: 'شعبة الحسابات' }, { id: 'd6s3', name: 'شعبة الصيانة' }] }
    ];

    /* قالب العطل الرسمية العراقية الثابتة (تاريخ ميلادي، تتكرر سنوياً) */
    var IRAQ_HOLIDAY_TEMPLATE = [
        { month: 1,  day: 1,  name: 'رأس السنة الميلادية' },
        { month: 1,  day: 6,  name: 'عيد الجيش العراقي' },
        { month: 3,  day: 21, name: 'عيد نوروز' },
        { month: 5,  day: 1,  name: 'عيد العمال' },
        { month: 7,  day: 14, name: 'عيد ثورة 14 تموز' },
        { month: 10, day: 3,  name: 'عيد الاستقلال' },
        { month: 12, day: 10, name: 'يوم النصر' }
    ];

    /* العطل المتحركة — تُدخل يدوياً لأنها هجرية */
    var MOVABLE_HOLIDAY_HINT = [
        'عيد الفطر', 'عيد الأضحى', 'المولد النبوي', 'عاشوراء',
        'عيد الغدير', 'رأس السنة الهجرية', 'الإسراء والمعراج'
    ];

    /* معلومات المطوّر — تظهر في «حول النظام» وفي تذييل كل صفحة مطبوعة */
    var DEVELOPER = {
        name: 'احمد زياد رحيمه',
        title: 'تقني طبي',
        phone: '07723064622',
        system: 'نظام موقف الإجازات اليومي الموحد'
    };

    function uid(prefix) {
        return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
               Math.random().toString(36).slice(2, 8);
    }

    return {
        KEYS: KEYS,
        DEVELOPER: DEVELOPER,
        ALL_KEYS: ALL_KEYS,
        LEGACY_KEYS: LEGACY_KEYS,
        LEGACY_BACKUP_FIELDS: LEGACY_BACKUP_FIELDS,
        STATUS: STATUS,
        STATUS_LABEL: STATUS_LABEL,
        STATUS_CLASS: STATUS_CLASS,
        ACTIVE_STATUSES: ACTIVE_STATUSES,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        WEEKEND_DAYS: WEEKEND_DAYS,
        WEEKDAY_NAMES: WEEKDAY_NAMES,
        MONTH_NAMES: MONTH_NAMES,
        MONTH_NAMES_SHORT: MONTH_NAMES_SHORT,
        DEFAULT_LEAVE_TYPES: DEFAULT_LEAVE_TYPES,
        DEFAULT_DEPARTMENTS: DEFAULT_DEPARTMENTS,
        IRAQ_HOLIDAY_TEMPLATE: IRAQ_HOLIDAY_TEMPLATE,
        MOVABLE_HOLIDAY_HINT: MOVABLE_HOLIDAY_HINT,
        uid: uid,
        APP_VERSION: '1.0.1',
        SCHEMA_VERSION: 2
    };
})();
