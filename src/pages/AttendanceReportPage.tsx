import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, ensureAuthenticated, getRealDate } from '../services/firebase';
import { ref, get, set, push, update, query, orderByChild, equalTo, startAt, endAt } from 'firebase/database';
import { ArrowRight, Printer, Search, MapPin, CheckCircle2, XCircle, Loader2, X, Trash2, Clock, FileText, Truck, Briefcase, ChevronDown, ChevronLeft, Calendar, AlertTriangle, FileBarChart, User } from 'lucide-react';
import { AttendanceGridSummary } from '../components/AttendanceGridSummary';
import { CustomPickerModal } from '../components/CustomPickerModal';
import { MachineSelectionModal } from '../components/MachineSelectionModal';
import { t } from '../utils/i18n';
import { SettingsManager } from '../services/appSettings';
import { SUB_JOB_OPTIONS, getPrimaryJobTitle, ENABLE_FIREBASE_FALLBACK } from '../constants';
import { jobStatsService } from '../services/jobStatsService';
import { useClickOutside } from '../hooks/useClickOutside';
import { edgeReportService } from '../services/edgeReportService';
import { edgeBootstrapService } from '../services/edgeBootstrapService';

interface Employee {
  userKey: string;
  name_ar: string;
  job_title?: string;
  sub_job?: string;
  iqama?: string;
  [key: string]: any;
}

interface AttendanceRecord {
  name: string;
  time: string;
  area?: string;
  areaDescription?: string;
  date?: string;
  userKey?: string;
  attendanceType?: 'manual' | 'location';
  status?: 'present' | 'absent';
  [key: string]: any;
}

export const AttendanceReportPage: React.FC = () => {
  const navigate = useNavigate();
  const [allEmployees, setAllEmployees] = useState<Employee[]>([]);
  const [attendanceData, setAttendanceData] = useState<Record<string, AttendanceRecord>>({});
  const [prevAttendanceData, setPrevAttendanceData] = useState<Record<string, AttendanceRecord>>({});
  const [nextAttendanceData, setNextAttendanceData] = useState<Record<string, AttendanceRecord>>({});
  const [locations, setLocations] = useState<string[]>([]);
  const [allLocationsList, setAllLocationsList] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = getRealDate();
    const y = now.getFullYear();
    const m = (now.getMonth() + 1).toString().padStart(2, '0');
    const d = now.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [daysCount, setDaysCount] = useState(15);
  const [selectedLocations, setSelectedLocations] = useState<string[]>(['الكل']);
  const selectedLocation = selectedLocations.length === 1 ? selectedLocations[0] : (selectedLocations.includes('الكل') || selectedLocations.length === 0 ? 'الكل' : selectedLocations[0]);
  const isAllLocationsSelected = selectedLocations.length === 0 || selectedLocations.includes('الكل');
  const setSelectedLocation = (loc: string) => {
    setSelectedLocations([loc]);
  };
  const [editActionEmployee, setEditActionEmployee] = useState<Employee | null>(null);
  const [editReason, setEditReason] = useState('');
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [reasonActionType, setReasonActionType] = useState<'attend' | 'absent' | null>(null);
  const [reasonActionEmployee, setReasonActionEmployee] = useState<Employee | null>(null);
  const [actionReasonInput, setActionReasonInput] = useState('');
  const [selectingForEmployee, setSelectingForEmployee] = useState<Employee | null>(null);
  const [areapermissions, setareapermissions] = useState<Record<string, { mode: 'read' | 'edit' }>>({});
  const [locationMap, setLocationMap] = useState<Record<string, string>>({});
  const [assignMode, setAssignMode] = useState<'assign' | 'attend'>('assign');
  const [assigningLocationFor, setAssigningLocationFor] = useState<Employee | null>(null);
  const [assigningEquipmentFor, setAssigningEquipmentFor] = useState<Employee | null>(null);
  const [showSubJobDropdown, setShowSubJobDropdown] = useState(false);
  const [machinesList, setMachinesList] = useState<{id: string, name: string, costCenter: string, plate: string}[]>([]);
  const [showTerminationPicker, setShowTerminationPicker] = useState(false);
  const [terminatingEmployee, setTerminatingEmployee] = useState<Employee | null>(null);
  const [pendingTerminationDate, setPendingTerminationDate] = useState('');
  const [currentUserKey] = useState(() => localStorage.getItem("userKey") || "");
  const [currentAdminName, setCurrentAdminName] = useState(() => {
    try {
      const cached = localStorage.getItem("cached_user_profile");
      if (cached) {
        const u = JSON.parse(cached);
        if (u.name_ar) return u.name_ar;
      }
    } catch (e) {}
    const mem = edgeBootstrapService.getMemoryProfile(localStorage.getItem("userKey") || "");
    return mem.val()?.name_ar || "";
  });
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [showGridSummary, setShowGridSummary] = useState(false);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [machineIntervalDays, setMachineIntervalDays] = useState(7);
  const [showNoMachineWarningFilter, setShowNoMachineWarningFilter] = useState(false);
  const locationInitializedRef = useRef(false);
  const activeRequestRef = useRef<string | null>(null);
  const terminationDateListRef = useRef<HTMLDivElement>(null);
  const subJobDropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(subJobDropdownRef, () => setShowSubJobDropdown(false), showSubJobDropdown);

  useEffect(() => {
    if (showTerminationPicker) {
      if (!pendingTerminationDate) {
        const today = new Date();
        const str = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
        setPendingTerminationDate(str);
      }
      setTimeout(() => {
        const selectedEl = terminationDateListRef.current?.querySelector('[data-selected="true"]') as HTMLElement;
        if (selectedEl && terminationDateListRef.current) {
          const top = selectedEl.offsetTop - terminationDateListRef.current.clientHeight / 2 + selectedEl.clientHeight / 2;
          terminationDateListRef.current.scrollTo({ top, behavior: 'smooth' });
        }
      }, 150);
    }
  }, [showTerminationPicker]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // helper لتجهيز السجل بدون حفظ (للحفاظ على الذرية)
  const getLogUpdate = (operation: string, action: string, details: string, extra = {}, adminNameOverride?: string) => {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    const day = now.getDate().toString().padStart(2, '0');
    const logKey = push(ref(db, `LOG/${yearMonth}/${day}`)).key;

    return {
      [`LOG/${yearMonth}/${day}/${logKey}`]: {
        timestamp: now.getTime(),
        operation,
        admin_name: adminNameOverride || currentAdminName || "مستخدم",
        admin_id: currentUserKey,
        action,
        details,
        ...extra
      }
    };
  };

  useEffect(() => {
    loadData();
  }, [selectedDate]);

  useEffect(() => {
    // Force body background to white when this page is active
    const originalBackground = document.body.style.background;
    const originalBackgroundImage = document.body.style.backgroundImage;
    const originalBackgroundColor = document.body.style.backgroundColor;

    document.body.style.background = 'white';
    document.body.style.backgroundImage = 'none';
    document.body.style.backgroundColor = 'white';

    const logVisit = async () => {
      try {
        if (!currentUserKey) return;

        let name = currentAdminName;
        if (!name) {
          const snap = await get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`));
          name = snap.exists() ? snap.val() : "مستخدم";
          setCurrentAdminName(name);
        }

        const logUpdate = getLogUpdate("تقرير البصمه حسب الموقع", "زيارة صفحة", "دخل المراقب لصفحة تقرير البصمة حسب الموقع", {}, name);
        await update(ref(db), logUpdate);
      } catch (error) {
        console.error("Error logging visit:", error);
      }
    };
    logVisit();

    return () => {
      // Restore original background when leaving the page
      document.body.style.background = originalBackground;
      document.body.style.backgroundImage = originalBackgroundImage;
      document.body.style.backgroundColor = originalBackgroundColor;
    };
  }, []);

  const loadData = async () => {
    const requestId = Date.now().toString();
    activeRequestRef.current = requestId;

    setLoading(true);

    // 🔑 تجديد جلسة Auth في الخلفية بدون حظر استلام البيانات
    ensureAuthenticated().catch((err) => console.warn('[AttendanceReport] Background auth refresh:', err));

    // ⚡ 1. إطلاق طلب تقرير الووركر المضغوط فوراً في أول جزء من الثانية بالتوازي
    const initialPerms = edgeBootstrapService.getMemoryAreaPermissions(currentUserKey);
    const hasInitialAll = initialPerms.val() && initialPerms.val()['الكل'];
    const targetLoc = (hasInitialAll || selectedLocation === 'الكل') ? 'الكل' : selectedLocation;
    const reportPromise = edgeReportService.fetchCompressedReport(selectedDate, targetLoc);

    try {
      const pParts = selectedDate.split('-');
      const pD = new Date(parseInt(pParts[0], 10), parseInt(pParts[1], 10) - 1, parseInt(pParts[2], 10));
      pD.setDate(pD.getDate() - 1);
      const prevDateStr = `${pD.getFullYear()}-${(pD.getMonth() + 1).toString().padStart(2, '0')}-${pD.getDate().toString().padStart(2, '0')}`;

      const nParts = selectedDate.split('-');
      const nD = new Date(parseInt(nParts[0], 10), parseInt(nParts[1], 10) - 1, parseInt(nParts[2], 10));
      nD.setDate(nD.getDate() + 1);
      const nextDateStr = `${nD.getFullYear()}-${(nD.getMonth() + 1).toString().padStart(2, '0')}-${nD.getDate().toString().padStart(2, '0')}`;

      const curYM = selectedDate.substring(0, 7);
      const curD = selectedDate.split('-')[2];

      const prevYM = prevDateStr.substring(0, 7);
      const prevD = prevDateStr.split('-')[2];

      const nextYM = nextDateStr.substring(0, 7);
      const nextD = nextDateStr.split('-')[2];

      // ⚡ 2. قراءة الصلاحيات والمناطق وإصدارات الإعدادات من الذاكرة الفائقة أو الكاش (0ms)
      const memPerms = edgeBootstrapService.getMemoryAreaPermissions(currentUserKey);
      const memAreas = edgeBootstrapService.getMemoryWorkAreas();
      const memVersions = edgeBootstrapService.getMemoryVersions();

      let permSnap = memPerms.exists() ? memPerms : null;
      let locSnap = memAreas.exists() ? memAreas : null;
      let settingsVersionSnap = memVersions.exists() ? memVersions : null;

      // إذا لم تكن موجودة ومسموح بالـ Fallback، نطلبها من فايربيس
      if ((!permSnap || !locSnap) && ENABLE_FIREBASE_FALLBACK) {
        const [fPerm, fLoc, fVer] = await Promise.all([
          !permSnap ? get(ref(db, `areapermissions/${currentUserKey}`)).catch(() => null) : Promise.resolve(permSnap),
          !locSnap ? get(ref(db, 'workAreas')).catch(() => null) : Promise.resolve(locSnap),
          !settingsVersionSnap ? get(ref(db, "SystemSettings/AppSettings/versions")).catch(() => null) : Promise.resolve(settingsVersionSnap)
        ]);
        if (fPerm) permSnap = fPerm;
        if (fLoc) locSnap = fLoc;
        if (fVer) settingsVersionSnap = fVer;
      }

      if (activeRequestRef.current !== requestId) return;

      if (settingsVersionSnap && settingsVersionSnap.exists()) {
        try {
          const appSettings = await SettingsManager.loadSettings(settingsVersionSnap.val());
          const interval = appSettings.machineColorIntervalDays;
          if (typeof interval === 'number' && interval > 0) {
            setMachineIntervalDays(interval);
          }
        } catch (e) {
          console.error("Error loading appSettings for machine interval:", e);
        }
      }

      // جلب اسم المراقب إذا لم يكن موجوداً
      if (!currentAdminName && currentUserKey) {
        const memProf = edgeBootstrapService.getMemoryProfile(currentUserKey);
        if (memProf.exists() && memProf.val()?.name_ar) {
          setCurrentAdminName(memProf.val().name_ar);
        } else if (ENABLE_FIREBASE_FALLBACK) {
          get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`)).then(snap => {
            if (snap && snap.exists()) setCurrentAdminName(snap.val());
          }).catch(() => {});
        }
      }

      const perms = permSnap && permSnap.exists() ? permSnap.val() : null;
      setareapermissions(perms || {});
      const hasAllPermission = perms && perms['الكل'];

      const availableLocIds: string[] = [];
      const allLocIds: string[] = [];
      const mapping: Record<string, string> = {};

      if (locSnap && locSnap.exists()) {
        const rawLocs = locSnap.val();

        const collect = (obj: any) => {
          if (!obj) return;
          Object.entries(obj).forEach(([id, val]: any) => {
            if (id === 'hide' || val?.hidden || val?.hide || val?.status === 'hidden' || val?.status === 'hide') return;
            if (typeof val === 'object' && val !== null) {
              const name = val.name || id;
              mapping[id] = name;
              allLocIds.push(id);
              if (hasAllPermission || (perms && perms[id])) {
                availableLocIds.push(id);
              }
              if (val.subLocations && Array.isArray(val.subLocations)) {
                val.subLocations.forEach((sub: any) => {
                  if (!sub.id) return;
                  mapping[sub.id] = name;
                });
              }
            }
          });
        };
        collect(rawLocs);

        setLocations(availableLocIds);
        setAllLocationsList(allLocIds);
        setLocationMap(mapping);

        if (!locationInitializedRef.current) {
          if (availableLocIds.length === 1) {
            setSelectedLocation(availableLocIds[0]);
          } else {
            setSelectedLocation('الكل');
          }
          locationInitializedRef.current = true;
        }
      }

      // ⚡ محاولة جلب التقرير الفائق المضغوط من Cloudflare Worker (الطلب تم إطلاقه بالتوازي في أول سطر)
      try {
        const edgeData = await reportPromise;

        if (edgeData && activeRequestRef.current === requestId) {
          const rawMachines = edgeData.machinesList || [];
          const normalizedMachines = Array.isArray(rawMachines)
            ? rawMachines.map((m: any) => {
                if (Array.isArray(m)) {
                  return {
                    id: m[0] || '',
                    name: m[1] || m[0] || '',
                    label: m[1] || m[0] || '',
                    costCenter: m[0] || '',
                    plate: m[2] || '',
                    driver: m[3] || ''
                  };
                }
                return m;
              })
            : [];
          setMachinesList(normalizedMachines);
          const employees = Object.values(edgeData.employeesMap);
          employees.sort((a, b) => (a.name_ar || '').localeCompare(b.name_ar || '', 'ar'));
          setAllEmployees(employees);
          setAttendanceData(edgeData.attendance);
          setPrevAttendanceData({});
          setNextAttendanceData({});
          setLoading(false);
          return;
        }
      } catch (edgeErr) {
        console.warn('[AttendanceReport] Edge report error:', edgeErr);
      }

      // 🔴 [TEST_MODE_WORKER_ONLY] فحص وضع التجربة: إذا كان الـ Fallback معطلاً نمنع استعلام فايربيس المباشر
      if (!ENABLE_FIREBASE_FALLBACK) {
        setLoading(false);
        console.warn('⚠️ [TEST_MODE_WORKER_ONLY] Firebase Fallback is DISABLED by ENABLE_FIREBASE_FALLBACK flag.');
        return;
      }

      // 2. صمام الأمان التراجعي: نجلب الحضور ومسار الموظفين بالطريقة الأصلية المباشرة
      const attendancePromises: Promise<any>[] = [];
      const useIndexing = false; // تم الإلغاء بناءً على طلب المستخدم لحل مشكلة عدم ظهور البيانات

      // تحديد ما إذا كان اليوم المختار يصادف يوم جمعة (لجلب أمس وغداً للتحقق من غياب الجمعة المتصل)
      const parts = selectedDate.split('-');
      const dObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const isSelectedFriday = dObj.getDay() === 5;

      if (useIndexing) {
        // للمراقب المقيد بموقع واحد فقط: استغلال الفهرس
        const locId = availableLocIds[0];
        attendancePromises.push(
          get(query(ref(db, `بيانات_الحضور_حسب_اليوم/${selectedDate}`), orderByChild('mainAreaId'), equalTo(locId)))
            .then(s => ({ day: 'current', snap: s, indexed: true }))
        );
        
        if (isSelectedFriday) {
          attendancePromises.push(
            get(query(ref(db, `بيانات_الحضور_حسب_اليوم/${prevDateStr}`), orderByChild('mainAreaId'), equalTo(locId)))
              .then(s => ({ day: 'prev', snap: s, indexed: true }))
          );
          attendancePromises.push(
            get(query(ref(db, `بيانات_الحضور_حسب_اليوم/${nextDateStr}`), orderByChild('mainAreaId'), equalTo(locId)))
              .then(s => ({ day: 'next', snap: s, indexed: true }))
          );
        }
      } else {
        // جلب اليوم المحدد كاملاً
        attendancePromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${selectedDate}`)).then(s => ({ day: 'current', snap: s })));
        
        if (isSelectedFriday) {
          attendancePromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${prevDateStr}`)).then(s => ({ day: 'prev', snap: s })));
          attendancePromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${nextDateStr}`)).then(s => ({ day: 'next', snap: s })));
        }
      }

      // جلب الموظفين أيضاً بالتوازي
      let employeesPromise: Promise<any>;
      if (hasAllPermission) {
        employeesPromise = get(ref(db, 'قائمة_الموظفين'));
      } else {
        const employeePromises = availableLocIds.map(locId =>
          get(query(ref(db, 'قائمة_الموظفين'), orderByChild('lastLocation'), equalTo(locId)))
        );
        employeesPromise = Promise.all(employeePromises);
      }

      const machinesPromise = get(ref(db, 'قائمة_المعدات'));

      const [attendanceResults, employeesResult, machinesResult] = await Promise.all([
        Promise.all(attendancePromises),
        employeesPromise,
        machinesPromise
      ]);

      if (activeRequestRef.current !== requestId) return;

      if (machinesResult.exists()) {
        const mArr = Object.entries(machinesResult.val()).map(([id, val]: any) => {
          const type = val.type || '';
          const nameStr = val.name || val.costCenter || id;
          const fullTypeAndName = type && !nameStr.includes(type) ? `${type} ${nameStr}`.trim() : nameStr;
          return {
            id,
            name: fullTypeAndName,
            type,
            costCenter: val.costCenter || '',
            plate: val.plate || '',
            driver: val.driver || '',
            driver_updated_at: val.driver_updated_at || 0
          };
        });
        setMachinesList(mArr);
      }

      const employeesMap: Record<string, any> = {};

      if (hasAllPermission) {
        const allEmployeesSnap = employeesResult;
        if (allEmployeesSnap.exists()) {
          allEmployeesSnap.forEach((child: any) => {
            const val = child.val();
            const startDate = val.start_date;
            const terminationDate = val.end_date;
            const status = val.status;

            const isEmployeeActive = (() => {
              if (status === 'مخفي' || status === 'hidden' || status === 'hide' || val?.hidden || val?.hide || status === 'غير نشط' || status === 'منتهي' || status === 'خارج العمل' || status === 'inactive') {
                return false;
              }
              if (val.employment_history) {
                const history = Object.values(val.employment_history) as any[];
                return history.some(p => {
                  const start = p.start_date || '0000-00-00';
                  const end = (p.status === 'نشط' || !p.end_date) ? '9999-99-99' : p.end_date;
                  return selectedDate >= start && selectedDate <= end;
                });
              }
              const start = val.start_date || '';
              const end = val.end_date || '';
              if (status === 'نشط') {
                return !start || start <= selectedDate;
              } else {
                return (!start || start <= selectedDate) && (!end || end >= selectedDate);
              }
            })();

            if (isEmployeeActive) {
              employeesMap[child.key!] = { ...val, userKey: child.key };
            }
          });
        }
      } else {
        const employeeSnaps = employeesResult as any[];
        employeeSnaps.forEach(snap => {
          if (snap.exists()) {
            snap.forEach((child: any) => {
              const val = child.val();
              const startDate = val.start_date;
              const terminationDate = val.end_date;
              const status = val.status;

              const isEmployeeActive = (() => {
                if (status === 'مخفي' || status === 'hidden' || status === 'hide' || val?.hidden || val?.hide || status === 'غير نشط' || status === 'منتهي' || status === 'خارج العمل' || status === 'inactive') {
                  return false;
                }
                if (val.employment_history) {
                  const history = Object.values(val.employment_history) as any[];
                  return history.some(p => {
                    const start = p.start_date || '0000-00-00';
                    const end = (p.status === 'نشط' || !p.end_date) ? '9999-99-99' : p.end_date;
                    return selectedDate >= start && selectedDate <= end;
                  });
                }
                const start = val.start_date || '';
                const end = val.end_date || '';
                if (status === 'نشط') {
                  return !start || start <= selectedDate;
                } else {
                  return (!start || start <= selectedDate) && (!end || end >= selectedDate);
                }
              })();

              if (isEmployeeActive) {
                employeesMap[child.key!] = { ...val, userKey: child.key };
              }
            });
          }
        });
      }

      const attendance: Record<string, AttendanceRecord> = {};
      const prevAttendance: Record<string, AttendanceRecord> = {};
      const nextAttendance: Record<string, AttendanceRecord> = {};

      const missingUserKeys: string[] = [];

      const processResults = (results: any[]) => {
        results.forEach(item => {
          if (!item.snap || !item.snap.exists()) return;
          const snap = item.snap;
          const targetMap = item.day === 'current' ? attendance : (item.day === 'prev' ? prevAttendance : nextAttendance);

          snap.forEach((child: any) => {
            const record = child.val();
            const key = record.userKey || child.key;
            if (key) {
              // التصفية داخل التطبيق للمراقب المقيد في حال جلبنا اليوم كاملاً
              const recordAreaId = record.mainAreaId || '';
              const isPermitted = hasAllPermission || item.indexed || availableLocIds.includes(recordAreaId) || !recordAreaId;

              if (isPermitted) {
                targetMap[key] = record;

                // تحقق من الموظفين المفقودين لجلبهم (فقط لليوم المختار)
                if (item.day === 'current' && !employeesMap[key]) {
                  if (!missingUserKeys.includes(key)) {
                    missingUserKeys.push(key);
                  }
                }
              }
            }
          });
        });
      };

      processResults(attendanceResults);

      // Fallback: إذا كانت الفهرسة مُفعلة ولم تُرجع نتائج لليوم الحالي لكن يوجد موظفون مسجلون
      // نعيد الجلب بدون فهرسة (حالة سجلات قديمة بدون mainAreaId)
      if (useIndexing && Object.keys(attendance).length === 0 && Object.keys(employeesMap).length > 0) {
        console.log('Indexed query returned empty, falling back to full fetch...');
        const fallbackPromises: Promise<any>[] = [];
        fallbackPromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${selectedDate}`)).then(s => ({ day: 'current', snap: s })));
        if (isSelectedFriday) {
          fallbackPromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${prevDateStr}`)).then(s => ({ day: 'prev', snap: s })));
          fallbackPromises.push(get(ref(db, `بيانات_الحضور_حسب_اليوم/${nextDateStr}`)).then(s => ({ day: 'next', snap: s })));
        }
        const fallbackResults = await Promise.all(fallbackPromises);
        if (activeRequestRef.current !== requestId) return;
        processResults(fallbackResults);
      }

      // جلب الموظفين المفقودين
      if (missingUserKeys.length > 0) {
        const missingProfiles = await Promise.all(
          missingUserKeys.map(key => get(ref(db, `قائمة_الموظفين/${key}`)))
        );
        missingProfiles.forEach(snap => {
          if (snap.exists()) {
            const val = snap.val();
            const st = val.status;
            if (st === 'مخفي' || st === 'hidden' || st === 'hide' || val?.hidden || val?.hide || st === 'غير نشط' || st === 'منتهي' || st === 'خارج العمل' || st === 'inactive') {
              return;
            }
            employeesMap[snap.key!] = { ...val, userKey: snap.key };
            // تأكيد البصمات المفقودة للحاضرين
            const record = attendance[snap.key!];
            if (record) attendance[snap.key!] = record;
            const prevRec = prevAttendance[snap.key!];
            if (prevRec) prevAttendance[snap.key!] = prevRec;
            const nextRec = nextAttendance[snap.key!];
            if (nextRec) nextAttendance[snap.key!] = nextRec;
          }
        });
      }

      const employees = Object.values(employeesMap);
      employees.sort((a, b) => (a.name_ar || '').localeCompare(b.name_ar || '', 'ar'));
      setAllEmployees(employees);
      setAttendanceData(attendance);
      setPrevAttendanceData(prevAttendance);
      setNextAttendanceData(nextAttendance);

      // ⚡ تحديث كاش إحصائيات الوظائف للموقع المصرح لتبويب المهام
      try {
        const locNames = availableLocIds.length === 1
          ? [mapping[availableLocIds[0]] || availableLocIds[0]]
          : hasAllPermission
            ? ['جميع المواقع']
            : availableLocIds.map(id => mapping[id] || id);

        const stats = jobStatsService.calculateStats(employees, locNames);
        jobStatsService.saveStatsToCache(stats, currentUserKey);
      } catch (err) {
        console.warn('Could not update job stats cache:', err);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const isFriday = (() => {
    if (!selectedDate) return false;
    const parts = selectedDate.split('-');
    if (parts.length !== 3) return false;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const d = new Date(year, month, day);
    return d.getDay() === 5;
  })();

  const prevDate = (() => {
    if (!selectedDate) return '';
    const parts = selectedDate.split('-');
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
  })();

  const nextDate = (() => {
    if (!selectedDate) return '';
    const parts = selectedDate.split('-');
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
  })();

  const todayRealStr = (() => {
    const now = getRealDate();
    const y = now.getFullYear();
    const m = (now.getMonth() + 1).toString().padStart(2, '0');
    const d = now.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();

  const isEmployeeAbsentOnDate = (emp: Employee, dateStr: string, attData: Record<string, AttendanceRecord>) => {
    let isInPeriod = false;
    if (emp.employment_history) {
      const history = Object.values(emp.employment_history) as any[];
      isInPeriod = history.some(p => {
        const start = p.start_date || '0000-00-00';
        const end = (p.status === 'نشط' || !p.end_date) ? '9999-99-99' : p.end_date;
        return dateStr >= start && dateStr <= end;
      });
    } else {
      const start = emp.start_date || '';
      const end = emp.end_date || '';
      isInPeriod = (!start || dateStr >= start) && (!end || dateStr <= end);
    }
    if (!isInPeriod) return false;
    const record = attData[emp.userKey || ''];
    return record ? record.status === 'absent' : true;
  };

  const getFridayAbsenceStatus = (emp: Employee) => {
    const isAbsOnThursday = isEmployeeAbsentOnDate(emp, prevDate, prevAttendanceData);
    const isSaturdayInFuture = nextDate > todayRealStr;
    if (isAbsOnThursday) {
      if (isSaturdayInFuture) {
        return true;
      } else {
        const isAbsOnSaturday = isEmployeeAbsentOnDate(emp, nextDate, nextAttendanceData);
        return isAbsOnSaturday;
      }
    }
    return false;
  };

  const handleRowClick = (employee: Employee) => {
    const record = attendanceData[employee.userKey || ''];
    setEditActionEmployee(employee);
    setEditReason(record?.notes || '');
  };

  const deleteAttendance = async (employee: Employee) => {
    if (!employee.userKey || saving) return;
    setSaving(true);
    try {
      const yearMonth = selectedDate.substring(0, 7);
      const day = selectedDate.split('-')[2]; // Keep padding ('08' stays '08')
      const updates: any = {};
      updates[`بيانات_الحضور_حسب_اليوم/${yearMonth}/${day}/${employee.userKey}`] = null;
      updates[`بيانات_الحضور_حسب_اليوم/${selectedDate}/${employee.userKey}`] = null; // Dual Delete
      updates[`بيانات_الحضور_حسب_الموظف/${employee.userKey}/${yearMonth}/${day}`] = null;

      // --- LOGGING ---
      const logUpdate = getLogUpdate("تعديل حضور يدوي", "حذف تعديل يدوي", "العودة للحالة التلقائية", {
        employee_name: employee.name_ar,
        employee_id: employee.userKey,
        date_of_record: selectedDate
      });
      Object.assign(updates, logUpdate);

      // 🔥 ATOMIC UPDATE
      await update(ref(db), updates);

      const newAtt = { ...attendanceData };
      delete newAtt[employee.userKey];
      setAttendanceData(newAtt);
      // ---------------

    } catch (e) {
      console.error(e);
      showToast('فشل حذف الحالة', 'error');
    } finally {
      setSaving(false);
    }
  };

  const markAsAbsent = async (employee: Employee, reason: string = '') => {
    if (!employee.userKey || saving) return;
    setSaving(true);
    try {
      const yearMonth = selectedDate.substring(0, 7);
      const day = selectedDate.split('-')[2]; // Extract day as string (e.g., '01', '10')
      const record: AttendanceRecord = {
        name: employee.name_ar,
        date: selectedDate,
        time: '--:--',
        area: 'غياب إداري',
        mainAreaId: employee.lastLocation || "",
        status: 'absent',
        timestamp: Date.now(),
        userKey: employee.userKey,
        notes: reason,
        manual: true
      };

      const updates: any = {};
      updates[`بيانات_الحضور_حسب_اليوم/${yearMonth}/${day}/${employee.userKey}`] = record;
      updates[`بيانات_الحضور_حسب_اليوم/${selectedDate}/${employee.userKey}`] = record; // Dual Write
      updates[`بيانات_الحضور_حسب_الموظف/${employee.userKey}/${yearMonth}/${day}`] = record;

      // --- LOGGING ---
      const logUpdate = getLogUpdate("تعديل حضور يدوي", "تسجيل غياب يدوي", "", {
        employee_name: employee.name_ar,
        employee_id: employee.userKey,
        reason: reason,
        date_of_record: selectedDate
      });
      Object.assign(updates, logUpdate);

      // 🔥 ATOMIC UPDATE
      await update(ref(db), updates);

      setAttendanceData({ ...attendanceData, [employee.userKey]: record });
      // ---------------

    } catch (e) {
      console.error(e);
      showToast('فشل تسجيل الغياب', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTerminateEmployee = async () => {
    if (!terminatingEmployee || !pendingTerminationDate || saving) return;

    setSaving(true);
    try {
      const updates: any = {};
      const nowLog = getRealDate();
      const yearMonthLog = `${nowLog.getFullYear()}-${(nowLog.getMonth() + 1).toString().padStart(2, '0')}`;
      const logDay = nowLog.getDate().toString().padStart(2, '0');
      const adminKey = localStorage.getItem("userKey") || "unknown";

      // جلب اسم الادمن الفعلي لضمان الدقة (نفس منطق صفحة TERMINATE)
      let adminName = currentAdminName;
      if (!adminName || adminName === "مستخدم") {
        const adminSnap = await get(ref(db, `قائمة_الموظفين/${adminKey}/name_ar`));
        adminName = adminSnap.exists() ? adminSnap.val() : "مستخدم";
        setCurrentAdminName(adminName);
      }

      // 1. تحديث حالة الموظف وتاريخ النهاية
      updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/end_date`] = pendingTerminationDate;
      updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/status`] = 'خارج العمل';
      updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/last_modified_by`] = adminName;

      // 2. تحديث سجل فترات الدوام
      const empSnap = await get(ref(db, `قائمة_الموظفين/${terminatingEmployee.userKey}`));
      if (empSnap.exists()) {
        const empData = empSnap.val();
        const history = empData.employment_history || {};
        const activePeriodKey = Object.keys(history).find(key => history[key].status === 'نشط');
        if (activePeriodKey) {
          updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/employment_history/${activePeriodKey}/end_date`] = pendingTerminationDate;
          updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/employment_history/${activePeriodKey}/status`] = 'منتهي';
          updates[`قائمة_الموظفين/${terminatingEmployee.userKey}/employment_history/${activePeriodKey}/terminated_by`] = adminName;
        }
      }

      // 3. إضافة سجل LOG
      const newLogKey = push(ref(db, `LOG/${yearMonthLog}/${logDay}`)).key;
      updates[`LOG/${yearMonthLog}/${logDay}/${newLogKey}`] = {
        timestamp: nowLog.getTime(),
        operation: "إدارة شؤون الموظفين",
        admin_name: adminName,
        admin_id: adminKey,
        employee_name: terminatingEmployee.name_ar,
        employee_id: terminatingEmployee.userKey,
        action: "تسجيل نهاية دوام موظف",
        termination_date: pendingTerminationDate
      };

      // 4. فك الارتباط بالمعدات
      if (terminatingEmployee.machine) {
        const machinesSnapshot = await get(ref(db, "قائمة_المعدات"));
        const machines = machinesSnapshot.val() || {};
        const termMachine = (terminatingEmployee.machine || '').trim();
        const matched = Object.entries(machines).find(
          ([key, eq]: [string, any]) => {
            const costCenter = eq.costCenter || key;
            const full = `${eq.type || ""} ${costCenter}`.trim();
            return key === termMachine || costCenter === termMachine || full === termMachine;
          }
        );

        if (matched) {
          const [costCenter] = matched;
          updates[`جدول_المعدات_والسائقين_المشترك/${costCenter}`] = null;
          updates[`جدول_المعدات_والسائقين_المشترك/${terminatingEmployee.userKey}`] = null;
          updates[`قائمة_المعدات/${costCenter}/driver`] = "";
        }
      }

      // تنفيذ التحديث الذري
      await update(ref(db), updates);

      // تحديث الواجهة المحلية
      setAllEmployees(prev => prev.filter(e => e.userKey !== terminatingEmployee.userKey));

      setShowTerminationPicker(false);
      setTerminatingEmployee(null);
      setPendingTerminationDate('');
      showToast('تم توقيف الموظف بنجاح');
    } catch (error) {
      console.error(error);
      showToast('حدث خطأ أثناء محاولة توقيف الموظف', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveEquipment = async (machineId: string, employee: Employee) => {
    try {
      setSaving(true);
      const updates: any = {};
      const driverId = employee.userKey;

      const nowTs = Date.now();

      // 1. Fetch current equipment of the driver (if any)
      const currentEquipSnap = await get(ref(db, `جدول_المعدات_والسائقين_المشترك/${driverId}`));
      const oldMachine = currentEquipSnap.val();
      if (oldMachine) {
         updates[`جدول_المعدات_والسائقين_المشترك/${oldMachine}`] = null;
         updates[`قائمة_المعدات/${oldMachine}/driver`] = null;
         updates[`قائمة_المعدات/${oldMachine}/driver_updated_at`] = nowTs;
      }

      // 2. Fetch current driver of the NEW equipment (if any)
      if (machineId) {
        const newEquipDriverSnap = await get(ref(db, `قائمة_المعدات/${machineId}/driver`));
        const oldDriver = newEquipDriverSnap.val();
        if (oldDriver) {
           updates[`جدول_المعدات_والسائقين_المشترك/${oldDriver}`] = null;
           updates[`قائمة_الموظفين/${oldDriver}/machine`] = "لا يوجد معدة";
           updates[`قائمة_الموظفين/${oldDriver}/machine_updated_at`] = nowTs;
        }

        // 3. Set the new mapping
        updates[`جدول_المعدات_والسائقين_المشترك/${machineId}`] = driverId;
        updates[`جدول_المعدات_والسائقين_المشترك/${driverId}`] = machineId;
        updates[`قائمة_المعدات/${machineId}/driver`] = driverId;
        updates[`قائمة_المعدات/${machineId}/driver_updated_at`] = nowTs;
        updates[`قائمة_الموظفين/${driverId}/machine`] = machineId;
        updates[`قائمة_الموظفين/${driverId}/machine_updated_at`] = nowTs;
      } else {
        updates[`قائمة_الموظفين/${driverId}/machine`] = "لا يوجد معدة";
        updates[`قائمة_الموظفين/${driverId}/machine_updated_at`] = nowTs;
      }

      const extraData = {
        employee_id: driverId,
        machine_id_old: oldMachine || 'لا يوجد معدة',
        machine_id_new: machineId || 'لا يوجد معدة',
        supervisor_id: currentUserKey
      };
      const logData = getLogUpdate("تعديل معدة", "تعديل", `تعديل معدة الموظف: ${employee.name_ar}`, extraData);
      Object.assign(updates, logData);

      await update(ref(db), updates);

      // ✅ التحديث الفوري المباشر للحالة بالذاكرة (سطران فقط)
      setAllEmployees(prev => prev.map(e => e.userKey === driverId ? { ...e, machine: machineId || 'لا يوجد معدة', machine_updated_at: nowTs } : (machineId && e.machine === machineId ? { ...e, machine: 'لا يوجد معدة', machine_updated_at: nowTs } : e)));
      setMachinesList(prev => prev.map(m => {
        if (oldMachine && (m.id === oldMachine || m.costCenter === oldMachine)) {
          return { ...m, driver: '', driver_updated_at: nowTs };
        }
        if (machineId && (m.id === machineId || m.costCenter === machineId)) {
          return { ...m, driver: driverId, driver_updated_at: nowTs };
        }
        return m;
      }));

      showToast('تم تغيير المعدة بنجاح');
      setAssigningEquipmentFor(null);
    } catch (error) {
      console.error("Error saving equipment:", error);
      showToast('حدث خطأ أثناء تغيير المعدة', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveSubJob = async (newSubJob: string, employee: Employee) => {
    try {
      setSaving(true);
      const updates: any = {};
      const driverId = employee.userKey;
      const oldSubJob = employee.sub_job || '';

      updates[`قائمة_الموظفين/${driverId}/sub_job`] = newSubJob || null;
      const computedMainJob = getPrimaryJobTitle(newSubJob);
      if (computedMainJob) {
        updates[`قائمة_الموظفين/${driverId}/job_title`] = computedMainJob;
      }

      const extraData = {
        employee_id: driverId,
        sub_job_old: oldSubJob || 'لا يوجد',
        sub_job_new: newSubJob || 'لا يوجد',
        supervisor_id: currentUserKey
      };
      const logData = getLogUpdate("تعديل وظيفة فرعية", "تعديل", `تعديل الوظيفة الفرعية للموظف: ${employee.name_ar} إلى: ${newSubJob || 'بدون'}`, extraData);
      Object.assign(updates, logData);

      await update(ref(db), updates);

      setAllEmployees(prev => prev.map(emp => emp.userKey === driverId ? { ...emp, sub_job: newSubJob } : emp));
      if (editActionEmployee && editActionEmployee.userKey === driverId) {
        setEditActionEmployee({ ...editActionEmployee, sub_job: newSubJob });
      }

      showToast('تم تغيير الوظيفة الفرعية بنجاح');
      setShowSubJobDropdown(false);
    } catch (error) {
      console.error("Error saving sub job:", error);
      showToast('حدث خطأ أثناء تغيير الوظيفة الفرعية', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveAttendance = async (location: string, reason: string = '', empOverride?: Employee) => {
    const employee = empOverride || selectingForEmployee;
    if (!employee || !employee.userKey || saving) return;

    setSaving(true);
    try {
      const now = getRealDate();
      const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

      const updates: any = {};
      const yearMonth = selectedDate.substring(0, 7);
      const day = selectedDate.split('-')[2];

      if (assignMode === 'attend') {
        const record: AttendanceRecord = {
          name: employee.name_ar,
          date: selectedDate,
          time: timeStr,
          area: locationMap[location] || location, // Return to Name
          areaDescription: locationMap[location] || location,
          mainAreaId: location, // Keep ID here for system logic
          status: 'present',
          timestamp: Date.now(),
          userKey: employee.userKey,
          notes: reason,
          manual: true,
          attendanceType: 'manual'
        };
        updates[`بيانات_الحضور_حسب_اليوم/${yearMonth}/${day}/${employee.userKey}`] = record;
        updates[`بيانات_الحضور_حسب_اليوم/${selectedDate}/${employee.userKey}`] = record; // Dual Write
        updates[`بيانات_الحضور_حسب_الموظف/${employee.userKey}/${yearMonth}/${day}`] = record;
        setAttendanceData(prev => ({ ...prev, [employee.userKey]: record }));
      }

      updates[`قائمة_الموظفين/${employee.userKey}/lastLocation`] = location;

      const logUpdate = getLogUpdate("تعديل حضور يدوي", assignMode === 'attend' ? "تسجيل حضور يدوي" : `تعيين موقع ${locationMap[location] || location}`, "", {
        employee_name: employee.name_ar,
        employee_id: employee.userKey,
        location: location,
        reason: reason,
        date_of_record: selectedDate
      });
      Object.assign(updates, logUpdate);

      await update(ref(db), updates);

      if (assignMode === 'assign') {
        setAllEmployees(prev => prev.map(e => e.userKey === employee.userKey ? { ...e, lastLocation: location } : e));
      }
      setSelectingForEmployee(null);
      setAssigningLocationFor(null);
    } catch (e) {
      console.error(e);
      showToast('فشل حفظ التحضير', 'error');
    } finally {
      setSaving(false);
    }
  };

  const machinesMap = useMemo(() => {
    const map: Record<string, { display: string; updatedAt: number }> = {};
    machinesList.forEach(m => {
      const plateStr = m.plate && m.plate.trim() !== '' && m.plate !== '****' && m.plate !== 'بدون لوحة' ? ` - ${m.plate}` : '';
      const fullStr = `${m.name}${plateStr}`.trim();
      const info = { display: fullStr, updatedAt: Number((m as any).driver_updated_at || 0) };
      map[m.id] = info;
      if (m.costCenter) map[m.costCenter] = info;
    });
    return map;
  }, [machinesList]);

  const enhancedMachinesList = useMemo(() => {
    const activeAssignedMachines = new Set<string>();
    allEmployees.forEach(emp => {
      const st = emp.status;
      if (st === 'مخفي' || st === 'hidden' || st === 'hide' || emp?.hidden || emp?.hide || st === 'غير نشط' || st === 'منتهي' || st === 'خارج العمل' || st === 'inactive') {
        return;
      }
      const m = (emp.machine || '').trim();
      if (m && m !== '---' && m !== 'لا يوجد' && m !== 'لا يوجد معدة' && m !== 'بدون معدة') {
        activeAssignedMachines.add(m);
        const parts = m.split(' ');
        const lastPart = parts[parts.length - 1];
        if (lastPart) activeAssignedMachines.add(lastPart);
      }
    });

    return machinesList.map(m => {
      const mId = (m.id || (Array.isArray(m) ? m[0] : '') || '').trim();
      const mCc = (m.costCenter || (Array.isArray(m) ? m[0] : '') || '').trim();
      const mName = (m.name || m.label || (Array.isArray(m) ? m[1] : '') || '').trim();
      const isReservedByActiveEmp = activeAssignedMachines.has(mId) ||
        (mCc && activeAssignedMachines.has(mCc)) ||
        (mName && activeAssignedMachines.has(mName));
      if (Array.isArray(m)) {
        return {
          id: m[0] || '',
          name: m[1] || m[0] || '',
          label: m[1] || m[0] || '',
          costCenter: m[0] || '',
          plate: m[2] || '',
          driver: isReservedByActiveEmp ? (m[3] || 'مسجل') : ''
        };
      }
      return {
        ...m,
        driver: isReservedByActiveEmp ? (m.driver || 'مسجل') : ''
      };
    });
  }, [machinesList, allEmployees]);

  const filteredEmployees = allEmployees.filter(emp => {
    const st = emp.status;
    if (st === 'مخفي' || st === 'hidden' || st === 'hide' || emp?.hidden || emp?.hide || st === 'غير نشط' || st === 'منتهي' || st === 'خارج العمل' || st === 'inactive') {
      return false;
    }
    const term = searchTerm.toLowerCase();
    const record = attendanceData[emp.userKey || ''];
    const isAbsOnPrev = getFridayAbsenceStatus(emp);
    const isAbsent = record ? record.status === 'absent' : (!isFriday || isAbsOnPrev);
    const isPresent = !isAbsent;
    const empLastLocationId = emp['lastLocation'] || '';
    let currentAreaId = record?.mainAreaId || '';
    const currentAreaName = record?.area || '';
    
    // لدعم السجلات القديمة التي تحتوي على الاسم فقط
    if (!currentAreaId && currentAreaName) {
      const foundEntry = Object.entries(locationMap).find(([id, name]) => name === currentAreaName);
      if (foundEntry) currentAreaId = foundEntry[0];
    }

    // القاعدة الأساسية: إذا تم تحضيره اليوم، نعتمد موقع التحضير. إذا كان غائباً، نعتمد آخر موقع معروف.
    const effectiveLocationId = currentAreaId ? currentAreaId : empLastLocationId;

    const hasAllPermission = areapermissions && areapermissions['الكل'];
    const isLocationPermitted = hasAllPermission || locations.includes(effectiveLocationId) || !effectiveLocationId;

    if (!isLocationPermitted) return false;

    const lastLocName = locationMap[empLastLocationId] || empLastLocationId;
    const matchesSearch = (
      emp.name_ar?.toLowerCase().includes(term) ||
      emp.iqama?.toLowerCase().includes(term) ||
      emp.job_title?.toLowerCase().includes(term) ||
      currentAreaName.toLowerCase().includes(term) ||
      lastLocName.toLowerCase().includes(term) ||
      (term === 'غائب' && isAbsent) ||
      (term === 'حاضر' && isPresent)
    );

    const matchesLocation = isAllLocationsSelected ? true : selectedLocations.includes(effectiveLocationId);
    
    if (showNoMachineWarningFilter) {
      const hasNoMachine = !emp.machine || emp.machine === '---' || emp.machine === 'لا يوجد' || emp.machine === 'لا يوجد معدة' || emp.machine === 'بدون معدة' || emp.machine.trim() === '';
      const mainJob = String(emp.job_title || emp.job || emp.profession || '').trim();
      const isDriver = mainJob === 'سائق' || mainJob.includes('سائق');
      const subJob = String(emp.sub_job || emp.subJob || '').trim();
      const hasNoSubJob = !subJob || subJob === '---' || subJob === 'لا يوجد' || subJob.trim() === '';

      const confirmVal = String(emp['تأكيد_المعدة_من_السائق'] || emp.تأكيد_المعدة_من_السائق || '').trim();
      let isUnconfirmed = false;
      if (!hasNoMachine && (confirmVal.startsWith('+') || confirmVal.startsWith('!'))) {
        const prefix = confirmVal.charAt(0);
        const confirmTs = Number(confirmVal.substring(1)) || 0;
        const empUpdateMs = Number(emp.machine_updated_at || 0);
        const machineInfo = machinesMap[emp.machine];
        const lastUpdateMs = Math.max(empUpdateMs, machineInfo ? machineInfo.updatedAt : 0);
        if (confirmTs > lastUpdateMs && prefix === '!') {
          isUnconfirmed = true;
        }
      }

      const isWarningTarget = (hasNoMachine && (isDriver || hasNoSubJob)) || isUnconfirmed;
      if (!isWarningTarget) return false;
    }

    return matchesSearch && matchesLocation;
  });

  const sortedEmployees = [...filteredEmployees].sort((a, b) => {
    const recA = attendanceData[a.userKey || ''];
    const recB = attendanceData[b.userKey || ''];
    const isAbsA = (recA ? recA.status === 'absent' : (!isFriday || getFridayAbsenceStatus(a)));
    const isAbsB = (recB ? recB.status === 'absent' : (!isFriday || getFridayAbsenceStatus(b)));
    const hasValidLocA = a.lastLocation && locations.includes(a.lastLocation);
    const hasValidLocB = b.lastLocation && locations.includes(b.lastLocation);
    let scoreA = !hasValidLocA ? 3 : (isAbsA ? 1 : 2);
    let scoreB = !hasValidLocB ? 3 : (isAbsB ? 1 : 2);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (a.name_ar || '').localeCompare(b.name_ar || '', 'ar');
  });

  const presentCount = filteredEmployees.filter(emp => {
    const rec = attendanceData[emp.userKey || ''];
    const isAbsOnPrev = getFridayAbsenceStatus(emp);
    return (rec && rec.status !== 'absent') || (isFriday && !isAbsOnPrev && !rec);
  }).length;

  const absentCount = filteredEmployees.filter(emp => {
    const rec = attendanceData[emp.userKey || ''];
    const isAbsOnPrev = getFridayAbsenceStatus(emp);
    if (isFriday) return (rec && rec.status === 'absent') || (!rec && isAbsOnPrev);
    return !rec || rec.status === 'absent';
  }).length;

  const noMachineWarningCount = useMemo(() => {
    return allEmployees.filter(emp => {
      const st = emp.status;
      if (st === 'مخفي' || st === 'hidden' || st === 'hide' || emp?.hidden || emp?.hide || st === 'غير نشط' || st === 'منتهي' || st === 'خارج العمل' || st === 'inactive') {
        return false;
      }

      // 1. التصفية حسب صلاحيات المراقب للمواقع
      const record = attendanceData[emp.userKey || ''];
      const empLastLocationId = emp['lastLocation'] || '';
      let currentAreaId = record?.mainAreaId || '';
      const currentAreaName = record?.area || '';
      if (!currentAreaId && currentAreaName) {
        const foundEntry = Object.entries(locationMap).find(([_, name]) => name === currentAreaName);
        if (foundEntry) currentAreaId = foundEntry[0];
      }
      const effectiveLocationId = currentAreaId ? currentAreaId : empLastLocationId;
      const hasAllPermission = areapermissions && areapermissions['الكل'];
      const isLocationPermitted = hasAllPermission || locations.includes(effectiveLocationId) || !effectiveLocationId;
      if (!isLocationPermitted) return false;

      // 2. التصفية حسب الموقع المحدد حالياً من المراقب
      const matchesLocation = isAllLocationsSelected ? true : selectedLocations.includes(effectiveLocationId);
      if (!matchesLocation) return false;

      // 3. التصفية حسب شرط التنبيه (سائق أو بدون مهنة فرعية وبدون معدة) أو حالة غير مؤكد
      const hasNoMachine = !emp.machine || emp.machine === '---' || emp.machine === 'لا يوجد' || emp.machine === 'لا يوجد معدة' || emp.machine === 'بدون معدة' || emp.machine.trim() === '';
      const mainJob = String(emp.job_title || emp.job || emp.profession || '').trim();
      const isDriver = mainJob === 'سائق' || mainJob.includes('سائق');
      const subJob = String(emp.sub_job || emp.subJob || '').trim();
      const hasNoSubJob = !subJob || subJob === '---' || subJob === 'لا يوجد' || subJob.trim() === '';

      const confirmVal = String(emp['تأكيد_المعدة_من_السائق'] || emp.تأكيد_المعدة_من_السائق || '').trim();
      let isUnconfirmed = false;
      if (!hasNoMachine && (confirmVal.startsWith('+') || confirmVal.startsWith('!'))) {
        const prefix = confirmVal.charAt(0);
        const confirmTs = Number(confirmVal.substring(1)) || 0;
        const empUpdateMs = Number(emp.machine_updated_at || 0);
        const machineInfo = machinesMap[emp.machine];
        const lastUpdateMs = Math.max(empUpdateMs, machineInfo ? machineInfo.updatedAt : 0);
        if (confirmTs > lastUpdateMs && prefix === '!') {
          isUnconfirmed = true;
        }
      }

      return (hasNoMachine && (isDriver || hasNoSubJob)) || isUnconfirmed;
    }).length;
  }, [allEmployees, attendanceData, locationMap, areapermissions, locations, selectedLocations, machinesMap]);

  useEffect(() => {
    if (noMachineWarningCount === 0 && showNoMachineWarningFilter) {
      setShowNoMachineWarningFilter(false);
    }
  }, [noMachineWarningCount, showNoMachineWarningFilter]);

  const initDates = (count: number) => {
    const dates: { value: string; label: string }[] = [];
    const nowLocal = getRealDate();
    const today = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate());

    for (let i = 0; i < count; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const year = d.getFullYear();
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const day = d.getDate().toString().padStart(2, '0');
      const monthNames = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
      const monthName = monthNames[d.getMonth()];

      const iso = `${year}-${month}-${day}`;
      dates.push({
        value: iso,
        label: i === 0 ? 'اليوم' : `${d.getDate()}/${monthName}`
      });
    }
    return dates;
  };

  const datesList = initDates(daysCount);

  return (
    <div className="h-screen bg-white text-right font-sans flex flex-col overflow-hidden" dir="rtl">
      {/* Edit Action/Reason Modal */}
      {editActionEmployee && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[100] flex items-end sm:items-center justify-center p-0 pb-16 sm:p-4 animate-fade-in no-print text-right" 
          dir="rtl"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setEditActionEmployee(null);
              setEditReason('');
              setShowSubJobDropdown(false);
            }
          }}
        >
          <div className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl border border-slate-200 animate-slide-up flex flex-col">
            {/* Mobile handle indicator */}
            <div className="w-12 h-1.5 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

            {/* Vibrant Profile Header */}
            <div className="px-4 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50/50">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-primary to-secondary text-white flex items-center justify-center shadow-md shadow-primary/25 shrink-0 font-black">
                  <User size={22} />
                </div>
                <div className="truncate">
                  <h3 className="text-base font-black text-slate-900 truncate">{editActionEmployee.name_ar}</h3>
                  {(() => {
                    const record = attendanceData[editActionEmployee.userKey || ''];
                    const isPresent = record ? record.status === 'present' : isFriday;
                    const locName = record?.area || locationMap[editActionEmployee.lastLocation] || editActionEmployee.lastLocation || '';

                    return (
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-slate-500 font-bold truncate">
                          {editActionEmployee.job_title_ar || editActionEmployee.profession_ar || editActionEmployee.job_title || 'موظف'}
                        </span>
                        {isPresent ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            حاضر {locName ? `• ${locName}` : ''}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-50 border border-rose-200 text-rose-700 shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            غائب
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              <button 
                type="button"
                onClick={() => { setEditActionEmployee(null); setEditReason(''); setShowSubJobDropdown(false); }} 
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Quick settings row: SubJob & Machine */}
            <div className="px-4 pt-3 pb-1 grid grid-cols-2 gap-2.5 shrink-0">
              <div className="relative" ref={subJobDropdownRef}>
                <button 
                  type="button"
                  onClick={() => setShowSubJobDropdown(!showSubJobDropdown)} 
                  className="w-full bg-emerald-50/60 hover:bg-emerald-100/70 border border-emerald-200/90 text-emerald-900 px-3 py-2.5 rounded-2xl transition-all flex items-center justify-between gap-1.5 font-black text-xs shadow-xs" 
                  title="تغيير الوظيفة الفرعية"
                >
                  <div className="flex items-center gap-2 truncate">
                    <div className="w-6 h-6 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-xs">
                      <Briefcase size={12} />
                    </div>
                    <span className="truncate">{editActionEmployee.sub_job || 'الوظيفة الفرعية'}</span>
                  </div>
                  <ChevronDown size={13} className="text-emerald-700/70 shrink-0" />
                </button>

                {showSubJobDropdown && (
                  <div className="absolute top-full right-0 mt-1.5 w-56 bg-white shadow-2xl rounded-2xl border border-slate-200 p-1.5 z-[110] max-h-56 overflow-y-auto text-slate-800" dir="rtl">
                    {SUB_JOB_OPTIONS.map((jobOption) => (
                      <button
                        key={jobOption}
                        type="button"
                        onClick={() => saveSubJob(jobOption, editActionEmployee)}
                        className={`w-full text-right px-3 py-2.5 text-xs font-bold rounded-xl transition-all flex items-center justify-between ${
                          editActionEmployee.sub_job === jobOption 
                            ? 'bg-emerald-50 text-emerald-800 font-black shadow-xs' 
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span>{jobOption}</span>
                        {editActionEmployee.sub_job === jobOption && <CheckCircle2 size={14} className="text-emerald-600" />}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => saveSubJob('', editActionEmployee)}
                      className="w-full text-right px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all border-t border-slate-100 mt-1"
                    >
                      بدون وظيفة فرعية (إلغاء)
                    </button>
                  </div>
                )}
              </div>

              <button 
                type="button"
                onClick={() => { setAssigningEquipmentFor(editActionEmployee); setEditActionEmployee(null); setEditReason(''); setShowSubJobDropdown(false); }} 
                className="w-full bg-blue-50/60 hover:bg-blue-100/70 border border-blue-200/90 text-blue-900 px-3 py-2.5 rounded-2xl transition-all flex items-center justify-center gap-2 font-black text-xs shadow-xs" 
                title="تغيير المعدة"
              >
                <div className="w-6 h-6 rounded-lg bg-primary text-white flex items-center justify-center shrink-0 shadow-xs">
                  <Truck size={12} />
                </div>
                <span className="truncate">تغيير المعدة</span>
              </button>
            </div>

            {/* Vibrant Action Cards */}
            <div className="p-4 space-y-2.5">
              {/* Primary Status Action: Attend or Absent */}
              {(() => {
                const record = attendanceData[editActionEmployee.userKey || ''];
                const isPresent = record ? record.status === 'present' : isFriday;

                return isPresent ? (
                  <button
                    type="button"
                    onClick={() => {
                      setReasonActionType('absent');
                      setReasonActionEmployee(editActionEmployee);
                      setActionReasonInput('');
                      setShowReasonModal(true);
                      setEditActionEmployee(null);
                    }}
                    className="w-full py-3.5 px-4 rounded-2xl font-black text-xs sm:text-sm transition-all flex items-center justify-center gap-2.5 bg-gradient-to-r from-rose-500 via-rose-600 to-red-600 hover:from-rose-600 hover:to-red-700 text-white shadow-lg shadow-rose-500/25 active:scale-[0.98] cursor-pointer"
                  >
                    <XCircle size={18} className="stroke-[2.5]" />
                    <span>تحويل الموظف إلى (غائب)</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setReasonActionType('attend');
                      setReasonActionEmployee(editActionEmployee);
                      setActionReasonInput('');
                      setShowReasonModal(true);
                      setEditActionEmployee(null);
                    }}
                    className="w-full py-3.5 px-4 rounded-2xl font-black text-xs sm:text-sm transition-all flex items-center justify-center gap-2.5 bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/25 active:scale-[0.98] cursor-pointer"
                  >
                    <CheckCircle2 size={18} className="stroke-[2.5]" />
                    <span>تحضير الموظف</span>
                  </button>
                );
              })()}

              {/* Move to new location */}
              <button
                type="button"
                onClick={() => {
                  setAssigningLocationFor(editActionEmployee);
                  setEditActionEmployee(null);
                }}
                className="w-full py-3 px-3.5 bg-white hover:bg-blue-50/60 border border-slate-200/90 hover:border-primary/40 rounded-2xl transition-all flex items-center justify-between gap-3 shadow-xs active:scale-[0.98] cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary group-hover:bg-primary group-hover:text-white flex items-center justify-center transition-colors shrink-0">
                    <MapPin size={16} />
                  </div>
                  <span className="font-black text-xs text-slate-800 group-hover:text-primary transition-colors">نقل إلى موقع جديد</span>
                </div>
                <ChevronLeft size={16} className="text-slate-300 group-hover:text-primary group-hover:-translate-x-0.5 transition-all shrink-0" />
              </button>

              {/* Terminate employee */}
              <button
                type="button"
                onClick={() => {
                  setTerminatingEmployee(editActionEmployee);
                  setShowTerminationPicker(true);
                  setEditActionEmployee(null);
                }}
                className="w-full py-3 px-3.5 bg-white hover:bg-amber-50/60 border border-slate-200/90 hover:border-amber-400 rounded-2xl transition-all flex items-center justify-between gap-3 shadow-xs active:scale-[0.98] cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 group-hover:bg-amber-600 group-hover:text-white flex items-center justify-center transition-colors shrink-0">
                    <Clock size={16} />
                  </div>
                  <span className="font-black text-xs text-slate-800 group-hover:text-amber-700 transition-colors">توقيف الموظف</span>
                </div>
                <ChevronLeft size={16} className="text-slate-300 group-hover:text-amber-500 group-hover:-translate-x-0.5 transition-all shrink-0" />
              </button>

              {/* Reset to default record */}
              {attendanceData[editActionEmployee.userKey || ''] && (
                <button
                  type="button"
                  onClick={() => {
                    deleteAttendance(editActionEmployee);
                    setEditActionEmployee(null);
                  }}
                  className="w-full py-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50/60 rounded-xl font-bold text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer mt-1"
                >
                  <Trash2 size={13} />
                  <span>حذف التعديل والعودة للحالة التلقائية</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reason Prompt Popup Modal */}
      {showReasonModal && reasonActionEmployee && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[110] flex items-end sm:items-center justify-center p-0 pb-16 sm:p-4 animate-fade-in no-print text-right" 
          dir="rtl"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowReasonModal(false);
              setReasonActionEmployee(null);
            }
          }}
        >
          <div className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl border border-slate-200 animate-slide-up flex flex-col">
            {/* Mobile handle */}
            <div className="w-12 h-1.5 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1.5 sm:hidden shrink-0" />

            <div className="px-4 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50/40">
              <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-md shrink-0 text-white ${
                  reasonActionType === 'absent'
                    ? 'bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/25'
                    : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/25'
                }`}>
                  <FileText size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">
                    {reasonActionType === 'absent' ? 'سبب تسجيل الغياب' : 'سبب تحضير الموظف'}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold">{reasonActionEmployee.name_ar}</p>
                </div>
              </div>
              <button 
                type="button"
                onClick={() => { setShowReasonModal(false); setReasonActionEmployee(null); }} 
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-[11px] font-black text-slate-600 mb-1.5">يرجى كتابة سبب التعديل أو التحضير:</label>
                <textarea
                  autoFocus
                  className={`w-full bg-slate-50 border rounded-2xl p-3.5 text-xs font-bold text-slate-800 outline-none transition-all h-24 resize-none shadow-inner ${
                    reasonActionType === 'absent'
                      ? 'border-slate-200 focus:border-rose-500 focus:bg-white focus:ring-4 focus:ring-rose-500/10'
                      : 'border-slate-200 focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10'
                  }`}
                  placeholder="اكتب السبب بالتفصيل هنا..."
                  value={actionReasonInput}
                  onChange={(e) => setActionReasonInput(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!actionReasonInput.trim()}
                  onClick={() => {
                    const reason = actionReasonInput.trim();
                    setShowReasonModal(false);
                    if (reasonActionType === 'absent') {
                      markAsAbsent(reasonActionEmployee, reason);
                    } else if (reasonActionType === 'attend') {
                      setEditReason(reason);
                      setAssignMode('attend');
                      setSelectingForEmployee(reasonActionEmployee);
                    }
                    setReasonActionEmployee(null);
                  }}
                  className={`py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-md active:scale-[0.98] ${
                    !actionReasonInput.trim() 
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none' 
                      : reasonActionType === 'absent'
                        ? 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-700 hover:to-red-700 text-white shadow-rose-500/25'
                        : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-emerald-500/25'
                  }`}
                >
                  <CheckCircle2 size={16} />
                  <span>تأكيد الإجراء</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowReasonModal(false);
                    setReasonActionEmployee(null);
                  }}
                  className="py-3 bg-slate-100 text-slate-600 hover:bg-slate-200 rounded-2xl font-bold text-xs transition-all flex items-center justify-center cursor-pointer"
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal A: Assign Fixed Location (All Sites) */}
      <CustomPickerModal
        isOpen={!!assigningLocationFor}
        onClose={() => { setAssigningLocationFor(null); setEditReason(''); }}
        title={`تعيين موقع: ${assigningLocationFor?.name_ar || ''}`}
        icon={MapPin}
        searchable={true}
        searchPlaceholder="بحث عن موقع..."
        options={allLocationsList.map(loc => ({
          id: loc,
          label: locationMap[loc] || loc,
          icon: MapPin,
        }))}
        selectedValue={assigningLocationFor?.lastLocation || ''}
        onSelect={(locId) => {
          setAssignMode('assign');
          saveAttendance(locId, "", assigningLocationFor!);
        }}
      />

      {/* Modal B: Assign Equipment using the built-in MachineSelectionModal */}
      <MachineSelectionModal
        isOpen={!!assigningEquipmentFor}
        onClose={() => setAssigningEquipmentFor(null)}
        allMachines={enhancedMachinesList}
        isMachinesLoading={false}
        currentMachineId={assigningEquipmentFor?.machine_id || assigningEquipmentFor?.machine || ''}
        employeeName={assigningEquipmentFor?.name_ar}
        onConfirmMachine={(machineId) => saveEquipment(machineId, assigningEquipmentFor!)}
        onClearMachine={() => saveEquipment('', assigningEquipmentFor!)}
      />

      {/* Termination Date Picker Modal */}
      {showTerminationPicker && terminatingEmployee && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[120] flex items-end sm:items-center justify-center p-0 pb-16 sm:p-4 animate-fade-in no-print text-right" 
          dir="rtl"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowTerminationPicker(false);
              setTerminatingEmployee(null);
              setPendingTerminationDate('');
            }
          }}
        >
          <div className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[82vh] border border-slate-200 animate-slide-up">
            {/* Mobile handle */}
            <div className="w-12 h-1.5 bg-slate-300 rounded-full mx-auto mt-2.5 mb-1.5 sm:hidden shrink-0" />

            <div className="px-4 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50/40">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white flex items-center justify-center shadow-md shadow-amber-500/25 shrink-0">
                  <Calendar size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">تاريخ التوقيف</h3>
                  <p className="text-[10px] text-slate-400 font-bold">{terminatingEmployee.name_ar}</p>
                </div>
              </div>
              <button 
                type="button"
                onClick={() => { setShowTerminationPicker(false); setTerminatingEmployee(null); setPendingTerminationDate(''); }} 
                className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div ref={terminationDateListRef} className="p-3 overflow-y-auto max-h-[50vh] space-y-1.5 no-scrollbar flex-1 scroll-smooth">
              {(() => {
                const dates = [];
                const today = new Date();
                const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
                for (let i = 0; i < 30; i++) {
                  const date = new Date();
                  date.setDate(today.getDate() - i);
                  const str = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
                  const dayNum = date.getDate();
                  const monthNum = date.getMonth() + 1;
                  const yearNum = date.getFullYear();
                  const dayName = arabicDays[date.getDay()];
                  const displayStr = `${dayNum}-${monthNum}-${yearNum} ${dayName}${i === 0 ? ' (اليوم)' : ''}`;
                  const isSelected = pendingTerminationDate === str;

                  dates.push(
                    <button
                      key={str}
                      type="button"
                      data-selected={isSelected}
                      onClick={() => setPendingTerminationDate(str)}
                      className={`w-full flex items-center justify-between p-2.5 px-3 rounded-2xl transition-all text-xs cursor-pointer border ${
                        isSelected
                          ? 'bg-gradient-to-l from-amber-50 via-orange-50/40 to-white border-amber-300 text-amber-950 font-black shadow-xs'
                          : 'bg-white hover:bg-slate-50 border-slate-100 text-slate-700 hover:text-slate-900 font-bold'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs transition-all ${
                          isSelected 
                            ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-xs' 
                            : 'bg-slate-100 text-slate-500'
                        }`}>
                          <Calendar size={13} />
                        </div>
                        <span className="font-black">{displayStr}</span>
                      </div>
                      {isSelected && <CheckCircle2 size={16} className="text-amber-600" />}
                    </button>
                  );
                }
                return dates;
              })()}
            </div>

            <div className="p-3 border-t border-slate-100 shrink-0 bg-slate-50/70">
              <button
                type="button"
                onClick={handleTerminateEmployee}
                disabled={!pendingTerminationDate || saving}
                className={`w-full py-3 rounded-2xl font-black text-xs flex items-center justify-center gap-2 shadow-md transition-all active:scale-[0.98] cursor-pointer
                  ${pendingTerminationDate
                    ? 'bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700 hover:from-amber-700 hover:to-orange-700 text-white shadow-amber-500/25'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
                  }
                `}
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Clock size={16} />}
                <span>تأكيـد التوقيـف</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Location Selector Modal */}
      <CustomPickerModal
        isOpen={!!selectingForEmployee}
        onClose={() => setSelectingForEmployee(null)}
        title={`اختيار الموقع: ${selectingForEmployee?.name_ar || ''}`}
        icon={MapPin}
        searchable={true}
        searchPlaceholder="بحث عن موقع..."
        options={locations.map(loc => ({
          id: loc,
          label: locationMap[loc] || loc,
          icon: MapPin,
        }))}
        selectedValue={selectingForEmployee?.lastLocation || ''}
        onSelect={(locId) => {
          saveAttendance(locId, editReason, selectingForEmployee!);
        }}
      />

      {/* Header */}
      <div className="bg-primary text-white p-2 z-50 shadow-lg shrink-0 no-print">
        <div className="flex items-center gap-2 mb-1.5 px-1">
          <button onClick={() => navigate('/?tab=tasks')} className="p-1.5 hover:bg-white/10 rounded-lg">
            <ArrowRight size={18} />
          </button>

          <div className="flex-1 relative flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute right-2 top-1.5 text-white/40" size={14} />
                <input
                  type="text"
                  placeholder={t("بحث...")}
                  className="w-full bg-white/10 border-none rounded-lg py-1.5 pr-8 pl-3 text-xs text-white placeholder:text-white/40 focus:bg-white/20 outline-none transition-all"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>

              {/* زر تحذير السائقين والموظفين بدون معدة — لا يظهر إلا عند وجود تنبيهات حقيقية (عدد أكبر من 0) */}
              {(noMachineWarningCount > 0 || showNoMachineWarningFilter) && (
                <button
                  onClick={() => setShowNoMachineWarningFilter(prev => !prev)}
                  className={`relative px-2.5 py-1.5 rounded-lg transition-all flex items-center justify-center gap-1 shrink-0 font-black text-[11px] cursor-pointer shadow-md ${
                    showNoMachineWarningFilter
                      ? 'bg-rose-700 text-white ring-2 ring-rose-300 shadow-lg'
                      : 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse'
                  }`}
                  title="تصفية السائقين أو من هم بدون مهنة فرعية وليس لديهم معدة"
                >
                  <span>تنبيه</span>
                  {noMachineWarningCount > 0 && (
                    <span className="bg-amber-400 text-rose-950 px-1.5 py-0.2 text-[9px] font-black rounded-full shadow-inner">
                      {noMachineWarningCount}
                    </span>
                  )}
                </button>
              )}

              {/* زر ملخص الشبكة */}
              <button
                onClick={() => setShowGridSummary(true)}
                className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg transition-all flex items-center justify-center gap-1 shrink-0 font-bold text-[11px]"
                title={t("ملخص الحضور الشهري")}
              >
                <FileBarChart size={12} className="text-amber-300" />
                <span>{t("تقرير")}</span>
              </button>

            {/* زر فلترة الموقع الأنيق والمخصص */}
            <button
              onClick={() => setShowLocationModal(true)}
              className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg transition-all flex items-center justify-center gap-1 shrink-0 font-bold text-[11px]"
            >
              <MapPin size={12} className="text-amber-300" />
              <span>
                {isAllLocationsSelected
                  ? 'الكل'
                  : selectedLocations.length === 1
                    ? (locationMap[selectedLocations[0]] || selectedLocations[0])
                    : `${selectedLocations.length} مواقع`}
              </span>
            </button>
          </div>
        </div>

        {/* Custom Location Modal */}
        <CustomPickerModal
          isOpen={showLocationModal}
          onClose={() => setShowLocationModal(false)}
          title="اختيار الموقع"
          icon={MapPin}
          enableMultiSelect={true}
          selectedValues={selectedLocations}
          onSelectMultiple={(locIds) => {
            setSelectedLocations(locIds.length > 0 ? locIds : ['الكل']);
          }}
          selectedValue={selectedLocation}
          onSelect={(locId) => setSelectedLocation(locId)}
          options={[
            ...(areapermissions['الكل'] || locations.length > 0 ? [{ id: 'الكل', label: 'جميع المواقع (الكل)', icon: MapPin }] : []),
            ...locations.map(locId => ({
              id: locId,
              label: locationMap[locId] || locId,
              icon: MapPin,
            }))
          ]}
        />

        {/* Date Strip */}
        <div className="flex items-center gap-1.5 py-1 border-t border-white/5 overflow-x-auto no-scrollbar">
            {datesList.map((date) => (
              <button
                key={date.value}
                onClick={() => setSelectedDate(date.value)}
                className={`shrink-0 px-2.5 py-1 rounded-md text-[10px] font-black transition-all ${selectedDate === date.value
                  ? 'bg-white text-blue-900 shadow-sm'
                  : 'bg-white/10 text-white/60'
                  }`}
              >
                {date.label}
              </button>
            ))}
            <button
              onClick={() => setDaysCount(prev => prev + 15)}
              className="shrink-0 px-2.5 py-1 rounded-md text-[10px] font-black bg-white/5 text-white/40 border border-white/5 hover:bg-white/10 transition-all"
            >
              المزيد...
            </button>
          </div>

        {/* Stats Bar */}
        <div className="flex justify-around items-center pt-1.5 border-t border-white/10 text-xs sm:text-sm font-black">
          <div className="flex items-center gap-1.5">
            <span className="opacity-70">الكل:</span>
            <span className="text-white bg-white/10 px-1.5 py-0.5 rounded-md">{filteredEmployees.length}</span>
          </div>
          <div className="flex items-center gap-1.5 text-emerald-300">
            <CheckCircle2 size={14} />
            <span>حاضر: {presentCount}</span>
          </div>
          <div className="flex items-center gap-1.5 text-rose-300">
            <XCircle size={14} />
            <span>غائب: {absentCount}</span>
          </div>
        </div>
      </div>

      {/* Print Only Header */}
      <div className="hidden print:block p-4 border-b-2 border-slate-900 mb-4">
        <h1 className="text-xl font-black text-center">تقرير حضور وانصراف الموظفين</h1>
        <div className="flex justify-between mt-2 font-bold text-sm">
          <span>التاريخ: {selectedDate}</span>
          <span>الإجمالي: {filteredEmployees.length} موظف</span>
        </div>
      </div>

      {/* Employee List - scrollable area */}
      {/* شريط تنبيه التصفية النشطة للمعدة */}
      {showNoMachineWarningFilter && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center justify-between mx-2 my-1.5 shadow-sm animate-fade-in no-print">
          <div className="flex items-center gap-2">
            <span>عرض الموظفين بدون تحديد معدة او بدون تحديد مهنة</span>
          </div>
          <button
            onClick={() => setShowNoMachineWarningFilter(false)}
            className="text-rose-700 hover:text-rose-900 text-[10px] bg-rose-100 hover:bg-rose-200 px-2.5 py-1 rounded-lg font-black transition-all cursor-pointer"
          >
            إلغاء التصفية
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2 pb-safe-lg">
        <div className="max-w-4xl mx-auto p-1 space-y-0.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <Loader2 className="animate-spin text-blue-600" size={24} />
              <p className="text-blue-900 font-bold text-xs">جاري التحميل...</p>
            </div>
          ) : sortedEmployees.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-xs mt-10">لا توجد سجلات</div>
          ) : (() => {
            const machineIntervalMs = (machineIntervalDays > 0 ? machineIntervalDays : 7) * 24 * 60 * 60 * 1000;
            const nowTs = Date.now();

            return sortedEmployees.map((employee, idx) => {
              const record = attendanceData[employee.userKey || ''];
              const isAbsOnPrev = getFridayAbsenceStatus(employee);
              const isAbsent = record ? record.status === 'absent' : (!isFriday || isAbsOnPrev);
              const isPresent = !isAbsent;

              const hasNoMachine = !employee.machine || employee.machine === '---' || employee.machine === 'لا يوجد' || employee.machine === 'لا يوجد معدة' || employee.machine === 'بدون معدة' || employee.machine.trim() === '';
              const machineInfo = !hasNoMachine ? machinesMap[employee.machine] : null;
              const rawMachineDisplay = hasNoMachine ? 'لا يوجد معدة' : (machineInfo ? machineInfo.display : employee.machine);

              const empUpdateMs = Number(employee.machine_updated_at || 0);
              const machineUpdateMs = machineInfo ? machineInfo.updatedAt : 0;
              const lastUpdateMs = Math.max(empUpdateMs, machineUpdateMs);

              const confirmVal = String(employee['تأكيد_المعدة_من_السائق'] || employee.تأكيد_المعدة_من_السائق || '').trim();
              let unconfirmedTag = '';
              if (!hasNoMachine && (confirmVal.startsWith('+') || confirmVal.startsWith('!'))) {
                const prefix = confirmVal.charAt(0);
                const confirmTs = Number(confirmVal.substring(1)) || 0;
                if (confirmTs > lastUpdateMs && prefix === '!') {
                  unconfirmedTag = ` (${t("غير مؤكد")})`;
                }
              }

              const machineDisplay = `${rawMachineDisplay}${unconfirmedTag}`;

              const isRecentUpdate = lastUpdateMs > 0 && (nowTs - lastUpdateMs) <= machineIntervalMs;
              const machineColorClass = hasNoMachine
                ? 'text-rose-500 font-bold'
                : (isRecentUpdate ? 'text-blue-600 font-black' : 'text-gray-400 font-bold');

              const mainJob = String(employee.job_title || employee.job || employee.profession || '').trim();
              const isDriver = mainJob === 'سائق' || mainJob.includes('سائق');
              const subJobText = String(employee.sub_job || employee.subJob || '').trim();

              let subNameDisplay = '';
              let subNameClass = '';

              if (!hasNoMachine) {
                if (!isDriver && subJobText && subJobText !== 'لا يوجد' && subJobText !== '---') {
                  subNameDisplay = `${subJobText} | ${machineDisplay}`;
                  subNameClass = 'text-slate-600 font-bold';
                } else {
                  subNameDisplay = machineDisplay;
                  subNameClass = machineColorClass;
                }
              } else if (isDriver) {
                subNameDisplay = 'لا يوجد معدة';
                subNameClass = 'text-rose-500 font-bold';
              } else {
                if (subJobText && subJobText !== 'لا يوجد' && subJobText !== '---') {
                  subNameDisplay = subJobText;
                  subNameClass = 'text-slate-600 font-bold';
                } else {
                  subNameDisplay = 'لا يوجد مهنة فرعية';
                  subNameClass = 'text-gray-400 font-bold';
                }
              }

              return (
                <div
                  key={idx}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border-b border-gray-50/50 hover:bg-slate-50 transition-all ${isAbsent ? 'bg-[#fff5f5]' : 'bg-[#f0fdf4]'} print:bg-white print:border-slate-200`}
                >
                  {/* Status Indicator */}
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isPresent ? 'bg-emerald-500' : 'bg-rose-500'} print:border print:border-slate-300`} />

                  <div className="flex-1 min-w-0 text-right">
                    <h3 className={`font-black text-xs truncate leading-tight ${!isPresent ? 'text-rose-600' : 'text-gray-800'}`}>{employee.name_ar || '-'}</h3>
                    <div className="text-[10px] text-gray-500 font-bold mt-1">
                      <div className="flex flex-wrap items-center gap-x-1">
                        <span className={subNameClass}>{subNameDisplay}</span>
                        <span className={`font-black mx-0.5 ${isPresent ? 'text-emerald-500' : 'text-rose-500'}`}>|</span>
                        <span className="text-gray-400 whitespace-nowrap">{record && record.status !== 'absent' ? record.area : (locationMap[employee.lastLocation] || employee.lastLocation || '---')}</span>
                      </div>
                      {record && record.notes && <div className="text-amber-600 mt-0.5 leading-none"> (السبب: {record.notes})</div>}
                    </div>
                  </div>

                  {/* Data Section */}

                  <div className={`text-[9px] font-black px-2 py-0.5 rounded ${isPresent ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'} print:border print:border-slate-200`}>
                    {!record ? (
                      isFriday 
                        ? (isAbsOnPrev ? 'غائب (جمعة)' : 'حاضر (جمعة)') 
                        : 'غائـب'
                    ) : (
                      record.status === 'present'
                        ? (record.manual ? 'حاضر (إداري)' : <span>{record.offlineRecord ? '📡 ' : ''}حاضر</span>)
                        : 'غائب (إداري)'
                    )}
                  </div>

                  {(() => {
                    // Check if observer has 'edit' permission for this specific employee's location
                    const record = attendanceData[employee.userKey || ''];
                    const locName = record?.area || 'الكل';

                    // If no permissions defined, hide edit button (Security First)
                    if (!areapermissions || Object.keys(areapermissions).length === 0) {
                      return null;
                    }

                    // Only allow editing if observer has specific 'edit' permission for THIS location
                    const currentLocId = record?.mainAreaId || employee.lastLocation;
                    let canEdit = areapermissions['الكل']?.mode === 'edit';

                    if (!canEdit && currentLocId) {
                      canEdit = areapermissions[currentLocId]?.mode === 'edit';
                    } else if (!canEdit && !currentLocId) {
                      // If no location at all, anyone with any edit permission can assign them (to their own sites)
                      canEdit = Object.values(areapermissions).some((p: any) => p.mode === 'edit');
                    }

                    if (!canEdit) return null;

                    const hasValidLoc = employee.lastLocation && locations.includes(employee.lastLocation);

                    return (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasValidLoc) {
                            handleRowClick(employee);
                          } else {
                            setAssigningLocationFor(employee);
                          }
                        }}
                        className={`px-3 py-1.5 rounded-lg font-black text-[10px] shadow-sm active:scale-95 transition-all no-print flex items-center gap-1 text-white ${hasValidLoc ? 'bg-blue-600' : 'bg-gray-600'}`}
                      >
                        <span>{hasValidLoc ? 'تعديل' : 'تعيين موقع'}</span>
                      </button>
                    );
                  })()}
                </div>
              );
            });
          })()}
        </div>
      </div>

      {saving && (
        <div className="fixed inset-0 bg-white/20 backdrop-blur-[1px] z-110 flex items-center justify-center no-print">
          <div className="bg-primary text-white px-4 py-2 rounded-full shadow-2xl flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-xs font-bold">جاري الحفظ...</span>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed toast-safe-bottom left-6 right-6 sm:left-auto sm:w-80 z-200 p-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-slide-up no-print ${toast.type === 'error' ? 'bg-rose-500 text-white' : 'bg-emerald-500 text-white'}`}>
          {toast.type === 'error' ? <XCircle size={20} /> : <CheckCircle2 size={20} />}
          <span className="font-bold text-sm">{toast.message}</span>
        </div>
      )}

      <AttendanceGridSummary
        isOpen={showGridSummary}
        onClose={() => setShowGridSummary(false)}
        employees={allEmployees}
        selectedDate={selectedDate}
        locations={locations}
        locationMap={locationMap}
        areapermissions={areapermissions}
        selectedLocation={selectedLocation}
        onLocationChange={setSelectedLocation}
      />

      <style>{`
                .no-scrollbar::-webkit-scrollbar { display: none; }
                .animate-slide-up { animation: slideUp 0.3s ease-out; }
                @keyframes slideUp {
                    from { transform: translateY(100%); }
                    to { transform: translateY(0); }
                }
                @media print {
                    .no-print { display: none !important; }
                    body { background: white; padding: 0; margin: 0; }
                    .max-w-4xl { max-width: 100%; }
                    .p-1 { padding: 0; }
                }
            `}</style>
    </div>
  );
};
