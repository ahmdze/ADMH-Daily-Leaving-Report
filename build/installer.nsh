; ============================================================================
;  ADMH-Leaves — صفحة معالج التثبيت: «بيانات المؤسسة والإعدادات الأولية»
;  ملف مضمَّن عبر build.nsis.include في package.json (electron-builder).
;
;  ملاحظات مهمة لمن يعدّل هذا الملف:
;   1) الملف محفوظ بترميز UTF-8 **مع BOM** — بدونه يقرأ NSIS النصوص العربية
;      بترميز ANSI وتتحوّل إلى رموز مشوّهة. لا تحفظه بترميز آخر.
;   2) الكتابة في install-config.txt تكون بـ FileWriteUTF16LE، مع كتابة BOM
;      يدوياً بـ FileWriteByte 255 ثم 254 (نسخة NSIS المرفقة لا تكتبه تلقائياً)،
;      لأن التطبيق يتعرّف على الترميز من أول بايتين. لا تستخدم FileWrite.
;   3) لا يوجد أي Abort في دالة المغادرة (Leave)، فإن ألغى المستخدم الصفحة أو
;      رجع للخلف يكمل التثبيت طبيعياً بالقيم الافتراضية.
;   4) الكتابة الفعلية للملف تحدث في customInstall (داخل قسم التثبيت) وليس في
;      دالة المغادرة، لأن electron-builder قد يضيف اسم التطبيق إلى $INSTDIR في
;      مرحلة لاحقة للصفحات. وبهذا يعمل الملف أيضاً في التثبيت الصامت /S.
;   5) إلغاء التثبيت يحذف install-config.txt فقط — لا بيانات المستخدم ولا مجلد
;      النسخ الاحتياطي (deleteAppDataOnUninstall=false في package.json).
;
;  هندسة الصفحة: صفحات Modern UI مقاسها 300x140 وحدة حوار (dialog units)،
;  والإحداثيات تقبل u (وحدة حوار) أو % (نسبة من مقاس الصفحة).
;  التخطيط من اليمين إلى اليسار: عمود العناوين على اليمين والحقول على يساره.
; ============================================================================

; كل ما يلي خاص بالمُثبِّت فقط. في تمريرة بناء المُلغِي يُعرَّف BUILD_UNINSTALLER،
; ودوال المُثبِّت تصبح غير مستدعاة هناك فيُصدر NSIS تحذير 6010، وelectron-builder
; يعامل التحذيرات كأخطاء (-WX) فيفشل البناء. لذلك نستثنيها صراحةً.
!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; ---------------------------------------------------------------- الافتراضيات
!define ADHM_DEF_MINISTRY    "وزارة الصحة"
!define ADHM_DEF_DIRECTORATE "دائرة الصحة"
!define ADHM_DEF_HOSPITAL    "المستشفى"
!define ADHM_DEF_DEPARTMENT  "شعبة الموارد البشرية - وحدة الإجازات"
!define ADHM_DEF_FOOTER_HR   "مسؤول الموارد البشرية"
!define ADHM_DEF_FOOTER_MGR  "مدير المستشفى"
!define ADHM_DEF_OPERATOR    "موظف الإجازات"
!define ADHM_DEF_BALANCE     "21"

; ------------------------------------------------------------- متغيرات عامة
Var ADHM_Ministry
Var ADHM_Directorate
Var ADHM_Hospital
Var ADHM_DepartmentUnit
Var ADHM_FooterHR
Var ADHM_FooterManager
Var ADHM_OperatorName
Var ADHM_Balance
Var ADHM_Backup

Var ADHM_Dlg
Var ADHM_CtlMinistry
Var ADHM_CtlDirectorate
Var ADHM_CtlHospital
Var ADHM_CtlDepartmentUnit
Var ADHM_CtlFooterHR
Var ADHM_CtlFooterManager
Var ADHM_CtlOperatorName
Var ADHM_CtlBalance
Var ADHM_CtlBackup

; ============================================================ دوال مساعدة
; يجعل عنصر التحكم الموجود أعلى المكدس بمحاذاة يمينية وترتيب قراءة عربي:
; SS_RIGHT/ES_RIGHT + WS_EX_RIGHT|WS_EX_RTLREADING  (0x3000 = 12288)
; يُستدعى هكذا:  Push $0 / Call ADHM_RtlControl
; ملاحظة: لا يُستدعى على أزرار الضغط (لأن OR مع 2 يحوّل BS_PUSHBUTTON إلى
; CheckBox) ولا على حقل المسار (لأن ترتيب أجزاء المسار اللاتيني يختلّ).
Function ADHM_RtlControl
  Exch $9
  Push $8
  ; نمط النص: إزالة محاذاة اليسار (أول 4 بتات) ثم فرض المحاذاة اليمينية
  System::Call 'user32::GetWindowLongW(p r9, i -16) i .r8'
  IntOp $8 $8 & -16
  IntOp $8 $8 | 2
  System::Call 'user32::SetWindowLongW(p r9, i -16, i r8) i .r8'
  ; النمط الموسّع: WS_EX_RIGHT | WS_EX_RTLREADING = 12288
  System::Call 'user32::GetWindowLongW(p r9, i -20) i .r8'
  IntOp $8 $8 | 12288
  System::Call 'user32::SetWindowLongW(p r9, i -20, i r8) i .r8'
  Pop $8
  Pop $9
FunctionEnd

; حذف الفراغات من طرفي النص الموجود في $R9
Function ADHM_TrimR9
  Push $R8
  adhm_trim_lead:
    StrCpy $R8 $R9 1
    StrCmp $R8 " " 0 adhm_trim_tail
    StrCpy $R9 $R9 "" 1
    Goto adhm_trim_lead
  adhm_trim_tail:
    StrCpy $R8 $R9 1 -1
    StrCmp $R8 " " 0 adhm_trim_done
    StrCpy $R9 $R9 -1
    Goto adhm_trim_tail
  adhm_trim_done:
  Pop $R8
FunctionEnd

; كتابة install-config.txt بجانب الملف التنفيذي — UTF-16LE مع BOM
; المفاتيح ثابتة بهذا الترتيب، سطر لكل مفتاح بصيغة key=value
Function ADHM_WriteConfig
  Push $9
  ClearErrors
  FileOpen $9 "$INSTDIR\install-config.txt" w
  ${If} $9 != ""
    ; علامة الترميز (BOM) تُكتب يدوياً: FileWriteUTF16LE في NSIS 3.0.4.1 لا
    ; يكتبها تلقائياً، والتطبيق يتعرّف على UTF-16LE من أول بايتين FF FE.
    FileWriteByte $9 255
    FileWriteByte $9 254
    FileWriteUTF16LE $9 "ministry=$ADHM_Ministry$\r$\n"
    FileWriteUTF16LE $9 "directorate=$ADHM_Directorate$\r$\n"
    FileWriteUTF16LE $9 "hospital=$ADHM_Hospital$\r$\n"
    FileWriteUTF16LE $9 "departmentUnit=$ADHM_DepartmentUnit$\r$\n"
    FileWriteUTF16LE $9 "footerHR=$ADHM_FooterHR$\r$\n"
    FileWriteUTF16LE $9 "footerManager=$ADHM_FooterManager$\r$\n"
    FileWriteUTF16LE $9 "operatorName=$ADHM_OperatorName$\r$\n"
    FileWriteUTF16LE $9 "defaultAnnualBalance=$ADHM_Balance$\r$\n"
    FileWriteUTF16LE $9 "backupFolder=$ADHM_Backup$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
FunctionEnd

; ================================================== تهيئة القيم الافتراضية
; يعمل قبل ظهور أي صفحة، فيغطي التثبيت الصامت (/S) حيث لا تظهر الصفحات.
; (customInit تُدرج بعد initMultiUser، لذا $DOCUMENTS = مستندات المستخدم)
!macro customInit
  StrCpy $ADHM_Ministry       "${ADHM_DEF_MINISTRY}"
  StrCpy $ADHM_Directorate    "${ADHM_DEF_DIRECTORATE}"
  StrCpy $ADHM_Hospital       "${ADHM_DEF_HOSPITAL}"
  StrCpy $ADHM_DepartmentUnit "${ADHM_DEF_DEPARTMENT}"
  StrCpy $ADHM_FooterHR       "${ADHM_DEF_FOOTER_HR}"
  StrCpy $ADHM_FooterManager  "${ADHM_DEF_FOOTER_MGR}"
  StrCpy $ADHM_OperatorName   "${ADHM_DEF_OPERATOR}"
  StrCpy $ADHM_Balance        "${ADHM_DEF_BALANCE}"
  StrCpy $ADHM_Backup         "$DOCUMENTS\ADMH-Leaves-Backups"
!macroend

; ============================================================ الصفحة المخصّصة
Function ADHM_SettingsPageCreate
  ; نص ترويسة الصفحة في شريط المعلومـات العلوي (1037 = العنوان، 1038 = السطر
  ; التوضيحي) — نفس أثر MUI_HEADER_TEXT تماماً، لكن دون استدعائه لأن هذا الملف
  ; يُضمَّنه electron-builder **قبل** تحميل MUI2 فيكون الماكرو غير معرَّف بعد.
  ; $0 مستخدم هنا مؤقتاً فقط.
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:بيانات المؤسسة والإعدادات الأولية"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:تُحفظ هذه البيانات مع البرنامج وتُقرأ عند أول تشغيل، ويمكن تعديلها لاحقاً من شاشة الإعدادات."

  nsDialogs::Create 1018
  Pop $ADHM_Dlg
  ${If} $ADHM_Dlg == error
    Abort
  ${EndIf}

  ; ------------------------------------------------------------ مقدّمة الصفحة
  ${NSD_CreateLabel} 0 0u 100% 16u "أدخل بيانات مؤسستك كما تريد أن تظهر في ترويسة الموقف المطبوع والتقارير، وحدّد مجلد النسخ الاحتياطي. اترك أي حقل فارغاً لاستخدام القيمة الافتراضية."
  Pop $0
  Push $0
  Call ADHM_RtlControl

  ; ----------------------------------- الصف الأول: الوزارة (يمين) | الدائرة
  ${NSD_CreateLabel} 76% 23u 24% 11u "الوزارة"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 48% 22u 27% 12u "$ADHM_Ministry"
  Pop $ADHM_CtlMinistry
  SendMessage $ADHM_CtlMinistry 0x00C5 80 0
  Push $ADHM_CtlMinistry
  Call ADHM_RtlControl

  ${NSD_CreateLabel} 29% 23u 19% 11u "الدائرة"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 0 22u 27% 12u "$ADHM_Directorate"
  Pop $ADHM_CtlDirectorate
  SendMessage $ADHM_CtlDirectorate 0x00C5 80 0
  Push $ADHM_CtlDirectorate
  Call ADHM_RtlControl

  ; -------------------------- الصف الثاني: المستشفى / المؤسسة | القسم / الوحدة
  ${NSD_CreateLabel} 76% 41u 24% 11u "المستشفى / المؤسسة"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 48% 40u 27% 12u "$ADHM_Hospital"
  Pop $ADHM_CtlHospital
  SendMessage $ADHM_CtlHospital 0x00C5 80 0
  Push $ADHM_CtlHospital
  Call ADHM_RtlControl

  ${NSD_CreateLabel} 29% 41u 19% 11u "القسم / الوحدة"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 0 40u 27% 12u "$ADHM_DepartmentUnit"
  Pop $ADHM_CtlDepartmentUnit
  SendMessage $ADHM_CtlDepartmentUnit 0x00C5 100 0
  Push $ADHM_CtlDepartmentUnit
  Call ADHM_RtlControl

  ; ----------------------------------- الصف الثالث: توقيع أول | توقيع ثانٍ
  ${NSD_CreateLabel} 76% 59u 24% 11u "توقيع أول (يمين)"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 48% 58u 27% 12u "$ADHM_FooterHR"
  Pop $ADHM_CtlFooterHR
  SendMessage $ADHM_CtlFooterHR 0x00C5 80 0
  Push $ADHM_CtlFooterHR
  Call ADHM_RtlControl

  ${NSD_CreateLabel} 29% 59u 19% 11u "توقيع ثانٍ (يسار)"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 0 58u 27% 12u "$ADHM_FooterManager"
  Pop $ADHM_CtlFooterManager
  SendMessage $ADHM_CtlFooterManager 0x00C5 80 0
  Push $ADHM_CtlFooterManager
  Call ADHM_RtlControl

  ; --------------------------- الصف الرابع: اسم مشغّل النظام | الرصيد السنوي
  ${NSD_CreateLabel} 76% 77u 24% 11u "اسم مشغّل النظام"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 48% 76u 27% 12u "$ADHM_OperatorName"
  Pop $ADHM_CtlOperatorName
  SendMessage $ADHM_CtlOperatorName 0x00C5 80 0
  Push $ADHM_CtlOperatorName
  Call ADHM_RtlControl

  ${NSD_CreateLabel} 29% 77u 19% 11u "الرصيد السنوي"
  Pop $0
  Push $0
  Call ADHM_RtlControl
  ${NSD_CreateText} 0 76u 27% 12u "$ADHM_Balance"
  Pop $ADHM_CtlBalance
  SendMessage $ADHM_CtlBalance 0x00C5 6 0
  Push $ADHM_CtlBalance
  Call ADHM_RtlControl

  ; -------------------------------- الصف الخامس: مجلد النسخ الاحتياطي
  ${NSD_CreateLabel} 76% 97u 24% 11u "مجلد النسخ الاحتياطي"
  Pop $0
  Push $0
  Call ADHM_RtlControl

  ; حقل المسار: للعرض فقط (EM_SETREADONLY = 0x00CF) وبمحاذاة لاتينية
  ${NSD_CreateText} 16% 96u 59% 12u "$ADHM_Backup"
  Pop $ADHM_CtlBackup
  SendMessage $ADHM_CtlBackup 0x00C5 200 0
  SendMessage $ADHM_CtlBackup 0x00CF 1 0

  ${NSD_CreateButton} 0 96u 15% 12u "استعراض…"
  Pop $0
  ${NSD_OnClick} $0 ADHM_BrowseBackup

  ${NSD_CreateLabel} 0 111u 100% 13u "يُنشأ هذا المجلد أثناء التثبيت وتُحفظ فيه النسخ الاحتياطية. المجلد الافتراضي داخل «المستندات» ويمكن تغييره بزر «استعراض…»."
  Pop $0
  Push $0
  Call ADHM_RtlControl

  nsDialogs::Show
FunctionEnd

; زر «استعراض…» — نافذة اختيار مجلد ويندوز (تُرجع "error" عند الإلغاء)
Function ADHM_BrowseBackup
  Push $0
  nsDialogs::SelectFolderDialog "اختر مجلد النسخ الاحتياطي" "$ADHM_Backup"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    StrCpy $ADHM_Backup "$0"
    ${NSD_SetText} $ADHM_CtlBackup "$0"
  ${EndIf}
  Pop $0
FunctionEnd

; عند مغادرة الصفحة: قراءة الحقول وتنظيفها وضبط الافتراضيات.
; لا يوجد Abort هنا إطلاقاً — التثبيت يكمل مهما حدث.
Function ADHM_SettingsPageLeave
  ${NSD_GetText} $ADHM_CtlMinistry $ADHM_Ministry
  ${NSD_GetText} $ADHM_CtlDirectorate $ADHM_Directorate
  ${NSD_GetText} $ADHM_CtlHospital $ADHM_Hospital
  ${NSD_GetText} $ADHM_CtlDepartmentUnit $ADHM_DepartmentUnit
  ${NSD_GetText} $ADHM_CtlFooterHR $ADHM_FooterHR
  ${NSD_GetText} $ADHM_CtlFooterManager $ADHM_FooterManager
  ${NSD_GetText} $ADHM_CtlOperatorName $ADHM_OperatorName
  ${NSD_GetText} $ADHM_CtlBalance $ADHM_Balance
  ${NSD_GetText} $ADHM_CtlBackup $ADHM_Backup

  ; --- إزالة الفراغات الزائدة من كل حقل نصي ---
  StrCpy $R9 "$ADHM_Ministry"
  Call ADHM_TrimR9
  StrCpy $ADHM_Ministry "$R9"

  StrCpy $R9 "$ADHM_Directorate"
  Call ADHM_TrimR9
  StrCpy $ADHM_Directorate "$R9"

  StrCpy $R9 "$ADHM_Hospital"
  Call ADHM_TrimR9
  StrCpy $ADHM_Hospital "$R9"

  StrCpy $R9 "$ADHM_DepartmentUnit"
  Call ADHM_TrimR9
  StrCpy $ADHM_DepartmentUnit "$R9"

  StrCpy $R9 "$ADHM_FooterHR"
  Call ADHM_TrimR9
  StrCpy $ADHM_FooterHR "$R9"

  StrCpy $R9 "$ADHM_FooterManager"
  Call ADHM_TrimR9
  StrCpy $ADHM_FooterManager "$R9"

  StrCpy $R9 "$ADHM_OperatorName"
  Call ADHM_TrimR9
  StrCpy $ADHM_OperatorName "$R9"

  StrCpy $R9 "$ADHM_Backup"
  Call ADHM_TrimR9
  StrCpy $ADHM_Backup "$R9"

  ; --- القيم الافتراضية عند أي حقل فارغ ---
  ${If} $ADHM_Ministry == ""
    StrCpy $ADHM_Ministry "${ADHM_DEF_MINISTRY}"
  ${EndIf}
  ${If} $ADHM_Directorate == ""
    StrCpy $ADHM_Directorate "${ADHM_DEF_DIRECTORATE}"
  ${EndIf}
  ${If} $ADHM_Hospital == ""
    StrCpy $ADHM_Hospital "${ADHM_DEF_HOSPITAL}"
  ${EndIf}
  ${If} $ADHM_DepartmentUnit == ""
    StrCpy $ADHM_DepartmentUnit "${ADHM_DEF_DEPARTMENT}"
  ${EndIf}
  ${If} $ADHM_FooterHR == ""
    StrCpy $ADHM_FooterHR "${ADHM_DEF_FOOTER_HR}"
  ${EndIf}
  ${If} $ADHM_FooterManager == ""
    StrCpy $ADHM_FooterManager "${ADHM_DEF_FOOTER_MGR}"
  ${EndIf}
  ${If} $ADHM_OperatorName == ""
    StrCpy $ADHM_OperatorName "${ADHM_DEF_OPERATOR}"
  ${EndIf}
  ${If} $ADHM_Backup == ""
    StrCpy $ADHM_Backup "$DOCUMENTS\ADMH-Leaves-Backups"
  ${EndIf}

  ; --- الرصيد السنوي: رقم صحيح فقط، والرجوع إلى 21 عند أي إدخال غير صالح ---
  StrCpy $R1 "$ADHM_Balance"
  StrCpy $R0 ""
  StrCpy $R2 0
  adhm_bal_loop:
    StrCpy $R3 $R1 1 $R2
    StrCmp $R3 "" adhm_bal_done
    StrCpy $R4 "0123456789"
    StrCpy $R5 0
    adhm_bal_digit:
      StrCpy $R6 $R4 1 $R5
      StrCmp $R6 "" adhm_bal_next
      StrCmp $R6 $R3 0 adhm_bal_skip
      StrCpy $R0 "$R0$R3"
      Goto adhm_bal_next
    adhm_bal_skip:
      IntOp $R5 $R5 + 1
      Goto adhm_bal_digit
    adhm_bal_next:
    IntOp $R2 $R2 + 1
    Goto adhm_bal_loop
  adhm_bal_done:
  ${If} $R0 == ""
    StrCpy $R0 "${ADHM_DEF_BALANCE}"
  ${EndIf}
  IntOp $R0 $R0 + 0
  ${If} $R0 < 1
    StrCpy $R0 "${ADHM_DEF_BALANCE}"
  ${ElseIf} $R0 > 365
    StrCpy $R0 "365"
  ${EndIf}
  StrCpy $ADHM_Balance "$R0"
FunctionEnd

; إضافة الصفحة بعد صفحة اختيار مجلد التثبيت (فيكون $INSTDIR معروفاً)
!macro customPageAfterChangeDir
  Page custom ADHM_SettingsPageCreate ADHM_SettingsPageLeave
!macroend

; ============================= التثبيت: كتابة الملف وإنشاء مجلد النسخ الاحتياطي
; يعمل دائماً: تثبيت عادي، ترقية، أو تثبيت صامت /S
!macro customInstall
  Call ADHM_WriteConfig
  CreateDirectory "$ADHM_Backup"
!macroend

; ==================================== إلغاء التثبيت
; يُحذف ملف الإعدادات فقط. لا تُحذف بيانات المستخدم ولا مجلد النسخ الاحتياطي
; ولا مجلد %APPDATA%\ADMH-Leaves إطلاقاً.
; ---------- خاص بالمُلغِي (uninstaller) فقط: لا يستدعي أي دالة من دوال المُثبِّت ----------
!endif

!macro customUnInstall
  Delete "$INSTDIR\install-config.txt"
!macroend
