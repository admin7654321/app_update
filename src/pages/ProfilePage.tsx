
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { defaultUser, db, ensureAuthenticated, getRealDate, getRiyadhDate, getRiyadhDateStr, getRiyadhDayOfWeek, initServerTimeOffsetOnce, tryAutoMigrateFirebase } from '../services/firebase';
import { SettingsManager } from '../services/appSettings';
import { PermissionsService } from '../services/permissionsService';
import { UserData, TabType } from '../types';
import { APK_VERSION, OTA_VERSION, CLOUDFLARE_AUTH_URL, ENABLE_FIREBASE_FALLBACK, isSupervisor, isAdmin, getNativeApkVersion, getRunningOtaVersion } from '../constants';
import { UnifiedLoader } from '../components/UnifiedLoader';
import { ProfileCard } from '../components/ProfileCard';
import { TabButton } from '../components/TabButton';
import { ActionButton } from '../components/ActionButton';
import { User, Wallet, CalendarClock, Settings, FileBarChart, AlertCircle, AlertTriangle, MapPin, CheckCircle, XCircle, Loader2, Navigation, UserPlus, CalendarX, RefreshCw, History, LayoutDashboard, Truck, FileText, X, Share2, ShieldCheck, IdCard, UserCheck, ArrowUp, Search, ChevronUp, ChevronDown, WifiOff, Bluetooth, Radio } from 'lucide-react';
import { ref, get, update, query, orderByChild, equalTo } from 'firebase/database';
import { Geolocation } from '@capacitor/geolocation';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { NotificationType } from '@capacitor/haptics';
import { AppUpdateBanner } from '../components/AppUpdateBanner';
import { useHaptics } from '../hooks/useHaptics';

import { LocationMap } from '../components/LocationMap';
import { MachineSelectionModal } from '../components/MachineSelectionModal';
import { MachineConfirmationModal } from '../components/MachineConfirmationModal';
import { DynamicWarningModal } from '../components/DynamicWarningModal';
import { AccrualCalendar } from '../components/AccrualCalendar';
import { computeAccrualPeriod, computeAttendanceCalendar, resolveSiteName } from '../utils/attendanceCalendar';
import { AttendanceButton, computeAttendanceState } from '../components/AttendanceButton';
import { checkMockLocation, resetMockLocationHistory } from '../services/mockLocation';
import { useTranslation } from '../utils/i18n';
import { useToast } from '../context/ToastContext';
import { addBreadcrumb, logEvent } from '../services/logService';
import { useOfflineMode } from '../components/OfflineGateway';
import { cacheWorkAreas, getCachedWorkAreas, getPendingAttendance } from '../services/offlineStorage';
import { swrCache } from '../services/swrCache';
import { JobStatsCard } from '../components/JobStatsCard';
import { bleAttendanceService } from '../services/bleAttendanceService';
import { edgeBootstrapService } from '../services/edgeBootstrapService';

export const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const { t, lang, setLanguage } = useTranslation();
  const { hapticImpact, hapticSelection, hapticNotification } = useHaptics();
  const { isOfflineMode } = useOfflineMode();

  // ⚡ SWR Cache: قراءة فورية لبيانات الموظف لفتح الصفحة في 0 ثانية
  const [user, setUser] = useState<UserData>(() => {
    const cached = swrCache.get<UserData>('profile');
    if (cached) return cached;
    try {
      const raw = localStorage.getItem("cached_user_profile");
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return defaultUser;
  });

  const [loading, setLoading] = useState(true);

  // حالة المزامنة في الخلفية للتنبيه الأنيق غير المزعج
  const [backgroundSyncStatus, setBackgroundSyncStatus] = useState<'idle' | 'syncing' | 'offline'>('idle');
  const [activeTab, setActiveTab] = useState<TabType | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const { showToast, hideToast } = useToast();
  const setNotification = (n: { msg: string, type: 'success' | 'info' | 'error' | 'warning' } | null) => {
    if (!n) hideToast();
    else showToast(n.msg, n.type);
  };
  const [loansBalance, setLoansBalance] = useState<number | null>(null);
  const [absenceCount, setAbsenceCount] = useState<number | null>(null);
  const [locationAttendanceCount, setLocationAttendanceCount] = useState<number>(0);
  const [manualAttendanceCount, setManualAttendanceCount] = useState<number>(0);
  const [timecardStats, setTimecardStats] = useState<{ duty: number, extra: number } | null>(null);
  const [fetchingTimecard, setFetchingTimecard] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [accrualPeriod, setAccrualPeriod] = useState<{ start: string, end: string }>({ start: '', end: '' });
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const now = getRealDate();
    const r = getRiyadhDate(now);
    return `${r.getUTCFullYear()}-${(r.getUTCMonth() + 1).toString().padStart(2, '0')}`;
  }); // YYYY-MM
  const [calendarDays, setCalendarDays] = useState<any[]>([]);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [isCalendarLoading, setIsCalendarLoading] = useState<boolean>(false);

  // Geolocation & Attendance State
  const [areaName, setAreaName] = useState<string | null>(null);
  const [mainAreaId, setMainAreaId] = useState<string | null>(null);
  const [subAreaId, setSubAreaId] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<string>("جاري تحديد الموقع...");

  const [isInside, setIsInside] = useState(false);
  const isInsideRef = useRef(false);
  isInsideRef.current = isInside;
  const [attendanceType, setAttendanceType] = useState<'location' | 'bluetooth'>('location');
  const attendanceTypeRef = useRef<'location' | 'bluetooth'>('location');
  attendanceTypeRef.current = attendanceType;
  const bufferedBleResultRef = useRef<any>(null);
  const bleFallbackTimerRef = useRef<any>(null);
  const [attendanceTime, setAttendanceTime] = useState<string | null>(null);
  const [attendanceTimestamp, setAttendanceTimestamp] = useState<number | null>(null);
  const [isVerifyingGpsForBle, setIsVerifyingGpsForBle] = useState(false);
  const [isBleBroadcastingActive, setIsBleBroadcastingActive] = useState(false);
  const [isBleScanning, setIsBleScanning] = useState(false);
  const [locationPermissionWarning, setLocationPermissionWarning] = useState<'location_services_disabled' | 'location_permission_denied' | 'precise_location_disabled' | null>(null);
  const [blePermissionWarning, setBlePermissionWarning] = useState<'bluetooth_turned_off' | 'nearby_devices_disabled' | null>(null);
  const [nativeApkVersion, setNativeApkVersion] = useState<string>('');
  const [isMockLocation, setIsMockLocation] = useState(false);
  const [cachedLocationAreas, setCachedLocationAreas] = useState<any[]>([]);
  const [lastLocationFetch, setLastLocationFetch] = useState<number>(0);
  const [isMarkedAbsent, setIsMarkedAbsent] = useState(false);

  // Computed warning status for location and nearby devices
  const effectiveWarning = useMemo<'location_services_disabled' | 'location_permission_denied' | 'precise_location_disabled' | 'bluetooth_turned_off' | 'nearby_devices_disabled' | null>(() => {
    const status = locationStatus || '';

    // 1. تشغيل الموقع في الهاتف (GPS Services Disabled)
    if (
      status === "يرجى تفعيل الموقع في الهاتف" ||
      status === "يرجى تفعيل خدمات الموقع بالهاتف" ||
      locationPermissionWarning === 'location_services_disabled'
    ) {
      return 'location_services_disabled';
    }

    // 2. إذن الموقع مرفوض (Location Permission Denied)
    if (
      status === "تم رفض الوصول للموقع" ||
      status === "يرجى السماح للتطبيق بالوصول للموقع" ||
      status === "المتصفح لا يدعم تحديد الموقع" ||
      locationPermissionWarning === 'location_permission_denied'
    ) {
      return 'location_permission_denied';
    }

    // 3. الموقع الدقيق مطلوب (Precise Location Required)
    if (
      status === "الموقع الدقيق مطلوب" ||
      status === "تعذر تحديد الموقع" ||
      locationPermissionWarning === 'precise_location_disabled'
    ) {
      return 'precise_location_disabled';
    }

    // 4. تشغيل راديو البلوتوث (Bluetooth Radio Off)
    if (blePermissionWarning === 'bluetooth_turned_off') {
      return 'bluetooth_turned_off';
    }

    // 5. إذن الأجهزة المجاورة (Nearby Devices Permission Denied)
    if (blePermissionWarning === 'nearby_devices_disabled') {
      return 'nearby_devices_disabled';
    }

    return null;
  }, [locationStatus, locationPermissionWarning, blePermissionWarning]);

  const hasLocationWarning =
    effectiveWarning === 'location_services_disabled' ||
    effectiveWarning === 'location_permission_denied' ||
    effectiveWarning === 'precise_location_disabled';

  // Location Map State
  const [showMapModal, setShowMapModal] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number, longitude: number } | null>(null);

  const [systemClosed, setSystemClosed] = useState(false);
  const [userBlocked, setUserBlocked] = useState(false);
  const [blockMessage, setBlockMessage] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- Temporary Machine State (For viewing documents only) ---
  const [tempMachineId, setTempMachineId] = useState<string | null>(null);
  const [tempMachineName, setTempMachineName] = useState<string | null>(null);
  const [isSwitchingMachine, setIsSwitchingMachine] = useState(false);
  const [newMachineInput, setNewMachineInput] = useState("");
  const [allMachines, setAllMachines] = useState<any[]>([]);
  const [isMachinesLoading, setIsMachinesLoading] = useState(false);
  const [isPermanentMachineChange, setIsPermanentMachineChange] = useState(false);
  const [showMachineSearch, setShowMachineSearch] = useState(false);

  // --- Initial/Weekly Machine Setup Modal ---
  const [showInitMachineModal, setShowInitMachineModal] = useState(false);
  const [initModalReason, setInitModalReason] = useState<'none' | 'no_machine' | 'weekly_recommendation'>('none');
  const [activeWarningsQueue, setActiveWarningsQueue] = useState<any[]>([]);
  const [dynamicWarnings, setDynamicWarnings] = useState<any[]>([]);
  const [appSettingsState, setAppSettingsState] = useState<any>(null);
  const [userTaskPermissions, setUserTaskPermissions] = useState<Record<string, boolean> | null>(null);
  const [showMachineSetting, setShowMachineSetting] = useState(true);
  const [hideMachineChangeButton, setHideMachineChangeButton] = useState(false);
  const [hideMachineTab, setHideMachineTab] = useState(false);
  const [selectedMachineIdx, setSelectedMachineIdx] = useState(0);
  const [isRemovingMachine, setIsRemovingMachine] = useState(false);
  const pickerScrollRef = useRef<HTMLDivElement>(null);



  // ⚡ الفحص المشروط لمناطق العمل:
  // 1. في حالة تم تسجيل الحضور مسبقاً ⬅️ يكتفي بالتخزين المحلي مسبقاً دون أي طلب لفايرباس.
  // 2. في حالة لم يتم تسجيل الحضور بعد ⬅️ يقرأ من فايرباس مباشرةً لتحضير وتجهيز مناطق العمل مسبقاً!
  useEffect(() => {
    if (attendanceTime !== null || isMarkedAbsent) {
      // ⛔ تم تسجيل الحضور مسبقاً → يكتفي بالتخزين المحلي فقط
      const loadCachedOnly = async () => {
        try {
          const cached = await getCachedWorkAreas();
          if (cached && cached.areas && cached.areas.length > 0) {
            setCachedLocationAreas(cached.areas);
          }
        } catch (e) {
          console.warn("Failed to read cached work areas:", e);
        }
      };
      loadCachedOnly();
      return;
    }

    // ✅ تجهيز مناطق العمل مسبقاً من ذاكرة الووركر الفائقة أو الكاش
    const preloadWorkAreasFromFirebase = async () => {
      try {
        const cached = await getCachedWorkAreas();
        if (cached && cached.areas && cached.areas.length > 0) {
          setCachedLocationAreas(cached.areas);
        }
        const memAreas = edgeBootstrapService.getMemoryWorkAreas();
        let snap: any = memAreas.exists() ? memAreas : null;
        if (!snap && ENABLE_FIREBASE_FALLBACK) {
          snap = await get(ref(db, "workAreas")).catch(() => null);
        }
        if (snap && snap.exists()) {
          const val = snap.val();
          const data: any[] = [];
          Object.keys(val).forEach(key => {
            if (key !== 'hide') data.push({ ...val[key], id: key });
          });
          if (data.length > 0) {
            setCachedLocationAreas(data);
            cacheWorkAreas(data);
          }
        }
      } catch (e) {
        console.warn("preloadWorkAreasFromFirebase error:", e);
      }
    };

    preloadWorkAreasFromFirebase();
  }, [attendanceTime, isMarkedAbsent]);

  // التمرير التلقائي للمعدة الحالية عند فتح الشاشة
  useEffect(() => {
    if (showInitMachineModal && allMachines.length > 0) {
      const currentMachineId = user.machine_id;
      const idx = allMachines.findIndex(m => m.id === currentMachineId);
      if (idx !== -1) {
        setSelectedMachineIdx(idx);
        setTimeout(() => {
          if (pickerScrollRef.current) {
            pickerScrollRef.current.scrollTop = idx * 32;
          }
        }, 200);
      }
    }
  }, [showInitMachineModal, allMachines, user.machine_id]);

  const filteredMachines = allMachines.filter(m => 
    m.id.trim() !== '---' && 
    m.costCenter.trim() !== '---' &&
    (!newMachineInput.trim() || 
    m.id.toLowerCase().includes(newMachineInput.toLowerCase()) || 
    m.name.toLowerCase().includes(newMachineInput.toLowerCase()) ||
    m.costCenter.toLowerCase().includes(newMachineInput.toLowerCase()) ||
    m.plate.toLowerCase().includes(newMachineInput.toLowerCase()))
  );

  const handleScrollLocal = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const itemHeight = 32;
    const scrollTop = container.scrollTop;
    const index = Math.round(scrollTop / itemHeight);
    if (index >= 0 && index < filteredMachines.length) {
      setSelectedMachineIdx(index);
      setIsRemovingMachine(false);
    }
  };

  // --- Zoom & Pan State ---
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [lastTouch, setLastTouch] = useState<{ x: number, y: number } | null>(null);
  const [lastDistance, setLastDistance] = useState<number | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  // --- Scroll & UI State ---
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- Loans Balance Monitoring ---
  const [loansDiff, setLoansDiff] = useState<number>(0);
  const [showDiffAlternate, setShowDiffAlternate] = useState(false);

  const watchIdRef = useRef<string | null>(null);
  const lastLocRef = useRef<{ latitude: number, longitude: number } | null>(null);
  const lastAccRef = useRef<number | null>(null);
  const cachedLocationAreasRef = useRef<any[]>([]);
  const lastLocationFetchRef = useRef<number>(0);
  const location = useLocation();

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateScroll = () => {
      if (container) {
        setShowScrollTop(container.scrollTop > 100);
      }
    };

    container.addEventListener('scroll', updateScroll);
    updateScroll(); // Initial check
    return () => container.removeEventListener('scroll', updateScroll);
  }, [activeTab]); // Re-bind when tab changes as content height changes

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // تنظيف مراقب الموقع عند الخروج من الصفحة لمنع استهلاك البطارية والرام
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        try {
          if (navigator.geolocation) {
            navigator.geolocation.clearWatch(Number(watchIdRef.current));
          } else {
            Geolocation.clearWatch({ id: watchIdRef.current });
          }
        } catch {
          Geolocation.clearWatch({ id: watchIdRef.current });
        }
        watchIdRef.current = null;
      }
      resetMockLocationHistory();
    };
  }, []);

  // سيتم مسح التنبيه يدوياً عند الدخول لصفحة السلف فلا نحتاج لـ interval هنا
  useEffect(() => {
    if (loansDiff === 0) {
      setShowDiffAlternate(false);
    } else if (loansDiff > 0 && dynamicWarnings && dynamicWarnings.length > 0) {
      const userJob = (user?.job_title || '').trim();
      const loanWarns = dynamicWarnings.filter((w: any) => {
        const matchesJob = !w.targetJob || w.targetJob === 'all' || w.targetJob === '' || w.targetJob.trim() === userJob;
        return w.type === 'loan_increase' && w.enabled !== false && SettingsManager.shouldShowByTime(w) && matchesJob;
      });
      loanWarns.forEach((warn: any) => {
        const formattedText = warn.text.replace(/\[loansDiff\]/g, loansDiff.toString());
        setActiveWarningsQueue(prev => {
          if (prev.some(p => p.id === warn.id)) return prev;
          return [...prev, { ...warn, text: formattedText }];
        });
      });
    }
  }, [loansDiff, dynamicWarnings]);

  // فحص تنبيهات الغياب الديناميكية عند احتسابها
  useEffect(() => {
    if (absenceCount !== null && absenceCount > 0 && dynamicWarnings && dynamicWarnings.length > 0) {
      const userJob = (user?.job_title || '').trim();
      const absenceWarns = dynamicWarnings.filter((w: any) => {
        const matchesJob = !w.targetJob || w.targetJob === 'all' || w.targetJob === '' || w.targetJob.trim() === userJob;
        return w.type === 'high_absence' && w.enabled !== false && SettingsManager.shouldShowByTime(w) && matchesJob;
      });
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      absenceWarns.forEach((warn: any) => {
        const threshold = warn.absenceThreshold || 3;
        if (absenceCount > threshold) {
          const lastShownRaw = localStorage.getItem(`last_shown_dynamic_${warn.id}`);
          const lastShown = lastShownRaw ? parseInt(lastShownRaw, 10) : 0;
          if (Date.now() - lastShown > ONE_DAY_MS) {
            const formattedText = warn.text.replace(/\[absenceCount\]/g, absenceCount.toString());
            setActiveWarningsQueue(prev => {
              if (prev.some(p => p.id === warn.id)) return prev;
              return [...prev, { ...warn, text: formattedText }];
            });
          }
        }
      });
    }
  }, [absenceCount, dynamicWarnings]);

  // غلق نافذة عرض الصور عند الضغط على زر الرجوع في الهاتف
  useEffect(() => {
    if (!fullscreenImage) return;

    const backListener = App.addListener('backButton', () => {
      setFullscreenImage(null);
      setIsImageLoading(false);
      resetZoom();
    });

    return () => {
      backListener.then(l => l.remove());
    };
  }, [fullscreenImage]);

  // تحديثات التطبيق — تُدار داخل AppUpdateBanner ونستقبل الحالة عبر callback
  const [hasUpdate, setHasUpdate] = useState(false);
  const [lockAttendance, setLockAttendance] = useState(false);

  useEffect(() => {
    const initPage = async () => {
      let userKey = localStorage.getItem("userKey");
      
      // 🛡️ إذا كان الـ localStorage فارغاً، نحاول استعادة المفتاح من الذاكرة الدائمة
      if (!userKey) {
        const { value: prefUserKey } = await Preferences.get({ key: 'userKey' });
        if (prefUserKey) {
          userKey = prefUserKey;
          localStorage.setItem("userKey", prefUserKey);
          // مزامنة بقية الإعدادات أيضاً
          await syncStorageFromPreferences();
        }
      }

      const cachedMonth = localStorage.getItem("selectedAppMonth");
      const cachedUser = localStorage.getItem("cached_user_profile");

      if (cachedMonth) setSelectedMonth(cachedMonth);
      if (cachedUser) try { setUser(JSON.parse(cachedUser)); } catch (e) { }

      if (!userKey?.trim()) {
        navigate('/login');
        return;
      }

      // Check URL params for active tab
      const params = new URLSearchParams(location.search);
      const tabParam = params.get('tab') as TabType;
      if (tabParam === 'tasks' || tabParam === 'profile') {
        setActiveTab(tabParam);
      } else {
        setActiveTab(null);
      }

      // ⚡ إطلاق تتبع الموقع ومسح البلوتوث فوراً في 0 ثانية عند فتح الصفحة بدون أي انتظار للشبكة
      const nowLocal = getRealDate();
      const todayStr = getRiyadhDateStr(nowLocal);
      const isFriday = getRiyadhDayOfWeek(nowLocal) === 5;
      const cachedAttRaw = localStorage.getItem(`cached_attendance_${todayStr}_${userKey}`);
      let isAlreadyAttended = false;
      if (cachedAttRaw) {
        try {
          const parsed = JSON.parse(cachedAttRaw);
          if (parsed.status === 'present') isAlreadyAttended = true;
        } catch {}
      }

      if (!isAlreadyAttended && !isFriday) {
        startLocationTracking();
      }

      loadUserData();
      
      // 🛡️ فحص صامت للتأمين (Insurance) في الخلفية لضمان وجود نسخة احتياطية
      ensureBackupInsurance();
    };

    initPage();
  }, [navigate, location.search]);





  const syncStorageFromPreferences = async () => {
    try {
      const keys = ['userKey', 'deviceId', 'firebase_config', 'fcmToken', 'brand_asset', 'cached_user_profile', 'selectedAppMonth', 'lastEmail', 'lastPass'];
      for (const key of keys) {
        const { value } = await Preferences.get({ key });
        if (value) {
          localStorage.setItem(key, value);
        }
      }
      console.log("✅ Storage synced from Preferences");
    } catch (e) {
      console.error("❌ Sync error:", e);
    }
  };

  const ensureBackupInsurance = async () => {
    try {
      const { value: prefUserKey } = await Preferences.get({ key: 'userKey' });
      const localUserKey = localStorage.getItem("userKey");

      if (!prefUserKey && localUserKey) {
        const keys = ['userKey', 'deviceId', 'firebase_config', 'fcmToken', 'brand_asset', 'cached_user_profile', 'selectedAppMonth', 'lastEmail', 'lastPass'];
        for (const key of keys) {
          const localVal = localStorage.getItem(key);
          if (localVal) {
            await Preferences.set({ key, value: localVal });
          }
        }
        console.log("🛡️ Backup Insurance Secured!");
      }
    } catch (e) {
      console.warn("Insurance check skipped:", e);
    }
  };

  const loadUserData = async () => {
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams(location.search);
    const isTabRequested = params.has('tab');
    const userKeyRaw = localStorage.getItem("userKey");
    const deviceIdRaw = localStorage.getItem("deviceId");
    const userKey = userKeyRaw ? userKeyRaw.trim() : null;
    const deviceId = deviceIdRaw ? deviceIdRaw.trim() : null;

    if (!userKey || !deviceId) {
      if (navigate) navigate('/login');
      setLoading(false);
      return;
    }

    // ─── مسار الأوفلاين ─────────────────────────────────
    if (isOfflineMode) {
      addBreadcrumb("Loading offline profile");
      try {
        const cachedStr = localStorage.getItem("cached_user_profile");
        if (cachedStr) {
          const freshUser = JSON.parse(cachedStr);
          setUser(freshUser);
        }

        const nowLocal = getRealDate();
        const todayStr = getRiyadhDateStr(nowLocal);
        
        // التحقق من السجلات المحلية (لمنع تسجيل الحضور المزدوج وتحديث زر الحضور)
        const pending = await getPendingAttendance();
        const todayPending = pending.find(r => r.date === todayStr && r.userKey === userKey);
        
        let attended = false;
        if (todayPending) {
          setAttendanceTime(todayPending.time);
          setAreaName(todayPending.area);
          setIsMarkedAbsent(false);
          attended = true;
        } else {
          // التحقق مما إذا كان قد سجل حضور أونلاين مسبقاً في نفس اليوم
          const cachedAttStr = localStorage.getItem(`cached_attendance_${todayStr}_${userKey}`);
          if (cachedAttStr) {
            const attData = JSON.parse(cachedAttStr);
            if (attData.status === 'absent') {
              setIsMarkedAbsent(true);
              setAttendanceTime(null);
              setAttendanceTimestamp(null);
              attended = true;
            } else if (attData.status === 'present') {
              setAttendanceTime(attData.time);
              if (attData.timestamp) setAttendanceTimestamp(attData.timestamp);
              if (attData.area) setAreaName(attData.area);
              setIsMarkedAbsent(false);
              attended = true;
            }
          }
        }

        const params = new URLSearchParams(location.search);
        const isTabRequested = params.has('tab');

        if (isTabRequested) {
           const tabVal = params.get('tab') as TabType;
           if (['profile', 'calendar', 'tasks', 'activity', 'system_tasks'].includes(tabVal)) {
             setActiveTab(tabVal);
           } else {
             setActiveTab('profile');
           }
        }

        setLoading(false);

        if (!attended) {
          if (!isTabRequested) {
             setActiveTab(null);
             setDataLoaded(false);
          }
          const isFriday = getRiyadhDayOfWeek(nowLocal) === 5;
          if (!isFriday) {
            startLocationTracking();
          } else {
            setLocationStatus("الجمعة");
          }
        } else {
          setLocationStatus("تم تسجيل الحضور مسبقاً");
        }
      } catch (e) {
        console.error("Offline load error:", e);
        setLoading(false);
      }
      return; // توقف هنا ولا تحاول الاتصال بفايرباس
    }

    // ─── مسار الأونلاين (المصادقة في الخلفية والتحميل الفوري من الووركر) ──────────────────

    // 🔑 تشغيل مصادقة فايربيس في الخلفية بصمت دون تقييد أو تعطيل تحميل الصفحة (Non-blocking Background Auth)
    addBreadcrumb("Starting loadUserData (Background Auth)");
    ensureAuthenticated().catch((err) => {
      console.warn("⚠️ [Background Auth] Firebase session check deferred:", err);
    });
    addBreadcrumb("Background Auth initiated in loadUserData");

    const timeoutId = setTimeout(() => {
      setLoading(false);
    }, 12000);

    try {
      if (!userKey) {
        localStorage.clear();
        if (navigate) navigate('/login');
        return;
      }

      const nowLocal = getRealDate();
      const todayStr = getRiyadhDateStr(nowLocal);

      // ⚡ تحميل البيانات من كلود فلير وتجهيزها في الذاكرة لتأخذها الطلبات المتسلسلة بطبيعتها القديمة
      try {
        await edgeBootstrapService.prepareBootstrap(userKey, deviceId, todayStr, 5000);
      } catch (bErr) {
        console.warn("[ProfilePage] Edge Bootstrap error:", bErr);
      }

      // 🔴 [TEST_MODE_WORKER_ONLY] فحص وضع التجربة: إذا كان الـ Fallback معطلاً ولم ترجع بيانات من الووركر، نوقف العملية بوضوح
      if (!ENABLE_FIREBASE_FALLBACK && !edgeBootstrapService.hasMemory()) {
        throw new Error("⚠️ [وضع التجربة: Worker Only] فشل استلام الحزمة من Cloudflare Worker! والـ Fallback المباشر لقاعدة فايربيس معطل حالياً للتأكد بنسبة 100% أن البيانات تأتي من الووركر فقط.");
      }

      if (!ENABLE_FIREBASE_FALLBACK && edgeBootstrapService.hasMemory()) {
        console.log("⚡⚡ [CLOUDFLARE WORKER ACTIVE] تم استلام البيانات بنجاح 100% من Cloudflare Worker (الـ Fallback المباشر لفايربيس معطل). ⚡⚡");
      }

      // 1️⃣ مزامنة الوقت أولاً: تأخذ التوقيت الموثوق من الذاكرة فوراً أو من سيرفر فايرباس
      await initServerTimeOffsetOnce();
      const dateStr = getRiyadhDateStr(getRealDate());

      // 2️⃣ إطلاق الطلبات المتسلسلة: تأخذ من الذاكرة (الووركر) حصراً عند تعطيل الـ Fallback
      const useMemoryOnly = !ENABLE_FIREBASE_FALLBACK || edgeBootstrapService.hasMemory();

      const deviceCheckPromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemoryDevice(deviceId)!)
        : get(ref(db, `devices/${deviceId}`));

      const systemLockPromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemorySystemLock()!)
        : get(ref(db, "SystemLockData/General"));

      const userLockPromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemoryUserLock(userKey)!)
        : get(ref(db, `SystemLockData/Users/${userKey}`));

      const profilePromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemoryProfile(userKey)!)
        : get(ref(db, `قائمة_الموظفين/${userKey}`));

      const settingsVersionPromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemoryVersions()!)
        : get(ref(db, "SystemSettings/AppSettings/versions"));

      const attendancePromise = useMemoryOnly
        ? Promise.resolve(edgeBootstrapService.getMemoryAttendance(dateStr, userKey)!)
        : get(ref(db, `بيانات_الحضور_حسب_اليوم/${dateStr}/${userKey}`));

      const [attS, profS, settS] = await Promise.all([
        attendancePromise,
        profilePromise,
        settingsVersionPromise
      ]);
      const attendanceSnap = attS;
      const profileSnap = profS;
      const settingsVersionSnap = settS;

      const serverVersion = settingsVersionSnap.exists() ? settingsVersionSnap.val() : 0;
      const profileJobTitle = profileSnap.exists() ? (profileSnap.val()?.job_title || '') : '';

      // ✅ تشغيل SettingsManager والصلاحيات بالتوازي — يحذف جولة شبكة كاملة للمشرفين
      // الموظف العادي لا يرى تبويب المهام → PermissionsService يُتخطى كلياً (Promise.resolve(null))
      const [appSettings, generalPerms] = await Promise.all([
        SettingsManager.loadSettings(serverVersion),
        isSupervisor(profileJobTitle)
          ? PermissionsService.getUserPermissions(userKey).catch((err: any) => {
              console.error("Error loading user permissions in ProfilePage:", err);
              return null;
            })
          : Promise.resolve(null)
      ]);

      setAppSettingsState(appSettings);
      if (generalPerms && generalPerms.tasks) {
        setUserTaskPermissions(generalPerms.tasks);
      }

      setShowMachineSetting(appSettings.officialWindows?.machine?.enabled !== false);
      setHideMachineChangeButton(appSettings.hideMachineChangeButton === true);
      setHideMachineTab(appSettings.hideMachineTab === true);
      setDynamicWarnings(appSettings.dynamicWarnings || []);

      SettingsManager.checkAndProcessWarningsReset(appSettings.dynamicWarnings || []);
      SettingsManager.checkAndProcessOfficialWindowsReset(appSettings.officialWindows || {});

      let attended = false;
      if (attendanceSnap.exists()) {
        const attData = attendanceSnap.val();
        localStorage.setItem(`cached_attendance_${dateStr}_${userKey}`, JSON.stringify(attData));
        if (attData.status === 'absent') {
          setIsMarkedAbsent(true);
          setAttendanceTime(null);
          setAttendanceTimestamp(null);
          attended = true;
        } else if (attData.status === 'present') {
          setAttendanceTime(attData.time);
          if (attData.timestamp) setAttendanceTimestamp(attData.timestamp);
          if (attData.area) setAreaName(attData.area);
          setIsMarkedAbsent(false);
          attended = true;
        }
      } else {
        localStorage.removeItem(`cached_attendance_${dateStr}_${userKey}`);
      }

      let freshUser: UserData | null = null;
      if (profileSnap.exists()) {
        const pData = profileSnap.val();

        const rawMachineId = pData.machine;
        const cachedMachineName = rawMachineId ? localStorage.getItem(`machine_name_${rawMachineId}`) : null;
        let displayMachine = pData.machine_name || cachedMachineName || pData.machine || "لا يوجد معدة";

        freshUser = {
          key: userKey || '0',
          name_ar: pData.name_ar || "مستخدم",
          name_en: pData.name_en || "",
          iqama: pData.iqama || "---",
          nationality: pData.nationality || "---",
          machine: displayMachine,
          imageurl: pData.imageurl || "",
          job_title: pData.job_title || "عامل",
          sub_job: pData.sub_job || pData.subJob || "",
          loans: pData.loans || 0,
          absence: pData.absence || 0,
          start_date: pData.start_date || "",
          end_date: pData.end_date || "",
          status: pData.status || "نشط",
          lastLocation: pData.lastLocation || "",
          machine_id: pData.machine || "",
          machine_updated_at: pData.machine_updated_at || 0,
          ['تأكيد_المعدة_من_السائق']: pData['تأكيد_المعدة_من_السائق'] || pData.تأكيد_المعدة_من_السائق || "",
          employment_history: pData.employment_history || undefined
        };
        setUser(freshUser);
        localStorage.setItem("cached_user_profile", JSON.stringify(freshUser));
        swrCache.set("profile", freshUser);
        setBackgroundSyncStatus('idle');

        // 🚗 حفظ وتأكيد تفاصيل المعدة وتحديثها بالخلفية
        if (pData.machine_name) {
          localStorage.setItem(`machine_name_${rawMachineId}`, pData.machine_name);
        } else if (db && rawMachineId && rawMachineId !== "---" && rawMachineId !== "لا يوجد" && !rawMachineId.includes(" ")) {
          get(ref(db, `قائمة_المعدات/${rawMachineId}`)).then((eqSnap: any) => {
            if (eqSnap.exists()) {
              const fullMachineName = `${eqSnap.val().type || ""} ${rawMachineId}`.trim();
              setUser(prev => ({ ...prev, machine: fullMachineName }));
              localStorage.setItem(`machine_name_${rawMachineId}`, fullMachineName);
            }
          }).catch((e: any) => console.warn("Failed to fetch machine type:", e));
        }

        // ⚡ تحميل تفاصيل الملف الشخصي فقط إذا كان التبويب المطلوب صراحة هو 'profile'
        if (params.get('tab') === 'profile') {
          loadDetailedDataInBackground(userKey, freshUser);
        }

        // 🌐 تحديد اللغة تلقائياً بناءً على جنسية الموظف
        const rawNationality = (pData.nationality || "").trim();
        const arabicCountries = [
          "مصر", "مصري", "السودان", "سوداني", "اليمن", "يمني", "السعودية", "سعودي", "الإمارات", "إماراتي", 
          "قطر", "قطري", "الكويت", "كويتي", "عمان", "عماني", "البحرين", "بحريني", "العراق", "عراقي", 
          "الأردن", "أردني", "لبنان", "لبناني", "سوريا", "سوري", "فلسطين", "فلسطيني", "تونس", "تونسي", 
          "الجزائر", "جزائري", "المغرب", "مغربي", "ليبيا", "ليبي", "موريتانيا", "موريتاني", "الصومال", "صومالي"
        ];
        const urduCountries = [
          "باكستان", "باكستاني", "الهند", "هندي", "بنغلادش", "بنغلاديش", "بنغالي", "بنغلاديشي",
          "Pakistan", "Pakistani", "India", "Indian", "Bangladesh", "Bangladeshi",
          "أفغانستان", "افغانستان", "أفغاني", "افغاني", "Afghanistan", "Afghan"
        ];

        const nowTime = Date.now();
        const lastAutoSetLang = SettingsManager.getLastAutoSetLangTime();
        const isWeeklyLangUpdate = nowTime - lastAutoSetLang > 7 * 24 * 60 * 60 * 1000;
        const savedLang = localStorage.getItem('app_lang');

        const autoResetLangSetting = appSettings.autoResetLanguage !== false;

        if (autoResetLangSetting && (!savedLang || isWeeklyLangUpdate)) {
          let targetLang: 'ar' | 'ur' = 'ar'; // الافتراضي
          if (rawNationality && urduCountries.some(c => rawNationality.includes(c) || c.includes(rawNationality))) {
            targetLang = 'ur';
          } else if (rawNationality && arabicCountries.some(c => rawNationality.includes(c) || c.includes(rawNationality))) {
            targetLang = 'ar';
          }

          if (savedLang !== targetLang) {
            setLanguage(targetLang);
            localStorage.setItem('app_lang', targetLang);
          }
          SettingsManager.setLastAutoSetLangTime(nowTime);
        }

        // 🛡️ التحقق من حالة المعدة وعرض النافذة الترحيبية/التحديث الأسبوعي
        const machineIdVal = pData.machine || "";
        const hasNoMachine = !machineIdVal || machineIdVal === "---" || machineIdVal === "لا يوجد" || machineIdVal === "لا يوجد معدة" || machineIdVal === "بدون معدة" || machineIdVal.trim() === "";
        
        // مقارنة المركبة القادمة من فايرباس بالمركبة المحفوظة سابقاً محلياً
        const lastAssignedMachine = SettingsManager.getLastAssignedMachine();
        const wasMachineWithdrawn = !!(lastAssignedMachine && lastAssignedMachine !== "NONE" && lastAssignedMachine !== "---" && lastAssignedMachine !== "لا يوجد" && lastAssignedMachine !== "لا يوجد معدة" && hasNoMachine);

        const nowMs = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        const lastMachineShown = SettingsManager.getOfficialWindowShownAt('machine');
        
        const machineIntervalDays = appSettings.officialWindows?.machine?.intervalDays || 7;
        const isWeeklyMachineTime = nowMs - lastMachineShown > machineIntervalDays * ONE_DAY_MS;

        let shouldShowMachineModal = false;
        let machineModalReason = '';

        const showMachineSetting = appSettings.officialWindows?.machine?.enabled !== false;

        if (showMachineSetting) {
          if (wasMachineWithdrawn) {
            // تم سحب المركبة من قبل موظف آخر وتغيرت في فايرباس -> تخطي القيد الأسبوعي وإظهار النافذة فوراً
            machineModalReason = 'machine_withdrawn';
            shouldShowMachineModal = true;
            fetchAllMachines();
            SettingsManager.setLastAssignedMachine("NONE");
          } else if (hasNoMachine && lastAssignedMachine === null) {
            machineModalReason = 'no_machine';
            shouldShowMachineModal = true;
            fetchAllMachines();
          } else if (isWeeklyMachineTime) {
            machineModalReason = 'weekly_recommendation';
            shouldShowMachineModal = true;
            fetchAllMachines();
          }
        }

        // --- Evaluate Periodic Dynamic Warnings ---
        const initialWarnings: any[] = [];
        if (appSettings.dynamicWarnings && Array.isArray(appSettings.dynamicWarnings)) {
          const empJobTitle = (freshUser?.job_title || user?.job_title || '').trim();
          appSettings.dynamicWarnings.forEach((warn: any) => {
            const matchesJob = !warn.targetJob || warn.targetJob === 'all' || warn.targetJob === '' || warn.targetJob.trim() === empJobTitle;
            if (warn.type === 'periodic' && warn.enabled !== false && SettingsManager.shouldShowByTime(warn) && matchesJob) {
              const lastShownRaw = localStorage.getItem(`last_shown_dynamic_${warn.id}`);
              const lastShown = lastShownRaw ? parseInt(lastShownRaw, 10) : 0;
              const intervalDays = warn.intervalDays || 7;
              if (nowMs - lastShown > intervalDays * ONE_DAY_MS) {
                initialWarnings.push(warn);
              }
            }
          });
        }

        // Apply "single warning per day" algorithm for periodic dynamic warnings
        if (initialWarnings.length > 0) {
          setActiveWarningsQueue([initialWarnings[0]]);
          for (let i = 1; i < initialWarnings.length; i++) {
            const warn = initialWarnings[i];
            const intervalDays = warn.intervalDays || 7;
            const delayedTime = nowMs - (intervalDays - 1) * ONE_DAY_MS;
            localStorage.setItem(`last_shown_dynamic_${warn.id}`, delayedTime.toString());
          }
        }
        
        // عرض نافذة المعدة بشكل مستقل عن التحذيرات
        if (shouldShowMachineModal) {
          setInitModalReason(machineModalReason as any);
          setShowInitMachineModal(true);
        }
      }

      // isTabRequested و params تم تعريفهما في بداية loadUserData

      (async () => {
        try {
          const [deviceSnap, lockSnap, userLockSnap] = await Promise.all([
            deviceCheckPromise,
            systemLockPromise,
            userLockPromise
          ]);

          if (!deviceSnap.exists()) {
            console.log("Device record not found in active database — attempting circuit breaker recovery...");
            const emergencyMigrated = await tryAutoMigrateFirebase(CLOUDFLARE_AUTH_URL, true);
            if (emergencyMigrated) {
              window.location.reload();
              return;
            }
            localStorage.clear();
            navigate('/login');
            return;
          }

          const deviceData = deviceSnap.val();
          const realUserKey = deviceData.userKey;

          const actualApkVersion = await getNativeApkVersion();
          const actualOtaVersion = await getRunningOtaVersion();

          await initServerTimeOffsetOnce();
          let safeLastSeen = "";
          try { safeLastSeen = getRealDate().toISOString(); } catch(e) {}
          update(ref(db, `devices/${deviceId}`), { 
            appVersion: actualApkVersion,
            otaVersion: actualOtaVersion,
            lastSeen: safeLastSeen
          }).catch(e => console.error("Update version error:", e));

          if (realUserKey !== userKey) {
            localStorage.setItem("userKey", realUserKey);
            window.location.reload();
            return;
          }

          const lockData = lockSnap.exists() ? lockSnap.val() : {};
          const globalMsg = lockData.Message || "النظام مغلق حالياً للصيانة.";
          if ((lockData.Status || "active") === "closed") {
            setSystemClosed(true);
            setBlockMessage(globalMsg);
            return;
          }

          if (userLockSnap.exists() && userLockSnap.val().isBlocked === true) {
            setUserBlocked(true);
            setBlockMessage(userLockSnap.val().message || globalMsg);
            return;
          }

          if (attended) {
            if (!params.has('tab')) {
              setActiveTab('profile');
              if (freshUser) {
                loadDetailedDataInBackground(userKey, freshUser);
              }
            }
          }
        } catch (e) {
          console.error("Background sync error:", e);
        }
      })();

      setLoading(false);

      if (!attended) {
        if (!isTabRequested) {
          setActiveTab(null);
          setDataLoaded(false);
        }
        const today = getRealDate();
        const isFriday = getRiyadhDayOfWeek(today) === 5;
        if (!isFriday) {
          startLocationTracking();
        } else {
          setLocationStatus("الجمعة");
        }
      } else {
        setLocationStatus("تم تسجيل الحضور مسبقاً");
      }
    } catch (err: any) {
      console.error("Error loading user data:", err);
      if (err?.code === 'PERMISSION_DENIED' || err?.message?.includes('permission')) {
        localStorage.clear();
        navigate('/login');
      } else {
        // إذا كان لدى المستخدم بيانات محفوظة مسبقاً، لا نحجب الشاشة بخطأ بل نفعل وضع الأوفلاين الأنيق
        const hasCachedUser = user && user.key && user.key !== '0' && user.key !== '';
        if (hasCachedUser) {
          setBackgroundSyncStatus('offline');
        } else {
          if (
            err?.code === 'too_many_connections' ||
            err?.message?.includes('too_many_connections') ||
            err?.message?.includes('maxSessions') ||
            err?.message?.includes('Connection refused') ||
            err?.status === 429
          ) {
            setLoadError("النظام مشغول حالياً، يرجى المحاولة بعد لحظات");
          } else {
            setLoadError(`فشل تحميل البيانات، يرجى التحقق من الاتصال والمحاولة مرة أخرى.\nالتفاصيل: ${err?.message || JSON.stringify(err)}`);
          }
        }
      }
      logEvent('ERROR', 'ProfilePage_loadUserData', { error: err, userKey, deviceId });
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  const loadDetailedDataInBackground = async (userKey: string, userData: UserData) => {
    setIsCalendarLoading(true);
    const now = getRealDate();
    const rNow = getRiyadhDate(now);
    const savedMonth = localStorage.getItem("selectedAppMonth") || `${rNow.getUTCFullYear()}-${(rNow.getUTCMonth() + 1).toString().padStart(2, '0')}`;

    setAccrualPeriod(computeAccrualPeriod(savedMonth, now, userData.start_date, userData.end_date));

    // ⚡ الطلب الثاني: جلب تفاصيل الملف الشخصي (الإجازات، الحضور الشهري، السلف) من Cloudflare Worker
    if (!edgeBootstrapService.hasProfileDetails(savedMonth)) {
      try {
        await edgeBootstrapService.fetchProfileDetails(userKey, savedMonth);
      } catch (err) {
        console.warn("[ProfilePage] fetchProfileDetails error:", err);
      }
    }

    await Promise.all([
      calculateAbsences(userKey, savedMonth, userData.start_date, userData.end_date, userData.lastLocation, userData.employment_history),
      calculateLoans(userKey)
    ]);

    setDataLoaded(true);
    setIsCalendarLoading(false);
  };

  const handleMonthChange = async (newMonth: string) => {
    setSelectedMonth(newMonth);
    localStorage.setItem("selectedAppMonth", newMonth);
    const userKey = localStorage.getItem("userKey");
    if (!userKey) return;

    setIsCalendarLoading(true);
    try {
      const now = getRealDate();
      setAccrualPeriod(computeAccrualPeriod(newMonth, now, user.start_date, user.end_date));
      // ⚡ جلب بيانات الشهر الجديد عبر الووركر إذا لم تكن متوفرة في الذاكرة
      if (!edgeBootstrapService.hasProfileDetails(newMonth)) {
        await edgeBootstrapService.fetchProfileDetails(userKey, newMonth);
      }
      await calculateAbsences(userKey, newMonth, user?.start_date, user?.end_date, user?.lastLocation, user?.employment_history);
    } catch (e) {
      console.error(e);
    } finally {
      setIsCalendarLoading(false);
    }
  };



  const calculateLoans = async (userKey: string | null) => {
    const cleanKey = userKey ? userKey.trim() : null;
    if (!cleanKey) return;

    addBreadcrumb(`Starting calculateLoans for ${cleanKey}`);

    // ⚡ 1. فحص ذاكرة الووركر الفائقة للسلف (0ms)
    const memLoans = edgeBootstrapService.getMemoryLoans(cleanKey);
    if (memLoans && memLoans.exists()) {
      const totalBalance = memLoans.balance;
      const cached = localStorage.getItem(`last_loans_balance_${cleanKey}`);
      if (cached !== null) {
        const lastVal = parseFloat(cached);
        if (lastVal !== totalBalance) {
          setLoansDiff(totalBalance - lastVal);
        } else {
          setLoansDiff(0);
        }
      }
      localStorage.setItem(`last_loans_balance_${cleanKey}`, totalBalance.toString());
      setLoansBalance(totalBalance);
      return;
    }

    if (!ENABLE_FIREBASE_FALLBACK) {
      setLoansBalance(0);
      setLoansDiff(0);
      return;
    }

    // 🛡️ التأكد من صحة الجلسة قبل جلب مبالغ السلف من فايربيس
    await ensureAuthenticated();

    try {
      const advancesRef = ref(db, 'جدول_السلف');
      const advancesQuery = query(advancesRef, orderByChild('employee_id'), equalTo(cleanKey));
      const snapshot = await get(advancesQuery);

      if (snapshot.exists()) {
        const allAdvances = snapshot.val() as Record<string, any>;
        const totalBalance = Object.values(allAdvances).reduce((sum: number, advance: any) => {
          const debit = parseFloat(advance.debit) || parseFloat(advance.amount) || 0;
          const credit = parseFloat(advance.credit) || 0;
          return sum + (debit - credit);
        }, 0);

        // مقارنة المبلغ الحالي بالمحفوظ في الذاكرة
        const cached = localStorage.getItem(`last_loans_balance_${userKey}`);
        if (cached !== null) {
          const lastVal = parseFloat(cached);
          if (lastVal !== totalBalance) {
            setLoansDiff(totalBalance - lastVal);
          } else {
            setLoansDiff(0);
          }
        }
        localStorage.setItem(`last_loans_balance_${userKey}`, totalBalance.toString());
        setLoansBalance(totalBalance);
      } else {
        setLoansBalance(0);
        setLoansDiff(0);
        localStorage.setItem(`last_loans_balance_${userKey}`, "0");
      }
    } catch (error) {
      console.error("Error calculating loans:", error);
    }
  };

  const fetchTimecardStats = async (userKey: string | null) => {
    const cleanKey = userKey ? userKey.trim() : null;
    if (!cleanKey) return;
    setFetchingTimecard(true);

    // 🛡️ التأكد من صحة الجلسة قبل جلب إحصائيات الدوام
    await ensureAuthenticated();

    const now = getRealDate();
    const monthKey = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;

    try {
      let totalDuty = 0;
      let totalExtra = 0;

      const driverIndexSnap = await get(ref(db, `فهرس_السائقين_في_جدول_الدوام/${cleanKey}/${monthKey}`));

      if (driverIndexSnap.exists()) {
        const dayEntries = driverIndexSnap.val();

        const rowPaths: string[] = [];
        for (const [dayStr, shifts] of Object.entries(dayEntries) as any) {
          if (typeof shifts !== 'object') continue;
          for (const [shiftKey, rows] of Object.entries(shifts) as any) {
            if (typeof rows !== 'object') continue;
            for (const [entryKey, indexData] of Object.entries(rows) as any) {
              const shiftPath = shiftKey;
              const rowPath = `جدول_الدوام_حسب_المراقب/${indexData.username}/${monthKey}/${dayStr}/${shiftPath}/${indexData.key}`;
              rowPaths.push(rowPath);
            }
          }
        }

        const fetchPromises = rowPaths.map(path => get(ref(db, path)));
        const snapshots = await Promise.all(fetchPromises);

        snapshots.forEach(rowSnap => {
          if (rowSnap.exists()) {
            const val = rowSnap.val();
            totalDuty += parseFloat(val.driver_duty) || 0;
            totalExtra += parseFloat(val.driver_extra) || 0;
          }
        });
      }

      setTimecardStats({ duty: totalDuty, extra: totalExtra });
    } catch (error) {
      console.error("Error fetching timecard stats:", error);
    } finally {
      setFetchingTimecard(false);
    }
  };

  const calculateAbsences = async (
    userKey: string | null,
    monthKey?: string,
    userStartDate?: string,
    userEndDate?: string,
    userLastLocation?: string,
    employmentHistory?: any
  ) => {
    addBreadcrumb(`Starting calculateAbsences for ${monthKey || 'current'}`);
    const cleanUserKey = userKey ? userKey.trim() : null;
    if (!cleanUserKey) return;
    
    setIsCalendarLoading(true);
    setCalendarError(null);

    const now = getRealDate();
    const targetMonth = monthKey || `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;

    try {
      const hiringDate = userStartDate || user.start_date || "";
      const contractEndDate = userEndDate || user.end_date || "";

      // ⚡ 1. فحص ذاكرة الووركر الفائقة لحضور الشهر وأيام الإجازات والمناطق (0ms)
      const memMonthlyAtt = edgeBootstrapService.getMemoryMonthlyAttendance(cleanUserKey, targetMonth);
      const memHolidays = edgeBootstrapService.getMemoryHolidays();
      const memAreas = edgeBootstrapService.getMemoryWorkAreas();

      let snapshot: any = memMonthlyAtt;
      let holidaysSnap: any = memHolidays;
      let workAreasSnap: any = memAreas;

      if ((!snapshot?.exists() || !holidaysSnap?.exists() || !workAreasSnap?.exists()) && ENABLE_FIREBASE_FALLBACK) {
        // 🛡️ تشغيل المصادقة قبل جلب البيانات المفقودة من فايربيس
        ensureAuthenticated().catch(() => {});
        const [s, h, w] = await Promise.all([
          !snapshot?.exists() ? get(ref(db, `بيانات_الحضور_حسب_الموظف/${cleanUserKey}/${targetMonth}`)).catch(() => null) : Promise.resolve(snapshot),
          !holidaysSnap?.exists() ? get(ref(db, `ايام_الاجازات`)).catch(() => null) : Promise.resolve(holidaysSnap),
          !workAreasSnap?.exists() ? get(ref(db, `workAreas`)).catch(() => null) : Promise.resolve(workAreasSnap)
        ]);
        if (s) snapshot = s;
        if (h) holidaysSnap = h;
        if (w) workAreasSnap = w;
      }
      const logs = snapshot.exists() ? snapshot.val() : {};

      const holidaysData = holidaysSnap.exists() ? holidaysSnap.val() : {};
      const siteName = resolveSiteName(
        userLastLocation || user?.lastLocation,
        workAreasSnap.exists() ? workAreasSnap.val() : null
      );

      const result = computeAttendanceCalendar({
        targetMonth,
        logs,
        holidaysData,
        siteName,
        hiringDate,
        contractEndDate,
        now,
        employmentHistory,
      });

      setCalendarDays(result.days);
      setAbsenceCount(result.absenceCount);
      setLocationAttendanceCount(result.locationCount);
      setManualAttendanceCount(result.manualCount);
    } catch (e: any) {
      console.error("Error calculating absences:", e);
      const errMsg = e?.message || String(e);
      const isPermission = errMsg.includes('PERMISSION_DENIED') || errMsg.includes('permission');
      
      const msg = isPermission
        ? `نقص في الصلاحيات (Permission Denied)\nالمسار: ${errMsg.includes('workAreas') ? 'مناطق العمل' : errMsg.includes('ايام_الاجازات') ? 'الإجازات' : 'بيانات الحضور'}`
        : `تعذّر جلب بيانات الحضور: ${errMsg.substring(0, 80)}`;
        
      setCalendarError(msg);
      logEvent('ERROR', 'ProfilePage_Calendar', { error: e, userKey: cleanUserKey, targetMonth });
    } finally {
      setIsCalendarLoading(false);
    }
  };

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const isPointInPolygon = (point: { lat: number, lng: number }, vs: any[]) => {
    const x = Number(point.lat), y = Number(point.lng);
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = Number(vs[i].lat), yi = Number(vs[i].lng);
      const xj = Number(vs[j].lat), yj = Number(vs[j].lng);
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };


  const checkAllHardwarePermissions = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location === 'denied') {
          setLocationPermissionWarning('location_permission_denied');
          setLocationStatus("تم رفض الوصول للموقع");
        } else if (perm.location !== 'granted') {
          setLocationPermissionWarning('precise_location_disabled');
          setLocationStatus("الموقع الدقيق مطلوب");
        } else {
          setLocationPermissionWarning(null);
        }
      } catch (err: any) {
        const msg = (err?.message || '').toLowerCase();
        if (msg.includes("location services are not enabled") || msg.includes("location disabled")) {
          setLocationPermissionWarning('location_services_disabled');
          setLocationStatus("يرجى تفعيل الموقع في الهاتف");
        }
      }

      // فحص دقيق: هل المشكلة إذن الأجهزة المجاورة أم إطفاء راديو البلوتوث؟
      try {
        const bleState = await bleAttendanceService.getBleState();
        if (bleState === 'permission_denied') {
          setBlePermissionWarning('nearby_devices_disabled');
        } else if (bleState === 'radio_off') {
          setBlePermissionWarning('bluetooth_turned_off');
        } else {
          setBlePermissionWarning(null);
        }
      } catch {
        setBlePermissionWarning('nearby_devices_disabled');
      }
    } else {
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const status = await navigator.permissions.query({ name: 'geolocation' });
          if (status.state === 'denied') {
            setLocationPermissionWarning('location_disabled');
            setLocationStatus("تم رفض الوصول للموقع");
          } else {
            setLocationPermissionWarning(null);
          }
        } catch {}
      }
    }
  };

  const startLocationTracking = async (retryCount = 0) => {
    addBreadcrumb("Starting location tracking");
    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== 'granted') {
          const req = await Geolocation.requestPermissions();
          if (req.location !== 'granted') {
            setLocationPermissionWarning(req.location === 'denied' ? 'location_disabled' : 'precise_location_disabled');
            setLocationStatus("الموقع الدقيق مطلوب");
            setIsInside(false);
            return;
          }
        }
        setLocationPermissionWarning(null);
      } catch (permErr: any) {
        console.error("Permission/GPS check error:", permErr);
        const msg = (permErr?.message || permErr?.errorMessage || '').toLowerCase();
        if (msg.includes("location services are not enabled") || msg.includes("location disabled")) {
          setLocationPermissionWarning('location_disabled');
          setLocationStatus("يرجى تفعيل الموقع في الهاتف");
          setIsInside(false);
          return;
        } else if (msg.includes("denied") || msg.includes("permission")) {
          setLocationPermissionWarning('precise_location_disabled');
          setLocationStatus("الموقع الدقيق مطلوب");
          setIsInside(false);
          return;
        }
      }
    } else {
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const status = await navigator.permissions.query({ name: 'geolocation' });
          if (status.state === 'denied') {
            setLocationPermissionWarning('location_disabled');
            setLocationStatus("الموقع الدقيق مطلوب");
            setIsInside(false);
            return;
          }
          setLocationPermissionWarning(null);
        } catch {}
      }
    }

    if (!navigator.geolocation) {
      setLocationPermissionWarning('location_disabled');
      setLocationStatus("المتصفح لا يدعم تحديد الموقع");
      setIsInside(false);
      return;
    }

    if (watchIdRef.current !== null) {
      try { navigator.geolocation.clearWatch(Number(watchIdRef.current)); } catch {}
      watchIdRef.current = null;
    }

    if (retryCount === 0) {
      setLocationStatus("جاري تحديد الموقع...");
    } else {
      setLocationStatus("جاري تحسين إشارة الـ GPS...");
    }

    // 🛡️ تفعيل البلوتوث كبديل فوري صامت في حال تعذر أو تأخر الـ GPS
    const activateBleFallback = () => {
      const ble = bufferedBleResultRef.current;
      if (!ble || !ble.found || !ble.mainAreaId) return false;
      if (attendanceTypeRef.current === 'location' && isInsideRef.current) return false;

      let areasForScan = cachedLocationAreas.length > 0 ? cachedLocationAreas : cachedLocationAreasRef.current;
      if (!areasForScan || areasForScan.length === 0) {
        try {
          const raw = localStorage.getItem("cached_work_areas");
          if (raw) areasForScan = JSON.parse(raw);
        } catch {}
      }
      const matchedArea = (areasForScan || []).find((a: any) => a.id === ble.mainAreaId);
      const locName = matchedArea?.name || ble.areaName || ble.mainAreaId;

      attendanceTypeRef.current = 'bluetooth';
      isInsideRef.current = true;
      setAreaName(locName);
      setMainAreaId(ble.mainAreaId);
      setSubAreaId(ble.subAreaId || null);
      if (ble.coords) {
        setCurrentLocation(ble.coords);
      }
      setIsInside(true);
      setAttendanceType('bluetooth');
      setLocationStatus(`الموقع الحالي: ${locName}  (بلوتوث)`);
      return true;
    };

    if (bleFallbackTimerRef.current) clearTimeout(bleFallbackTimerRef.current);
    // ⏱️ مهلة 4 ثوانٍ للـ GPS: إن تأخر الـ GPS ولم يلتقط، يُفعّل البلوتوث المحفوظ تلقائياً
    bleFallbackTimerRef.current = setTimeout(() => {
      if (!isInsideRef.current || attendanceTypeRef.current !== 'location') {
        activateBleFallback();
      }
    }, 4000);

    try {
      // 📡 مسار البلوتوث الصامت: التقاط الإشارة وحفظها في الذاكرة المؤقتة (Buffer) كطوق نجاة
      if (Capacitor.isNativePlatform()) {
        let areasForScan = cachedLocationAreasRef.current;
        if (!areasForScan || areasForScan.length === 0) {
          try {
            const raw = localStorage.getItem("cached_work_areas");
            if (raw) areasForScan = JSON.parse(raw);
          } catch {}
        }
        if (!areasForScan) areasForScan = [];

        bleAttendanceService.scanForPeerAttendance(8000, areasForScan).then((bleResult) => {
          if (bleResult.found && bleResult.mainAreaId) {
            bufferedBleResultRef.current = bleResult;
            // يتم تخزين النتيجة بصمت، وتفعيلها يُدار حصراً بمؤقت الـ 4 ثوانٍ أو عند ضعف دقة الـ GPS
          }
        }).catch((err) => {
          console.warn("BLE standby scan error:", err);
        });
      }

      const watchId = navigator.geolocation.watchPosition(
        async (position) => {
          if (!position) return;

          const mocked = await checkMockLocation({
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude,
            altitudeAccuracy: position.coords.altitudeAccuracy,
            speed: position.coords.speed,
          });
          setIsMockLocation(mocked);
          if (mocked) {
            setIsInside(false);
            setAreaName(null);
            setMainAreaId(null);
            setSubAreaId(null);
            setLocationStatus("أطفئ الموقع الوهمي");
            return;
          }

          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          const accuracy = position.coords.accuracy;

          if (accuracy > 150) {
            // دقة ضعيفة للـ GPS -> نفحص هل لدينا بديل بلوتوث جاهز فوراً؟
            if (!activateBleFallback()) {
              if (attendanceTypeRef.current !== 'bluetooth') {
                setLocationStatus(`جاري تحديد الموقع (الدقة ${Math.round(accuracy)} متر)...`);
                setIsInside(false);
              }
            }
            return;
          }

          // نجح استقبال إحداثيات دقيقة -> مسح تحذيرات الموقع
          setLocationPermissionWarning(null);

          // 🛡️ فلتر منع التذبذب البسيط (Micro-jitter Smoothing)
          if (lastLocRef.current) {
            const dist = calculateDistance(lastLocRef.current.latitude, lastLocRef.current.longitude, lat, lng);
            if (dist < 3.0 && accuracy >= (lastAccRef.current || 999) - 2) {
              return; // يتجاهل التغيرات الطفيفة جداً لمنع القفز والتذبذب على الواجهة
            }
          }
          lastLocRef.current = { latitude: lat, longitude: lng };
          lastAccRef.current = accuracy;
          setCurrentLocation({ latitude: lat, longitude: lng });

          try {
            let areas = cachedLocationAreasRef.current;
            if (areas.length === 0 || Date.now() - lastLocationFetchRef.current > 60000) {
              if (isOfflineMode) {
                // وضع أوفلاين: نستخدم المناطق المخزّنة بدلاً من Firebase
                const cached = await getCachedWorkAreas();
                if (cached && cached.areas && cached.areas.length > 0) {
                  setCachedLocationAreas(cached.areas);
                  cachedLocationAreasRef.current = cached.areas;
                  lastLocationFetchRef.current = Date.now();
                  setLastLocationFetch(Date.now());
                  areas = cached.areas;
                }
                // إذا لم توجد بيانات مخزّنة → نكمل بدون مناطق (ستظهر رسالة "خارج المنطقة")
              } else {
                addBreadcrumb("Fetching workAreas from Memory or Firebase");
                const memAreas = edgeBootstrapService.getMemoryWorkAreas();
                let snap: any = memAreas.exists() ? memAreas : null;
                if (!snap && ENABLE_FIREBASE_FALLBACK) {
                  await ensureAuthenticated();
                  snap = await get(ref(db, "workAreas")).catch(() => null);
                }
                const data: any[] = [];
                if (snap && snap.exists()) {
                  const val = snap.val();
                  Object.keys(val).forEach(key => {
                    if (key !== 'hide') data.push({ ...val[key], id: key });
                  });
                }
                setCachedLocationAreas(data);
                cachedLocationAreasRef.current = data;
                lastLocationFetchRef.current = Date.now();
                setLastLocationFetch(Date.now());
                areas = data;
                // ✅ حفظ المناطق للاستخدام أوفلاين لاحقاً
                cacheWorkAreas(data);
              }
            }

            let foundArea: any = null;
            let foundMainName: string | null = null;
            let mId: string | null = null;
            let sId: string | null = null;

            areas.forEach((mainArea) => {
              if (foundArea) return;
              if (mainArea.subLocations && Array.isArray(mainArea.subLocations)) {
                mainArea.subLocations.forEach((subLoc: any) => {
                  if (foundArea) return;
                  const fallbackAcc = Number(appSettingsState?.defaultGpsAccuracy || 150);
                  const maxAcc = Number(subLoc.maxAccuracy || subLoc.allowedAccuracy || mainArea.maxAccuracy || mainArea.allowedAccuracy || fallbackAcc);
                  if (accuracy > maxAcc) return;

                  let inside = false;
                  if (subLoc.type === 'polygon' || subLoc.points) {
                    if (subLoc.points && isPointInPolygon({ lat, lng }, subLoc.points)) inside = true;
                  } else if (subLoc.type === 'circle') {
                    const targetLat = Number(subLoc.lat ?? (subLoc.center && subLoc.center.lat));
                    const targetLng = Number(subLoc.lng ?? (subLoc.center && subLoc.center.lng));
                    if (!isNaN(targetLat) && !isNaN(targetLng)) {
                      const dist = calculateDistance(lat, lng, targetLat, targetLng);
                      if (dist <= Number(subLoc.radius || 100)) inside = true;
                    }
                  }

                  if (inside) {
                    foundArea = subLoc;
                    foundMainName = mainArea.name;
                    mId = mainArea.id;
                    sId = subLoc.id;
                  }
                });
              }
            });

            if (foundArea) {
              if (bleFallbackTimerRef.current) clearTimeout(bleFallbackTimerRef.current);
              attendanceTypeRef.current = 'location';
              isInsideRef.current = true;
              setAreaName(foundMainName);
              setMainAreaId(mId);
              setSubAreaId(sId);
              setIsInside(true);
              setAttendanceType('location');
              setCurrentLocation({ latitude: lat, longitude: lng });
              setLocationStatus(`الموقع الحالي: ${foundMainName}`);
            } else {
              // إذا كان الـ GPS خارج النطاق أو ضعيفاً، نفعّل البلوتوث الاحتياطي إن توفر
              if (!activateBleFallback() && attendanceTypeRef.current !== 'bluetooth') {
                setAreaName(null);
                setMainAreaId(null);
                setSubAreaId(null);
                setIsInside(false);
                setLocationStatus("أنت خارج نطاق العمل");
              }
            }
          } catch (e) {
            console.error(e);
          }
        },
        (err) => {
          console.error("Watch callback error:", err);
          const errMsg = (err?.message || '').toLowerCase();
          if (errMsg.includes("location services are not enabled") || errMsg.includes("network and location turned off")) {
            setLocationPermissionWarning('location_disabled');
            setLocationStatus("يرجى تفعيل الموقع في الهاتف");
          } else if (errMsg.includes("could not obtain location in time") || err.code === 3) {
            if (retryCount < 3) {
              setLocationStatus("جاري تحسين إشارة الـ GPS...");
              setTimeout(() => {
                startLocationTracking(retryCount + 1);
              }, 2000);
              return;
            }
            setLocationPermissionWarning('location_disabled');
            setLocationStatus("تعذر تحديد الموقع");
          } else if (errMsg.includes("denied") || errMsg.includes("user denied geolocation") || err.code === 1) {
            setLocationPermissionWarning('precise_location_disabled');
            setLocationStatus("الموقع الدقيق مطلوب");
          } else {
            setLocationStatus("جاري تحديد الموقع ...");
          }
          if (attendanceTypeRef.current !== 'bluetooth') {
            setIsInside(false);
          }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
      watchIdRef.current = String(watchId);
    } catch (error: any) {
      console.error("Watch start error:", error);
      const errMsg = (error?.message || error?.errorMessage || '').toLowerCase();
      if (errMsg.includes("location services are not enabled") || errMsg.includes("network and location turned off")) {
        setLocationPermissionWarning('location_disabled');
        setLocationStatus("يرجى تفعيل الموقع في الهاتف");
      } else if (errMsg.includes("denied") || errMsg.includes("user denied geolocation")) {
        setLocationPermissionWarning('location_disabled');
        setLocationStatus("تم رفض الوصول للموقع");
      } else if (errMsg.includes("permission")) {
        setLocationPermissionWarning('precise_location_disabled');
        setLocationStatus("يرجى السماح للتطبيق بالوصول للموقع");
      } else {
        setLocationPermissionWarning('location_disabled');
        setLocationStatus("يرجى تفعيل خدمات الموقع بالهاتف");
      }
      setIsInside(false);
    }
  };

  useEffect(() => {
    bleAttendanceService.onBroadcastStarted = () => setIsBleBroadcastingActive(true);
    bleAttendanceService.onBroadcastStopped = () => setIsBleBroadcastingActive(false);

    bleAttendanceService.isBleEnabled().then((enabled) => {
      if (enabled && bleAttendanceService.isBroadcastActive) {
        setIsBleBroadcastingActive(true);
      } else {
        setIsBleBroadcastingActive(false);
        bleAttendanceService.stopBroadcasting();
      }
    }).catch(() => {
      setIsBleBroadcastingActive(false);
    });

    checkAllHardwarePermissions();

    // مستمع لعودة التطبيق إلى الواجهة لإعادة فحص الموقع والأجهزة المجاورة فوراً مع كابح زمني
    let appStateListener: any = null;
    let lastAppStateCheck = 0;
    if (Capacitor.isNativePlatform()) {
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          const now = Date.now();
          if (now - lastAppStateCheck > 2000) {
            lastAppStateCheck = now;
            checkAllHardwarePermissions();
            startLocationTracking();
          }
        }
      }).then(l => { appStateListener = l; });
    }

    getNativeApkVersion().then(v => {
      setNativeApkVersion(v);
      if (Capacitor.isNativePlatform()) {
        const parts = v.split('.').map(Number);
        if (parts[0] > 1 || (parts[0] === 1 && parts[1] > 0) || (parts[0] === 1 && parts[1] === 0 && (parts[2] || 0) >= 62)) {
          bleAttendanceService.initialize(false).catch(() => {});
        }
      }
    });

    return () => {
      if (appStateListener) {
        appStateListener.remove();
      }
    };
  }, []);

  const isBleSupportedOnApk = useMemo(() => {
    if (!Capacitor.isNativePlatform()) return false; // مخفي كلياً في الويب
    if (!nativeApkVersion || nativeApkVersion === 'web') return false;
    const parts = nativeApkVersion.split('.').map(Number);
    if (parts[0] > 1) return true;
    if (parts[0] === 1 && parts[1] > 0) return true;
    if (parts[0] === 1 && parts[1] === 0 && (parts[2] || 0) >= 62) return true;
    return false;
  }, [nativeApkVersion]);

  const handleManualBleBroadcast = async () => {
    if (isVerifyingGpsForBle) return;
    hapticImpact();

    // 🛑 إذا كان البث يعمل بالفعل -> إيقاف البث فوراً
    if (isBleBroadcastingActive) {
      await bleAttendanceService.stopBroadcasting();
      setIsBleBroadcastingActive(false);
      showToast(t("تم إيقاف بث الحضور بالبلوتوث 🛑"), "info");
      return;
    }

    const nowMs = getRealDate().getTime();
    let diffMinutes = 999;

    if (attendanceTimestamp) {
      diffMinutes = (nowMs - attendanceTimestamp) / 60000;
    } else if (attendanceTime && attendanceTime.includes(':')) {
      const [h, m] = attendanceTime.split(':').map(Number);
      const todayDate = getRealDate();
      const attDate = new Date(todayDate);
      attDate.setHours(h, m, 0, 0);
      diffMinutes = (todayDate.getTime() - attDate.getTime()) / 60000;
    }

    // 🛡️ فحص نوع التسجيل: إذا كان الموظف مسجلاً بالبلوتوث (خالد)، تُلغى فترة السماح الـ 5 دقائق
    // ويُلزم بالتأكد الفعلي من تواجده بالـ GPS قبل أن يبث لغيره
    const isBluetoothCheckIn = attendanceType === 'bluetooth';
    const minElapsed = isBluetoothCheckIn ? 0 : (appSettingsState?.bleManualBroadcastMinElapsedMinutes ?? 5);

    // ⚡ الحالة 1: فقط إذا كان مسجلاً بالـ GPS المباشر ومضى أقل من 5 دقائق -> بث مباشر وفوري
    if (!isBluetoothCheckIn && diffMinutes < minElapsed) {
      if (mainAreaId) {
        bleAttendanceService.onBroadcastStopped = () => setIsBleBroadcastingActive(false);
        const effectiveCoords = currentLocation || lastLocRef.current;
        const started = await bleAttendanceService.startBroadcastingAttendance(mainAreaId, subAreaId || '', effectiveCoords);
        if (started) {
          setIsBleBroadcastingActive(true);
          hapticNotification();
          showToast(t("تم تفعيل بث الحضور بالبلوتوث بنجاح 📡"), "success");
        } else {
          setIsBleBroadcastingActive(false);
          showToast(t("تعذر بدء البث، يرجى التأكد من تفعيل البلوتوث والأجهزة المجاورة"), "error");
        }
      } else {
        showToast(t("تعذر بدء البث، معرف الموقع غير متوفر"), "error");
      }
      return;
    }

    // 🛡️ الحالة 2: إذا كان مسجلاً بالبلوتوث أو مضت أكثر من 5 دقائق -> التحقق الإجباري من الـ GPS أولاً
    setIsVerifyingGpsForBle(true);
    try {
      showToast(t("جاري التأكد من تواجدك داخل الموقع بالـ GPS قبل البث..."), "info");

      let currentPos: { latitude: number; longitude: number; accuracy: number } | null = null;
      try {
        if (Capacitor.isNativePlatform()) {
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
          currentPos = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
        } else if (navigator.geolocation) {
          const pos = await new Promise<GeolocationPosition>((res, rej) => {
            navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 });
          });
          currentPos = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
        }
      } catch (geoErr) {
        console.error("Manual BLE check GPS error:", geoErr);
      }

      if (!currentPos) {
        showToast(t("تعذر تحديد موقعك الحالي بالـ GPS. تأكد من تفعيل الموقع"), "error");
        setIsVerifyingGpsForBle(false);
        return;
      }

      const { latitude: lat, longitude: lng, accuracy } = currentPos;

      let areas = cachedLocationAreasRef.current;
      if (areas.length === 0) {
        const memAreas = edgeBootstrapService.getMemoryWorkAreas();
        const snap = memAreas.exists() ? memAreas : (ENABLE_FIREBASE_FALLBACK ? await get(ref(db, "workAreas")).catch(() => null) : null);
        if (snap && snap.exists()) {
          const val = snap.val();
          areas = Object.keys(val).filter(k => k !== 'hide').map(k => ({ ...val[k], id: k }));
        }
      }

      let verifiedInside = false;
      let foundMainId = mainAreaId;
      let foundSubId = subAreaId;

      areas.forEach((mainArea: any) => {
        if (verifiedInside) return;
        if (mainArea.subLocations && Array.isArray(mainArea.subLocations)) {
          mainArea.subLocations.forEach((subLoc: any) => {
            if (verifiedInside) return;
            const fallbackAcc = Number(appSettingsState?.defaultGpsAccuracy || 150);
            const maxAcc = Number(subLoc.maxAccuracy || subLoc.allowedAccuracy || mainArea.maxAccuracy || mainArea.allowedAccuracy || fallbackAcc);
            if (accuracy > maxAcc) return;

            let inside = false;
            if (subLoc.type === 'polygon' || subLoc.points) {
              if (subLoc.points && isPointInPolygon({ lat, lng }, subLoc.points)) inside = true;
            } else if (subLoc.type === 'circle') {
              const targetLat = Number(subLoc.lat ?? (subLoc.center && subLoc.center.lat));
              const targetLng = Number(subLoc.lng ?? (subLoc.center && subLoc.center.lng));
              if (!isNaN(targetLat) && !isNaN(targetLng)) {
                const dist = calculateDistance(lat, lng, targetLat, targetLng);
                if (dist <= Number(subLoc.radius || 100)) inside = true;
              }
            }

            if (inside) {
              verifiedInside = true;
              foundMainId = mainArea.id;
              foundSubId = subLoc.id;
            }
          });
        }
      });

      if (!verifiedInside) {
        showToast(t("تنبيه: يجب أن تكون متواجداً داخل نطاق الموقع لتفعيل بث الحضور"), "error");
        setIsVerifyingGpsForBle(false);
        return;
      }

      if (foundMainId) {
        setCurrentLocation({ latitude: lat, longitude: lng });
        bleAttendanceService.onBroadcastStopped = () => setIsBleBroadcastingActive(false);
        const started = await bleAttendanceService.startBroadcastingAttendance(foundMainId, foundSubId || '', { latitude: lat, longitude: lng });
        if (started) {
          setIsBleBroadcastingActive(true);
          hapticNotification();
          showToast(t("تم التحقق من الموقع وتفعيل بث الحضور بالبلوتوث بنجاح 📡"), "success");
        } else {
          setIsBleBroadcastingActive(false);
          showToast(t("تعذر بدء البث، يرجى التأكد من تفعيل البلوتوث والأجهزة المجاورة"), "error");
        }
      }
    } catch (e) {
      console.error("Manual BLE broadcast error:", e);
      showToast(t("حدث خطأ أثناء تفعيل البث"), "error");
    } finally {
      setIsVerifyingGpsForBle(false);
    }
  };

  /** 📡 فحص واستقبال إشارة البلوتوث يدوياً */
  const handleManualBleScan = async () => {
    if (isBleScanning) return;
    hapticImpact();
    setIsBleScanning(true);
    showToast("🔍 جاري البحث عن بث بلوتوث من الأجهزة القريبة (10 ثوانٍ)...", "info");

    try {
      // 1. جلب قائمة المناطق المعروفة لفك التشفير
      let areasForScan = cachedLocationAreasRef.current;
      if (!areasForScan || areasForScan.length === 0) {
        const snap = await get(ref(db, "workAreas")).catch(() => null);
        if (snap && snap.exists()) {
          const val = snap.val();
          areasForScan = Object.keys(val).filter(k => k !== 'hide').map(k => ({ ...val[k], id: k }));
        } else {
          areasForScan = [];
        }
      }

      // 2. مسح البلوتوث الميداني
      const bleResult = await bleAttendanceService.scanForPeerAttendance(10000, areasForScan);

      if (bleResult.found && bleResult.mainAreaId) {
        const matchedArea = areasForScan.find((a: any) => a.id === bleResult.mainAreaId);
        const locName = matchedArea?.name || bleResult.areaName || bleResult.mainAreaId;

        setAreaName(locName);
        setMainAreaId(bleResult.mainAreaId);
        setSubAreaId(bleResult.subAreaId || null);
        if (bleResult.coords) {
          setCurrentLocation(bleResult.coords);
        }
        setIsInside(true);
        setAttendanceType('bluetooth');
        setLocationStatus(`الموقع الحالي: ${locName}  (بلوتوث)`);

        hapticNotification();
        const distStr = bleResult.distanceEstMeters ? `~${bleResult.distanceEstMeters}م` : '';
        const rssiStr = bleResult.rssi ? ` (${bleResult.rssi} dBm)` : '';
        showToast(`✅ تم التقاط إشارة البلوتوث بنجاح!\nالموقع: ${locName} ${distStr}${rssiStr}`, "success");
      } else {
        showToast("⚠️ لم يتم العثور على بث بلوتوث نشط في المحيط.\nتأكد من أن الهاتف الأول في وضع 'جارٍ البث' وأن البلوتوث والموقع مفعّلان في الهاتفين.", "warning");
      }
    } catch (err: any) {
      console.warn("Manual BLE scan error:", err);
      showToast(`خطأ في فحص البلوتوث: ${err?.message || err}`, "error");
    } finally {
      setIsBleScanning(false);
    }
  };

  const handleViewCarDocument = async (type: 'op' | 'ist' | 'fahs' | 'tameen') => {
    const targetMachineId = tempMachineId || user.machine_id;

    if (!targetMachineId || targetMachineId === '---') {
      setNotification({ msg: t("لا توجد معدة مسجلة لهذا الحساب"), type: 'error' });
      setTimeout(() => setNotification(null), 3000);
      return;
    }

    const cloudName = 'FAKE';
    setNotification({ msg: t("جاري التحقق من وجود الملف..."), type: 'info' });

    try {
      const mSnap = await get(ref(db, `قائمة_المعدات/${targetMachineId}`));
      let identifier = targetMachineId;

      if (mSnap.exists()) {
        const mData = mSnap.val();
        identifier = mData.serial || mData.chassis || targetMachineId;
      }

      const finalUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${identifier}_${type}.jpg`;

      const response = await fetch(finalUrl, { method: 'HEAD' });
      if (response.ok) {
        setIsImageLoading(true);
        resetZoom();
        setFullscreenImage(finalUrl);
        setNotification(null);
      } else {
        setNotification({ msg: t("لا يوجد"), type: 'info' });
        setTimeout(() => setNotification(null), 3000);
      }
    } catch (error) {
      console.error("Error checking file:", error);
      setNotification({ msg: t("حدث خطأ أثناء محاولة الوصول للملف"), type: 'error' });
      setTimeout(() => setNotification(null), 3000);
    }
  };

  // --- Zoom Logic ---
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setLastTouch({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      setLastDistance(dist);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && lastTouch && scale > 1) {
      const dx = e.touches[0].clientX - lastTouch.x;
      const dy = e.touches[0].clientY - lastTouch.y;
      setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setLastTouch({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    } else if (e.touches.length === 2 && lastDistance) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const delta = dist / lastDistance;
      setScale(prev => Math.min(Math.max(1, prev * delta), 5));
      setLastDistance(dist);
    }
  };

  const handleTouchEnd = () => {
    setLastTouch(null);
    setLastDistance(null);
  };

  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleViewUserDocument = async (type: 'driver' | 'ajeer') => {
    const cloudName = 'FAKE';
    setNotification({ msg: t("جاري التحقق من وجود الملف..."), type: 'info' });

    try {
      const identifier = user.key; // Using employee ID
      const finalUrl = `https://res.cloudinary.com/${cloudName}/image/upload/${identifier}_${type}.jpg`;

      const response = await fetch(finalUrl, { method: 'HEAD' });
      if (response.ok) {
        setIsImageLoading(true);
        resetZoom();
        setFullscreenImage(finalUrl);
        setNotification(null);
      } else {
        setNotification({ msg: t("لا يوجد"), type: 'info' });
        setTimeout(() => setNotification(null), 3000);
      }
    } catch (error) {
      console.error("Error checking file:", error);
      setNotification({ msg: t("حدث خطأ أثناء محاولة الوصول للملف"), type: 'error' });
      setTimeout(() => setNotification(null), 3000);
    }
  };

  const handleShareImage = async () => {
    if (!fullscreenImage || isSharing) return;
    setIsSharing(true);
    setNotification({ msg: t("جاري تجهيز الصورة للمشاركة..."), type: 'info' });

    try {
      const response = await fetch(fullscreenImage);
      const blob = await response.blob();

      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64WithPrefix = reader.result as string;
        const base64Data = base64WithPrefix.split(',')[1];
        const fileName = `document_${Date.now()}.jpg`;

        try {
          const savedFile = await Filesystem.writeFile({
            path: fileName,
            data: base64Data,
            directory: Directory.Cache
          });

          await Share.share({
            title: t("مشاركة المستند"),
            text: t("مستند من تطبيق انترسيف"),
            files: [savedFile.uri],
          });
          setNotification(null);
        } catch (err) {
          console.error("Share error:", err);
          setNotification({ msg: t("فشل في مشاركة الصورة"), type: 'error' });
          setTimeout(() => setNotification(null), 3000);
        } finally {
          setIsSharing(false);
        }
      };
    } catch (error) {
      console.error("Fetch error:", error);
      setNotification({ msg: t("فشل في تحميل الصورة"), type: 'error' });
      setTimeout(() => setNotification(null), 3000);
      setIsSharing(false);
    }
  };

  const getDisplayAreaName = () => {
    if (areaName && !areaName.startsWith('crc:')) return areaName;
    if (mainAreaId && !mainAreaId.startsWith('crc:')) {
      const areas = cachedLocationAreas.length > 0 ? cachedLocationAreas : cachedLocationAreasRef.current;
      const area = areas.find(a => a.id === mainAreaId);
      if (area?.name) return area.name;
    }

    const targetCrc = areaName && areaName.startsWith('crc:')
      ? parseInt(areaName.replace('crc:', ''), 10)
      : mainAreaId && mainAreaId.startsWith('crc:')
        ? parseInt(mainAreaId.replace('crc:', ''), 10)
        : null;

    if (targetCrc !== null && !isNaN(targetCrc)) {
      const areas = cachedLocationAreas.length > 0 ? cachedLocationAreas : cachedLocationAreasRef.current;
      const crc32Helper = (str: string) => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < str.length; i++) {
          let b = str.charCodeAt(i);
          for (let j = 0; j < 8; j++) { const v = (c ^ b) & 1; c = (c >>> 1) ^ (v ? 0xEDB88320 : 0); b >>>= 1; }
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
      };
      const matched = areas.find(a => a.id && crc32Helper(a.id) === targetCrc);
      if (matched?.name) return matched.name;
    }

    return areaName && !areaName.startsWith('crc:') ? areaName : 'الموقع المحدد';
  };



  const handleAction = (message: string, path?: string) => {
    hapticImpact();
    setNotification({ msg: t(message), type: 'info' });
    setTimeout(() => setNotification(null), 3000);
    if (path) navigate(path);
  };

  const switchTab = (tab: TabType) => {
    hapticSelection();
    if (tab === 'profile' && hasLocationWarning) {
      hapticNotification(NotificationType.Warning);
      const warnMsg = effectiveWarning === 'precise_location_disabled'
        ? t("الموقع الدقيق غير مفعل. يرجى تفعيل إذن الموقع الدقيق لتتمكن من فتح الملف الشخصي")
        : t("خدمات الموقع غير مفعلة. يرجى تفعيل الموقع لتتمكن من فتح الملف الشخصي");
      setNotification({ msg: warnMsg, type: 'warning' });
      return;
    }
    setActiveTab(tab);
    if (tab === 'profile') {
      const userKey = localStorage.getItem("userKey");
      if (userKey && (!dataLoaded || !edgeBootstrapService.hasProfileDetails(selectedMonth))) {
        loadDetailedDataInBackground(userKey, user);
      }
    }
  };

  useEffect(() => {
    if (hasLocationWarning && activeTab === 'profile') {
      setActiveTab(null);
    }
  }, [hasLocationWarning, activeTab]);

  const handleSwitchMachine = async (machineIdOverride?: string, forcePermanent?: boolean) => {
    let machineId = (machineIdOverride || newMachineInput || "").toString().trim();
    const isRemoving = !machineId || machineId === "---" || machineId === "لا يوجد" || machineId === "لا يوجد معدة" || machineId === "بدون معدة";

    const isPermanent = forcePermanent !== undefined ? forcePermanent : isPermanentMachineChange;

    setLoading(true);
    try {
      if (isPermanent) {
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        const changeLogRaw = localStorage.getItem("machine_change_log");
        let changeLog: number[] = changeLogRaw ? JSON.parse(changeLogRaw) : [];
        changeLog = changeLog.filter(ts => ts > oneHourAgo);

        if (changeLog.length >= 2) {
          setNotification({ msg: t("عذراً، لا يمكنك تغيير المعدة أكثر من مرتين في الساعة الواحدة"), type: 'error' });
          setLoading(false);
          setIsSwitchingMachine(false);
          setShowMachineSearch(false);
          setIsPermanentMachineChange(false);
          return;
        }
        
        // تحديث السجل وحفظه
        changeLog.push(now);
        localStorage.setItem("machine_change_log", JSON.stringify(changeLog));

        // 🔄 منطق التراجع الذكي: إرجاع المعدة السابقة لصاحبها إذا تم التغيير خلال نفس الساعة
        const revertInfoRaw = localStorage.getItem("last_withdrawn_revert");
        if (revertInfoRaw) {
          try {
            const revertInfo = JSON.parse(revertInfoRaw);
            // إذا تمت العملية السابقة في أقل من ساعة، نرجع المعدة لصاحبها
            if (now - revertInfo.timestamp < 3600000) {
              await update(ref(db, `قائمة_الموظفين/${revertInfo.ownerKey}`), { machine: revertInfo.machineId });
            }
          } catch (e) { console.error("Revert error:", e); }
          localStorage.removeItem("last_withdrawn_revert");
        }
      }

      const userKey = localStorage.getItem("userKey");
      if (!userKey) {
        setNotification({ msg: t("يرجى تسجيل الدخول"), type: 'error' });
        setLoading(false);
        return;
      }

      if (isRemoving) {
        // حذف المعدة من المستخدم الحالي بـ "لا يوجد معدة"
        const nowTs = Date.now();
        await update(ref(db, `قائمة_الموظفين/${userKey}`), { 
          machine: "لا يوجد معدة",
          machine_updated_at: nowTs
        });
        localStorage.setItem("last_assigned_machine", "NONE");
        setUser(prev => ({
          ...prev,
          machine: "",
          machine_id: ""
        }));
        setNotification({ msg: t("تم إزالة المعدة بنجاح"), type: 'success' });
      } else {
        // تغيير المعدة إلى معدة جديدة
        const mSnap = await get(ref(db, `قائمة_المعدات/${machineId}`));
        if (mSnap.exists()) {
          const mData = mSnap.val();
          const mName = `${mData.type || ""} ${machineId}`.trim();

          if (isPermanent) {
            // 🔍 البحث عن أي موظف آخر لديه نفس المعدة لسحبها منه (منع التداخل)
            try {
              const otherEmpsQuery = query(ref(db, 'قائمة_الموظفين'), orderByChild('machine'), equalTo(machineId));
              const otherEmpsSnap = await get(otherEmpsQuery);
              
              if (otherEmpsSnap.exists()) {
                // ✅ كتابة منفصلة على مسار الموظف مباشرة
                const withdrawPromises: Promise<void>[] = [];
                let lastWithdrawnKey: string | null = null;

                otherEmpsSnap.forEach((child) => {
                  if (child.key && child.key !== userKey) {
                    lastWithdrawnKey = child.key;
                    withdrawPromises.push(
                      update(ref(db, `قائمة_الموظفين/${child.key}`), { 
                        machine: "لا يوجد معدة",
                        machine_updated_at: Date.now()
                      })
                    );
                  }
                });

                if (withdrawPromises.length > 0) {
                  await Promise.all(withdrawPromises);
                  // حفظ بيانات التراجع للمستقبل (آخر موظف سُحبت منه المعدة)
                  if (lastWithdrawnKey) {
                    localStorage.setItem("last_withdrawn_revert", JSON.stringify({
                      ownerKey: lastWithdrawnKey,
                      machineId: machineId,
                      timestamp: Date.now()
                    }));
                  }
                }
              }
            } catch (searchErr) {
              console.warn("Could not clear machine from other employees:", searchErr);
            }

            const nowTs = Date.now();
            await update(ref(db, `قائمة_الموظفين/${userKey}`), { 
              machine: machineId,
              machine_updated_at: nowTs
            });
            await update(ref(db, `قائمة_المعدات/${machineId}`), {
              driver: userKey,
              driver_updated_at: nowTs
            });
            localStorage.setItem("last_assigned_machine", machineId);
            // تحديث الحالة المحلية بالاسم الكامل والمعرف لضمان عمل المستندات والواجهة فوراً
            setUser(prev => ({ 
              ...prev, 
              machine: mName,
              machine_id: machineId 
            }));
          } else {
            setTempMachineId(machineId);
            setTempMachineName(mName);
            setNotification({ msg: t("تم تبديل المعدة مؤقتاً لعرض المستندات"), type: 'success' });
          }
        } else {
          setNotification({ msg: t("المعدة غير موجودة"), type: 'error' });
        }
      }
    } catch (e) {
      console.error("Switch machine error:", e);
      setNotification({ msg: t("حدث خطأ أثناء البحث عن المعدة"), type: 'error' });
    } finally {
      setLoading(false);
      setIsSwitchingMachine(false);
      setShowMachineSearch(false);
      setIsPermanentMachineChange(false);
      setNewMachineInput("");
      setTimeout(() => setNotification(null), 3000);
    }
  };

  const fetchAllMachines = async () => {
    if (allMachines.length > 0) return;
    setIsMachinesLoading(true);
    try {
      // 1. فحص ذاكرة الووركر الفائقة أو الكاش المحلي (0ms)
      const memMachines = edgeBootstrapService.getMemoryMachinesList();
      if (memMachines && Array.isArray(memMachines) && memMachines.length > 0) {
        const normalized = memMachines.map((m: any) => {
          if (Array.isArray(m)) {
            return {
              id: m[0] || '',
              name: m[1] || m[0] || '',
              label: m[1] || m[0] || '',
              type: '',
              costCenter: m[0] || '',
              plate: m[2] || '',
              driver: m[3] || ''
            };
          }
          return m;
        });
        setAllMachines(normalized);
        setIsMachinesLoading(false);
        return;
      }

      // 2. إذا كنا في وضع الووركر الحصري أو رغبنا بجلبه عبر الووركر
      if (!ENABLE_FIREBASE_FALLBACK) {
        const edgeList = await edgeBootstrapService.fetchMachines();
        if (edgeList && Array.isArray(edgeList) && edgeList.length > 0) {
          const normalized = edgeList.map((m: any) => {
            if (Array.isArray(m)) {
              return {
                id: m[0] || '',
                name: m[1] || m[0] || '',
                label: m[1] || m[0] || '',
                type: '',
                costCenter: m[0] || '',
                plate: m[2] || '',
                driver: m[3] || ''
              };
            }
            return m;
          });
          setAllMachines(normalized);
          setIsMachinesLoading(false);
          return;
        }
      }

      // 3. الصمام التراجعي لقاعدة بيانات فايربيس
      if (ENABLE_FIREBASE_FALLBACK && db) {
        const snapshot = await get(ref(db, 'قائمة_المعدات'));
        if (snapshot.exists()) {
          const data = snapshot.val();
          const list = Object.keys(data)
            .filter(key => key.trim() !== '---' && (data[key].costCenter || '').trim() !== '---')
            .map(key => ({
              id: key,
              name: `${data[key].type || ""} ${key}`.trim(),
              label: `${data[key].type || ""} ${key}`.trim(),
              type: data[key].type || "",
              costCenter: data[key].costCenter || key,
              plate: data[key].plate || data[key].plateNumber || data[key].serial || "",
              driver: data[key].driver || ""
            }));
          setAllMachines(list);
          try {
            localStorage.setItem('cached_all_machines', JSON.stringify(list));
          } catch {}
        }
      }
    } catch (e) {
      console.error("Error fetching machines:", e);
    } finally {
      setIsMachinesLoading(false);
    }
  };

  if (loading) return <UnifiedLoader variant="fullscreen" />;

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-6" dir="rtl">
        <div className="bg-white p-8 rounded-2xl shadow-xl text-center max-w-sm w-full border-t-4 border-amber-500">
          <AlertCircle className="w-12 h-12 text-amber-600 mx-auto mb-4" />
          <p className="text-gray-700 font-bold mb-4 whitespace-pre-wrap">{loadError}</p>
          <button
            onClick={async () => {
              setLoadError(null);
              await syncStorageFromPreferences();
              loadUserData();
            }}
            className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold flex items-center justify-center gap-2"
          >
            <RefreshCw size={18} /> {t("إعادة المحاولة")}
          </button>
        </div>
      </div>
    );
  }

  if (loading && !user.key) {
    return <UnifiedLoader variant="fullscreen" />;
  }

  if (systemClosed || userBlocked) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-6" dir="rtl">
        <div className="bg-white p-8 rounded-2xl shadow-xl text-center max-w-sm w-full border-t-4 border-red-500">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="w-8 h-8 text-red-600" />
          </div>
          <p className="text-gray-700 text-lg font-bold leading-relaxed whitespace-pre-line mb-4 px-2">
            {blockMessage}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 w-full py-2 bg-gray-800 text-white rounded-xl font-bold flex items-center justify-center gap-2"
          >
            <RefreshCw size={18} />
            {t("تحديث الحالة")}
          </button>
        </div>
      </div>
    );
  }
  // الحسابات تتم داخل AttendanceButton - نستخدم computeAttendanceState للاستخدامات الأخرى في الصفحة
  const { isFriday: isFridayForCheck, isTerminated: isTerminatedForCheck, isRegistered: isRegisteredForCheck } = computeAttendanceState(
    user, defaultUser.name_ar, attendanceTime, isInside, isMarkedAbsent,
    lockAttendance
  );

  return (
    <>
      <div
        ref={scrollRef}
        className="h-full w-full max-w-4xl mx-auto px-4 pb-safe-lg flex flex-col relative z-10 overflow-y-auto no-scrollbar scroll-smooth"
      >
        {/* Sticky Header Section - Profile Card, Attendance Button, and Tabs */}
        <div className="sticky top-0 z-60 -mx-4 px-4 pt-4 pb-2 space-y-3 bg-primary shadow-lg shadow-blue-500/10 border-b border-blue-400/20 transition-all duration-300">
          {backgroundSyncStatus === 'offline' && (
            <div className="flex items-center justify-center gap-1.5 py-1 px-3 bg-amber-500/20 border border-amber-400/30 rounded-full text-amber-200 text-xs font-medium w-fit mx-auto animate-fade-in shadow-sm">
              <WifiOff size={13} className="text-amber-400 shrink-0" />
              <span>{t("عرض البيانات المحفوظة محلياً (غير متصل)")}</span>
            </div>
          )}
          {/* 🔴 [TEST_MODE_WORKER_ONLY] إشعار مرئي مؤقت يؤكد أن البيانات قادمة من الووركر وأن الـ Fallback معطل */}
          {!ENABLE_FIREBASE_FALLBACK && (
            <div className="flex items-center justify-center gap-1.5 py-1 px-3 bg-emerald-500/20 border border-emerald-400/30 rounded-full text-emerald-100 text-[11px] font-black w-fit mx-auto animate-fade-in shadow-sm">
              <span>⚡ وضع التجربة: بيانات Cloudflare Worker نشطة (الـ Fallback معطل)</span>
            </div>
          )}
          <ProfileCard user={user} />

          {!lockAttendance && (
            <div className="w-full max-w-2xl mx-auto">
              <div className="relative">
                <AttendanceButton
                  user={user}
                  defaultUserName={defaultUser.name_ar}
                  attendanceTime={attendanceTime}
                  isInside={isInside}
                  isMarkedAbsent={isMarkedAbsent}
                  isMockLocation={isMockLocation}
                  lockAttendance={lockAttendance}
                  locationStatus={locationStatus}
                  displayAreaName={getDisplayAreaName()}
                  areaName={areaName}
                  mainAreaId={mainAreaId}
                  subAreaId={subAreaId}
                  cachedLocationAreas={cachedLocationAreas}
                  watchIdRef={watchIdRef}
                  isOfflineMode={isOfflineMode}
                  currentLocation={currentLocation}
                  attendanceType={attendanceType}
                  onSuccess={(time) => {
                    setAttendanceTime(time);
                    setAttendanceTimestamp(Date.now());
                    const nowLocal = getRealDate();
                    const todayStr = getRiyadhDateStr(nowLocal);
                    localStorage.setItem(`cached_attendance_${todayStr}_${user.key}`, JSON.stringify({status: 'present', time, area: areaName, attendanceType}));
                    if (isBleSupportedOnApk && attendanceType === 'location') {
                      if (bleAttendanceService.isBroadcastActive) {
                        setIsBleBroadcastingActive(true);
                      }
                    }
                  }}
                  onNotify={(msg, type) => {
                    setNotification({ msg, type });
                    setTimeout(() => setNotification(null), 4000);
                  }}
                />

                {!isTerminatedForCheck && (
                  <div className="absolute left-2.5 top-1/2 -translate-y-1/2 flex flex-col gap-1 z-20 pointer-events-auto">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMapModal(true);
                        startLocationTracking();
                      }}
                      className="px-2 py-1 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-all backdrop-blur-sm border bg-white/95 hover:bg-white border-green-200 text-green-700 shadow-xs cursor-pointer"
                      title={t("الخريطة")}
                    >
                      <MapPin className="w-3 h-3 shrink-0" />
                      <span>{t("الخريطة")}</span>
                    </button>

                    {/* 📡 زر بث الحضور بالبلوتوث - يظهر فقط لإصدار APK 1.0.62 فما فوق بعد تسجيل الحضور */}
                    {isRegisteredForCheck && isBleSupportedOnApk && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleManualBleBroadcast();
                        }}
                        disabled={isVerifyingGpsForBle}
                        className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center justify-center gap-1 transition-all backdrop-blur-sm border shadow-xs cursor-pointer ${
                          isBleBroadcastingActive
                            ? 'bg-blue-600 text-white border-blue-500 animate-pulse'
                            : 'bg-white/95 hover:bg-white border-blue-200 text-blue-700'
                        }`}
                        title={t("بث الحضور")}
                      >
                        {isVerifyingGpsForBle ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-blue-600 shrink-0" />
                            <span>{t("فحص...")}</span>
                          </>
                        ) : isBleBroadcastingActive ? (
                          <>
                            <Bluetooth className="w-3 h-3 text-white shrink-0" />
                            <span>{t("جاري البث")}</span>
                          </>
                        ) : (
                          <>
                            <Bluetooth className="w-3 h-3 text-blue-600 shrink-0" />
                            <span>{t("بث الحضور")}</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ⚠️ شريط التحذيرات الفوري أسفل زر الحضور مباشرة */}
              {effectiveWarning && !isTerminatedForCheck && (
                <div
                  onClick={async () => {
                    if (effectiveWarning === 'location_services_disabled') {
                      startLocationTracking();
                    } else if (effectiveWarning === 'location_permission_denied' || effectiveWarning === 'precise_location_disabled') {
                      if (Capacitor.isNativePlatform()) {
                        try {
                          const req = await Geolocation.requestPermissions();
                          if (req.location === 'granted') {
                            setLocationPermissionWarning(null);
                          }
                        } catch {}
                      }
                      startLocationTracking();
                    } else if (effectiveWarning === 'bluetooth_turned_off') {
                      await bleAttendanceService.requestEnable();
                      await checkAllHardwarePermissions();
                    } else if (effectiveWarning === 'nearby_devices_disabled') {
                      await bleAttendanceService.requestPermissions();
                      await checkAllHardwarePermissions();
                    }
                  }}
                  className="w-full flex items-center justify-center mt-2 px-4 py-2.5 rounded-2xl shadow-xs animate-fade-in select-none cursor-pointer transition-all active:scale-98 border bg-rose-50/95 border-rose-200 text-rose-900"
                  title={t("اضغط لإعادة المحاولة والتفعيل")}
                >
                  <p className="text-xs font-black leading-snug text-center">
                    {effectiveWarning === 'location_services_disabled' && t("يتطلب تشغيل الموقع (GPS)")}
                    {effectiveWarning === 'location_permission_denied' && t("يتطلب إذن الموقع (GPS)")}
                    {effectiveWarning === 'precise_location_disabled' && t("يتطلب الموقع الدقيق (GPS)")}
                    {effectiveWarning === 'bluetooth_turned_off' && t("يتطلب تشغيل البلوتوث (Bluetooth)")}
                    {effectiveWarning === 'nearby_devices_disabled' && t("يتطلب إذن الأجهزة المجاورة (Bluetooth)")}
                  </p>
                </div>
              )}
            </div>
          )}

          <AppUpdateBanner
            jobTitle={user.job_title}
            onStateChange={(hasUpd, lockAtt) => {
              setHasUpdate(hasUpd);
              setLockAttendance(lockAtt);
            }}
          />

          {!hasUpdate && (
            <div className="w-full max-w-2xl mx-auto bg-white/10 backdrop-blur-md p-1.5 rounded-2xl flex gap-2 border border-white/20 shrink-0 shadow-lg mb-2">
              <TabButton
                label={t("ملفي")}
                isActive={activeTab === 'profile'}
                onClick={() => switchTab('profile')}
                Icon={User}
                notificationColor={loansDiff > 0 ? 'red' : loansDiff < 0 ? 'green' : null}
                badgeText={loansDiff !== 0 ? `${loansDiff > 0 ? '+' : ''}${loansDiff}` : undefined}
              />
              {isSupervisor(user.job_title) && !isTerminatedForCheck && user.status?.trim() !== 'خارج العمل' && (
                <TabButton
                  label={t("المهام")}
                  isActive={activeTab === 'tasks'}
                  onClick={() => switchTab('tasks')}
                  Icon={LayoutDashboard}
                />
              )}
              {!hideMachineTab && (
                <TabButton
                  label={t("المعدة")}
                  isActive={activeTab === 'car'}
                  onClick={() => switchTab('car')}
                  Icon={Truck}
                />
              )}
            </div>
          )}

          {/* Floating Back to Top button - appears under tabs after scrolling */}
          {showScrollTop === true && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-3 z-70 animate-bounce">
              <button
                onClick={scrollToTop}
                className="w-7 h-7 bg-white shadow-xl rounded-full text-primary flex items-center justify-center border border-blue-50 active:scale-90 transition-all"
                title={t("للأعلى")}
              >
                <ArrowUp size={14} strokeWidth={4} />
              </button>
            </div>
          )}
        </div>

        <div className="w-full max-w-2xl mx-auto flex-1 pb-10">
          {activeTab === null && !isFridayForCheck && !isTerminatedForCheck && (
            <div className="w-full max-w-sm mx-auto space-y-2 mb-3">
              <div className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-50/90 border border-blue-200/80 text-blue-900 rounded-2xl shadow-xs animate-fade-in select-none">
                <AlertCircle size={15} className="text-blue-600 shrink-0" />
                <p className="text-xs font-extrabold text-blue-900 leading-snug text-center">
                  {t("تسجيل الحضور الحالي معتمد رسمياً في كشف الرواتب")}
                </p>
              </div>

              <div className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-50/90 border border-blue-200/80 text-blue-900 rounded-2xl shadow-xs animate-fade-in select-none">
                <span className="text-sm shrink-0">💡</span>
                <p className="text-xs font-extrabold text-blue-900 leading-snug text-center">
                  {t("ضعف إشارة الـ GPS؟ يمكنك استلام إشارة التحضير من زميلك عبر البلوتوث.")}
                </p>
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="animate-fade-in space-y-4">
              <div className="relative">
                <AccrualCalendar
                  selectedMonth={selectedMonth}
                  onMonthChange={handleMonthChange}
                  userStartDate={user.start_date}
                  accrualPeriod={accrualPeriod}
                  absenceCount={absenceCount}
                  calendarDays={calendarDays}
                  calendarError={calendarError}
                  isCalendarLoading={isCalendarLoading}
                  onMachineAction={showMachineSetting ? () => {
                    setInitModalReason('weekly_recommendation');
                    setShowInitMachineModal(true);
                    fetchAllMachines();
                  } : undefined}
                  currentMachine={user.machine}
                />

                {showMachineSearch && isPermanentMachineChange && (
                  <div className="absolute top-2 inset-x-2 z-100 animate-in zoom-in-95 duration-300">
                    <div className="bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-blue-100 p-4 space-y-3 overflow-hidden relative">
                      {/* لمسة فنية خلفية */}
                      <div className="absolute -top-6 -right-6 w-16 h-16 bg-blue-50 rounded-full opacity-40 blur-xl" />
                      
                      <div className="flex items-center justify-between relative z-10">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
                            <Truck size={16} />
                          </div>
                          <span className="text-xs font-black text-slate-800">{t("تغيير المعدة")}</span>
                        </div>
                        <button onClick={() => { setShowMachineSearch(false); setIsPermanentMachineChange(false); }} className="p-1 hover:bg-gray-100 rounded-full transition-colors text-gray-400">
                          <X size={16} />
                        </button>
                      </div>

                      <div className="relative z-10">
                        <input
                          type="text"
                          value={newMachineInput}
                          onChange={(e) => setNewMachineInput(e.target.value)}
                          placeholder={t("رقم المعدة...")}
                          className="w-full bg-blue-50/50 border border-blue-100 rounded-xl px-4 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500 outline-none transition-all placeholder:text-blue-300"
                        />
                        {isMachinesLoading && <Loader2 size={12} className="absolute left-3 top-2.5 animate-spin text-blue-500" />}
                      </div>

                      {newMachineInput.trim() !== "" && (
                        <div className="max-h-40 overflow-y-auto no-scrollbar rounded-xl border border-blue-50 bg-white/50 z-10 relative">
                          {allMachines
                            .filter(m => m.id.toLowerCase().includes(newMachineInput.toLowerCase()) || m.name.toLowerCase().includes(newMachineInput.toLowerCase()))
                            .slice(0, 8)
                            .map((m) => (
                              <button
                                key={m.id}
                                onClick={() => {
                                  handleSwitchMachine(m.id);
                                }}
                                className="w-full text-right px-4 py-2.5 text-[11px] font-black hover:bg-blue-50 border-b border-gray-50 last:border-0 flex items-center justify-between group"
                              >
                                <span className="text-slate-700 group-hover:text-blue-700 transition-colors">{m.name}</span>
                                <span className="text-[9px] text-blue-600 bg-blue-100/50 px-1.5 py-0.5 rounded-md">{m.id}</span>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-white/90 backdrop-blur rounded-2xl p-4 shadow-lg border border-white/40 space-y-4">
                {/* زر السلف - تصميم موحد */}
                  <button
                    onClick={() => {
                      if (loansDiff !== 0 && loansBalance !== null) {
                        localStorage.setItem(`last_loans_balance_${user.key}`, loansBalance.toString());
                        setLoansDiff(0);
                      }
                      handleAction('لحظات من فضلك...', '/advances');
                    }}
                    className={`relative w-full py-2.5 px-3 rounded-xl flex items-center justify-between bg-white border shadow-sm transition-all duration-300 ease-out active:scale-[0.98] group overflow-hidden
                      ${loansDiff !== 0 ? 'border-red-500 animate-pulse-border' : 'border-gray-100'}
                    `}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center group-hover:scale-105 transition-transform duration-300 shrink-0">
                        <Wallet className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex flex-col text-right">
                        <span className="text-sm font-bold text-slate-700 z-10">{t("السلف")}</span>
                        <span className="text-[10px] text-gray-400 font-medium z-10">{t("(سلف - مخالفات ..الخ)")}</span>
                      </div>
                    </div>
                    <div className={`text-sm font-black z-10 flex items-center gap-1.5`}>
                      {loansBalance !== null ? (
                        <>
                          {loansDiff !== 0 && (
                            <span className={`text-[11px] font-black animate-pulse ${loansDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {loansDiff > 0 ? '+' : ''}{loansDiff}
                            </span>
                          )}
                          <span className={loansDiff !== 0 ? 'text-slate-800' : 'text-primary'}>
                            {loansBalance} {t("ريال")}
                          </span>
                        </>
                      ) : (
                        <Loader2 size={14} className="animate-spin opacity-30" />
                      )}
                    </div>
                  </button>

                {/* زر كرت الدوام - تصميم موحد */}
                <div className="relative w-full py-2.5 px-3 rounded-xl flex items-center justify-between bg-white border border-gray-100 shadow-sm transition-all duration-300 ease-out active:scale-[0.98] group overflow-hidden">
                  <button
                    onClick={() => handleAction('لحظات من فضلك...', '/timecard')}
                    className="flex items-center gap-2.5 flex-1 text-right"
                  >
                    <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center group-hover:scale-105 transition-transform duration-300 shrink-0">
                      <CalendarClock className="w-4 h-4 text-primary" />
                    </div>
                    <span className="text-sm font-bold text-slate-700 z-10">{t("كرت الدوام والاضافي")}</span>
                  </button>

                  <div className="flex items-center gap-2 z-10">
                    {timecardStats ? (
                      <div className="flex flex-col items-end border-r border-gray-100 pr-2 leading-tight">
                        <span className="text-[10px] text-gray-500 font-bold">{t("دوام:")} {timecardStats.duty}س</span>
                        <span className="text-[11px] text-emerald-600 font-black">{t("إضافي:")} {timecardStats.extra}س</span>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const userKey = localStorage.getItem("userKey");
                          if (userKey) fetchTimecardStats(userKey);
                        }}
                        disabled={fetchingTimecard}
                        className="px-3 py-1.5 bg-primary text-white rounded-lg transition-all shadow-sm active:scale-95 disabled:opacity-50 text-[10px] font-black"
                      >
                        {fetchingTimecard ? <Loader2 size={12} className="animate-spin" /> : t("استعلام")}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <ActionButton
                    label={t("بطاقة سائق")}
                    Icon={IdCard}
                    onClick={() => handleViewUserDocument('driver')}
                  />
                  <ActionButton
                    label={t("تصريح أجير")}
                    Icon={UserCheck}
                    onClick={() => handleViewUserDocument('ajeer')}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'tasks' && isSupervisor(user.job_title) && !isTerminatedForCheck && user.status?.trim() !== 'خارج العمل' && (
            <div className="animate-fade-in space-y-4">
              {/* بطاقة إحصائيات وظائف الموقع المصرح للمستخدم */}
              {(!userTaskPermissions || userTaskPermissions.job_stats !== false) && (
                <JobStatsCard userKey={user.key} />
              )}

              <div className="bg-white/90 backdrop-blur rounded-2xl p-4 shadow-lg border border-white/40 space-y-4">
                <div className="grid gap-2">
                  {(!userTaskPermissions || userTaskPermissions.attendance_report !== false) && (
                    <ActionButton
                      label={t("تقرير الحضور")}
                      Icon={FileBarChart}
                      onClick={() => handleAction('لحظات من فضلك...', '/attendance-report')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.terminate_employee !== false) && (
                    <ActionButton
                      label={t("توقيف موظف")}
                      Icon={CalendarX}
                      onClick={() => handleAction('لحظات من فضلك...', '/terminate-employee')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.add_employee !== false) && (
                    <ActionButton
                      label={t("إضافة موظف جديد")}
                      Icon={UserPlus}
                      onClick={() => handleAction('لحظات من فضلك...', '/add-employee')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.attendance_entry !== false) && (
                    <ActionButton
                      label={t("ادخال دوام المعدات والموظفين")}
                      Icon={Settings}
                      onClick={() => handleAction('لحظات من فضلك...', '/attendance')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.employee_account !== false) && (
                    <ActionButton
                      label={t("حساب موظف")}
                      Icon={LayoutDashboard}
                      onClick={() => handleAction('لحظات من فضلك...', '/select-employee?mode=account')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.timecard !== false) && (
                    <ActionButton
                      label={t("كرت دوام موظف")}
                      Icon={FileBarChart}
                      onClick={() => handleAction('لحظات من فضلك...', '/select-employee')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.update_employee !== false) && (
                    <ActionButton
                      label={t("تحديث بيانات الموظف")}
                      Icon={RefreshCw}
                      onClick={() => handleAction('لحظات من فضلك...', '/update-employee-data')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.add_actual_user !== false) && (
                    <ActionButton
                      label={t("إضافة مستخدم فعلي")}
                      Icon={ShieldCheck}
                      onClick={() => handleAction('لحظات من فضلك...', '/add-actual-user')}
                    />
                  )}

                  {(!userTaskPermissions || userTaskPermissions.activity_log !== false) && (
                    <ActionButton
                      label={t("سجل العمليات")}
                      Icon={History}
                      onClick={() => handleAction('جارٍ فتح سجل العمليات...', '/activity')}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'car' && (
            <div className="animate-fade-in grid gap-3">
              <div className="bg-white/90 backdrop-blur rounded-2xl p-4 shadow-lg border border-white/40 space-y-4">
                <div className="flex flex-col gap-3 mb-2 border-b border-gray-100 pb-3">
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 rounded-lg text-blue-600">
                        <Truck size={20} />
                      </div>
                      <h3 className="font-black text-gray-800 flex items-center gap-2">
                        <span className="shrink-0">{t("بيانات المعدة")}</span>
                        <div className="flex items-center gap-2 overflow-hidden">
                          <span className={`text-sm font-black px-3 py-1 rounded-full border shadow-sm truncate ${ (tempMachineName || user.machine) !== '---' ? 'text-blue-700 bg-blue-50 border-blue-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
                            {tempMachineName || user.machine !== '---' ? (tempMachineName || user.machine) : t("لا توجد معدة")}
                          </span>
                          {isAdmin(user.job_title) && !hideMachineChangeButton && (
                            <button
                              onClick={() => {
                                const newState = !isSwitchingMachine;
                                setIsSwitchingMachine(newState);
                                if (newState) fetchAllMachines();
                              }}
                              className={`p-1.5 rounded-full transition-all active:scale-90 shrink-0 ${tempMachineId ? 'bg-amber-100 text-amber-600 animate-pulse' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                              title={t("تبديل المعدة مؤقتاً")}
                            >
                              <RefreshCw size={14} className={tempMachineId ? 'animate-spin-slow' : ''} />
                            </button>
                          )}
                        </div>
                      </h3>
                    </div>

                    {tempMachineId && (
                      <button
                        onClick={() => {
                          setTempMachineId(null);
                          setTempMachineName(null);
                          setNotification({ msg: t("تمت العودة للمعدة الأصلية"), type: 'info' });
                          setTimeout(() => setNotification(null), 2000);
                        }}
                        className="text-[10px] font-bold text-red-500 bg-red-50 px-2 py-1 rounded-lg border border-red-100"
                      >
                        {t("إعادة تعيين")}
                      </button>
                    )}
                  </div>

                  {isSwitchingMachine && (
                    <div className="flex flex-col gap-2 animate-in slide-in-from-top-2 duration-300 relative">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            type="text"
                            value={newMachineInput}
                            onChange={(e) => setNewMachineInput(e.target.value)}
                            placeholder={t("أدخل رقم المعدة الجديد...")}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            onKeyDown={(e) => e.key === 'Enter' && handleSwitchMachine()}
                            autoFocus
                          />
                          {isMachinesLoading && (
                            <div className="absolute left-3 top-1/2 -translate-y-1/2">
                              <Loader2 size={14} className="animate-spin text-blue-500 opacity-50" />
                            </div>
                          )}
                        </div>
                        <button
                          onClick={handleSwitchMachine}
                          className="bg-blue-600 text-white p-2 rounded-xl hover:bg-blue-700 transition-all active:scale-95"
                        >
                          <CheckCircle size={20} />
                        </button>
                        <button
                          onClick={() => { setIsSwitchingMachine(false); setNewMachineInput(""); }}
                          className="bg-gray-100 text-gray-500 p-2 rounded-xl hover:bg-gray-200 transition-all active:scale-95"
                        >
                          <X size={20} />
                        </button>
                      </div>

                      {/* Dropdown Menu */}
                      {newMachineInput.trim() !== "" && (
                        <div className="absolute top-full left-0 right-12 mt-1 bg-white border border-gray-100 rounded-xl shadow-xl z-100 max-h-48 overflow-y-auto no-scrollbar">
                          {allMachines
                            .filter(m => 
                              m.id.toLowerCase().includes(newMachineInput.toLowerCase()) || 
                              m.name.toLowerCase().includes(newMachineInput.toLowerCase())
                            )
                            .slice(0, 10)
                            .map((machine) => (
                              <button
                                key={machine.id}
                                onClick={() => {
                                  setNewMachineInput(machine.id);
                                  setTempMachineId(machine.id);
                                  setTempMachineName(machine.name);
                                  setNotification({ msg: t("تم تبديل المعدة مؤقتاً لعرض المستندات"), type: 'success' });
                                  setIsSwitchingMachine(false);
                                  setNewMachineInput("");
                                  setTimeout(() => setNotification(null), 3000);
                                }}
                                className="w-full text-right px-4 py-2.5 text-sm font-bold hover:bg-blue-50 border-b border-gray-50 last:border-0 transition-colors flex items-center justify-between"
                              >
                                <span className="text-gray-700">{machine.name}</span>
                                <span className="text-[10px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-md">{machine.id}</span>
                              </button>
                            ))}
                          {allMachines.filter(m => 
                            m.id.toLowerCase().includes(newMachineInput.toLowerCase()) || 
                            m.name.toLowerCase().includes(newMachineInput.toLowerCase())
                          ).length === 0 && (
                            <div className="px-4 py-3 text-xs text-gray-400 text-center font-bold">
                              {t("لا توجد نتائج مطابقة")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <ActionButton
                  label={t("بطاقة تشغيل")}
                  Icon={FileText}
                  onClick={() => handleViewCarDocument('op')}
                />
                <ActionButton
                  label={t("تأمين المعدة")}
                  Icon={ShieldCheck}
                  onClick={() => handleViewCarDocument('tameen')}
                />
                <ActionButton
                  label={t("الاستمارة")}
                  Icon={FileText}
                  onClick={() => handleViewCarDocument('ist')}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen Image Preview Modal */}
      {fullscreenImage && (
        <div className="fixed inset-0 z-100 bg-black/95 backdrop-blur-md flex flex-col items-center justify-between p-0 animate-in fade-in zoom-in duration-200" dir="rtl">

          <div className="relative w-full flex-1 flex items-center justify-center overflow-hidden">
            {isImageLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Loader2 className="animate-spin text-blue-500" size={40} />
                <p className="text-white/60 text-sm font-bold">{t("جاري تحميل الصورة...")}</p>
              </div>
            )}
            <img
              src={fullscreenImage}
              alt="Document Preview"
              className={`w-full h-full object-contain transition-opacity duration-300 ${isImageLoading ? 'opacity-0' : 'opacity-100'}`}
              style={{
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transition: lastTouch || lastDistance ? 'none' : 'transform 0.2s ease-out',
                touchAction: 'none'
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onDoubleClick={resetZoom}
              onLoad={() => setIsImageLoading(false)}
              onError={() => {
                setNotification({ msg: t("فشل تحميل الصورة، تأكد من اتصال الإنترنت"), type: 'error' });
                setFullscreenImage(null);
                setTimeout(() => setNotification(null), 3000);
              }}
            />
          </div>

          <div className="w-full bg-black/40 backdrop-blur-sm pt-6 pb-20 px-6 flex flex-col items-center gap-6 border-t border-white/10 shadow-[0_-10px_20px_rgba(0,0,0,0.5)]">
            {isAdmin(user.job_title) && (
              <button
                onClick={handleShareImage}
                disabled={isSharing}
                className="w-full max-w-xs flex items-center justify-center gap-3 px-8 py-4 bg-green-600 hover:bg-green-700 text-white rounded-2xl font-bold transition-all active:scale-95 shadow-xl disabled:opacity-50"
              >
                {isSharing ? <Loader2 className="animate-spin" size={20} /> : <Share2 size={20} />}
                <span className="text-lg">{t("مشاركة عبر واتساب")}</span>
              </button>
            )}

            <button
              onClick={() => { setFullscreenImage(null); setIsImageLoading(false); }}
              className="p-4 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 border border-white/20"
              title={t("إغلاق")}
            >
              <X size={32} />
            </button>
          </div>
        </div>
      )}

      <LocationMap
        isOpen={showMapModal}
        onClose={() => setShowMapModal(false)}
        workAreas={cachedLocationAreas}
        onLocationSelect={(location) => {
          setCurrentLocation(location);
          setNotification({ msg: `تم تحديد الموقع: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`, type: 'success' });
          setTimeout(() => setNotification(null), 3000);
        }}
        allowedRadius={100}
        centerLocation={{ latitude: 24.7136, longitude: 46.6753 }}
      />

      {/* نافذة اختيار وتحديث المعدة الترحيبية والطلب الأسبوعي */}
      <MachineSelectionModal
        isOpen={showInitMachineModal}
        onClose={() => setShowInitMachineModal(false)}
        initModalReason={initModalReason}
        allMachines={allMachines}
        isMachinesLoading={isMachinesLoading}
        currentMachineId={user.machine_id}
        onConfirmMachine={async (machineId) => {
          await handleSwitchMachine(machineId, true);
          localStorage.setItem("last_assigned_machine", machineId);
          SettingsManager.setOfficialWindowShownAt('machine', Date.now());
          setShowInitMachineModal(false);
        }}
        onClearMachine={async () => {
          await handleSwitchMachine("", true);
          localStorage.setItem("last_assigned_machine", "NONE");
          SettingsManager.setOfficialWindowShownAt('machine', Date.now());
          setShowInitMachineModal(false);
        }}
      />

      {/* نافذة سؤال تأكيد صحة المعدة من السائق (مكون منفصل وذكي) */}
      <MachineConfirmationModal
        userKey={user.key}
        machineName={user.machine}
        machineUpdatedAt={(user as any).machine_updated_at}
        driverConfirmVal={(user as any)['تأكيد_المعدة_من_السائق']}
        machineColorIntervalDays={appSettingsState?.machineColorIntervalDays}
      />

      {activeWarningsQueue.length > 0 && (
        <DynamicWarningModal
          isOpen={true}
          text={activeWarningsQueue[0].text}
          type={activeWarningsQueue[0].type}
          onClose={() => {
            const currentWarning = activeWarningsQueue[0];
            localStorage.setItem(`last_shown_dynamic_${currentWarning.id}`, Date.now().toString());
            setActiveWarningsQueue((prev) => prev.slice(1));
          }}
        />
      )}



      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes pulse-border {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
        .animate-pulse-border {
          animation: pulse-border 1.5s infinite;
        }
      `}</style>
    </>
  );
};
