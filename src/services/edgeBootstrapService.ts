/**
 * edgeBootstrapService.ts
 * خدمة الإقلاع والتجهيز المسبق في الذاكرة عبر Cloudflare Worker (BFF Pattern)
 * تجمع (بيانات الموظف، حضور اليوم، إصدارات النظام، أقفال النظام، بيانات الجهاز، التوقيت الحقيقي)
 * في طلب شبكة واحد فائق الخفة، وتجهزها في الذاكرة لتأخذها الطلبات المتسلسلة بطبيعتها القديمة في 0ms.
 */

import { CLOUDFLARE_AUTH_URL } from '../constants';
import { setServerTimeFromTrustedSource } from './firebase';

export interface BootstrapResponse {
  success: boolean;
  serverTime: number;
  riyadhDate: string;
  targetMonth?: string;
  user: any;
  attendance: any;
  versions: any;
  lock: any;
  userLock: any;
  device: any;
  userPermissions?: { areaswork: Record<string, any>; tasks: Record<string, any> };
  areapermissions?: Record<string, any>;
  workAreas?: any;
  appSettings?: any;
  holidays?: any;
  monthlyAttendance?: any;
  loans?: any;
  loansBalance?: number;
  machinesList?: any[];
}

export interface ProfileDetailsResponse {
  success: boolean;
  targetMonth: string;
  holidays: any;
  monthlyAttendance: any;
  loans: any;
  loansBalance: number;
  machinesList?: any[];
}

// 🧠 مخزن الذاكرة المؤقت لحزمة الإقلاع (In-Memory Store)
let memoryStore: BootstrapResponse | null = null;
let profileDetailsStore: Record<string, ProfileDetailsResponse> = {};

export const edgeBootstrapService = {
  /**
   * طلب حزمة الإقلاع الموحدة وتجهيزها في الذاكرة
   */
  async prepareBootstrap(
    userKey: string,
    deviceId: string,
    date?: string,
    timeoutMs: number = 3000
  ): Promise<BootstrapResponse | null> {
    if (!userKey || !CLOUDFLARE_AUTH_URL) {
      memoryStore = null;
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(CLOUDFLARE_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'bootstrap',
          userKey: userKey.trim(),
          deviceId: deviceId?.trim() || '',
          date: date || '',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[EdgeBootstrap] Worker responded with status: ${response.status}`);
        memoryStore = null;
        return null;
      }

      const data = (await response.json()) as BootstrapResponse;
      if (data && data.success) {
        memoryStore = data;
        // ضبط التوقيت الموثوق فوراً في الذاكرة ليصبح متاحاً لكل الدوال الزمنية
        if (data.serverTime) {
          setServerTimeFromTrustedSource(data.serverTime);
        }
        if (data.workAreas) {
          try {
            localStorage.setItem('cached_work_areas', JSON.stringify(data.workAreas));
          } catch (e) {}
        }
        if (data.areapermissions) {
          try {
            localStorage.setItem(`cached_areapermissions_${userKey}`, JSON.stringify(data.areapermissions));
          } catch (e) {}
        }
        if (data.holidays) {
          try {
            localStorage.setItem('cached_holidays', JSON.stringify(data.holidays));
          } catch (e) {}
        }
        if (data.loansBalance !== undefined) {
          try {
            localStorage.setItem(`last_loans_balance_${userKey}`, data.loansBalance.toString());
          } catch (e) {}
        }
        if (data.appSettings) {
          try {
            const NS = 'app_settings';
            if (data.appSettings.general) {
              localStorage.setItem(`${NS}.general`, JSON.stringify(data.appSettings.general));
            }
            if (data.appSettings.officialWindows) {
              for (const [k, v] of Object.entries(data.appSettings.officialWindows)) {
                localStorage.setItem(`${NS}.officialWindows.${k}`, JSON.stringify(v));
              }
            }
            if (data.appSettings.warningItems) {
              for (const [k, v] of Object.entries(data.appSettings.warningItems)) {
                localStorage.setItem(`${NS}.warningItems.${k}`, JSON.stringify(v));
              }
            }
            if (data.versions?.v) {
              localStorage.setItem(`${NS}.globalVersion`, data.versions.v.toString());
            }
            if (data.versions) {
              localStorage.setItem(`${NS}.versions`, JSON.stringify(data.versions));
            }
          } catch (e) {}
        }
        return data;
      }
      memoryStore = null;
      return null;
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn('[EdgeBootstrap] Edge prepare bypassed (direct fallback will handle):', err?.message || err);
      memoryStore = null;
      return null;
    }
  },

  /**
   * للتوافق مع الاستدعاءات السابقة
   */
  async fetchBootstrap(
    userKey: string,
    deviceId: string,
    date?: string,
    timeoutMs: number = 3000
  ): Promise<BootstrapResponse | null> {
    return this.prepareBootstrap(userKey, deviceId, date, timeoutMs);
  },

  /**
   * طلب تفاصيل الملف الشخصي (الطلب الثاني: عند فتح تبويب "ملفي" فقط)
   * يجلب: أيام الإجازات لجميع المواقع، حضور الشهر بالكامل، وسجل السلف ورصيدها
   */
  async fetchProfileDetails(
    userKey: string,
    month?: string,
    timeoutMs: number = 4000
  ): Promise<ProfileDetailsResponse | null> {
    if (!userKey || !CLOUDFLARE_AUTH_URL) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(CLOUDFLARE_AUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'profile_details',
          userKey: userKey.trim(),
          month: month || '',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[EdgeBootstrap] Profile details responded with status: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as ProfileDetailsResponse;
      if (data && data.success) {
        const monthKey = data.targetMonth;
        profileDetailsStore[monthKey] = data;

        // دمجها في الذاكرة لتكون متوفرة فوراً لكل الدوال والمكونات
        if (memoryStore) {
          memoryStore.holidays = data.holidays;
          memoryStore.monthlyAttendance = data.monthlyAttendance;
          memoryStore.loans = data.loans;
          memoryStore.loansBalance = data.loansBalance;
          memoryStore.targetMonth = monthKey;
        }

        // التخزين المحلي الآمن للاستخدام دون اتصال
        if (data.holidays) {
          try {
            localStorage.setItem('cached_holidays', JSON.stringify(data.holidays));
          } catch (e) {}
        }
        if (data.loansBalance !== undefined) {
          try {
            localStorage.setItem(`last_loans_balance_${userKey}`, data.loansBalance.toString());
          } catch (e) {}
        }
        if (data.monthlyAttendance) {
          try {
            localStorage.setItem(`cached_monthly_att_${userKey}_${monthKey}`, JSON.stringify(data.monthlyAttendance));
          } catch (e) {}
        }
        if (data.machinesList && Array.isArray(data.machinesList)) {
          try {
            localStorage.setItem('cached_machines_list', JSON.stringify(data.machinesList));
          } catch (e) {}
        }

        return data;
      }
      return null;
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn('[EdgeBootstrap] fetchProfileDetails error:', err?.message || err);
      return null;
    }
  },

  /**
   * هل توجد بيانات ملفي متوفرة في الذاكرة؟
   */
  hasProfileDetails(monthKey?: string): boolean {
    if (monthKey && profileDetailsStore[monthKey]) return true;
    return !!(memoryStore && memoryStore.holidays && memoryStore.monthlyAttendance);
  },

  /**
   * هل توجد بيانات مجهزة في الذاكرة حالياً؟
   */
  hasMemory(): boolean {
    return !!memoryStore && memoryStore.success === true;
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لملف الموظف من الذاكرة
   */
  getMemoryProfile(userKey: string) {
    const val = memoryStore?.user ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لحضور اليوم من الذاكرة
   */
  getMemoryAttendance(dateStr: string, userKey: string) {
    const val = memoryStore?.attendance ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لإصدارات الإعدادات من الذاكرة
   */
  getMemoryVersions() {
    const val = memoryStore?.versions ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لبيانات الجهاز من الذاكرة
   */
  getMemoryDevice(deviceId: string) {
    const val = memoryStore?.device ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لقفل النظام العام من الذاكرة
   */
  getMemorySystemLock() {
    const val = memoryStore?.lock ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لقفل المستخدم من الذاكرة
   */
  getMemoryUserLock(userKey: string) {
    const val = memoryStore?.userLock ?? null;
    return {
      exists: () => val !== null,
      val: () => val
    };
  },

  /**
   * قراءة الصلاحيات العامة من الذاكرة
   */
  getMemoryUserPermissions() {
    return memoryStore?.userPermissions ?? null;
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لصلاحيات المواقع من الذاكرة أو الكاش
   */
  getMemoryAreaPermissions(userKey?: string) {
    let val = memoryStore?.areapermissions ?? null;
    if (!val && userKey) {
      try {
        const cached = localStorage.getItem(`cached_areapermissions_${userKey}`);
        if (cached) val = JSON.parse(cached);
      } catch (e) {}
    }
    return {
      exists: () => val !== null && typeof val === 'object' && Object.keys(val).length > 0,
      val: () => val || {}
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لمناطق العمل من الذاكرة أو الكاش
   */
  getMemoryWorkAreas() {
    let val = memoryStore?.workAreas ?? null;
    if (!val) {
      try {
        const cached = localStorage.getItem('cached_work_areas');
        if (cached) val = JSON.parse(cached);
      } catch (e) {}
    }
    return {
      exists: () => val !== null && typeof val === 'object' && Object.keys(val).length > 0,
      val: () => val || {}
    };
  },

  /**
   * قراءة إعدادات التطبيق من الذاكرة
   */
  getMemoryAppSettings() {
    return memoryStore?.appSettings ?? null;
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لأيام الإجازات من الذاكرة أو الكاش
   */
  getMemoryHolidays() {
    let val = memoryStore?.holidays ?? null;
    if (!val) {
      const details = Object.values(profileDetailsStore)[0];
      if (details?.holidays) val = details.holidays;
    }
    if (!val) {
      try {
        const cached = localStorage.getItem('cached_holidays');
        if (cached) val = JSON.parse(cached);
      } catch (e) {}
    }
    return {
      exists: () => val !== null && typeof val === 'object' && Object.keys(val).length > 0,
      val: () => val || {}
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لحضور الموظف الشهري
   */
  getMemoryMonthlyAttendance(userKey: string, monthKey: string) {
    let val: any = null;
    if (profileDetailsStore[monthKey]?.monthlyAttendance) {
      val = profileDetailsStore[monthKey].monthlyAttendance;
    } else if (memoryStore?.targetMonth === monthKey && memoryStore?.monthlyAttendance) {
      val = memoryStore.monthlyAttendance;
    } else {
      try {
        const cached = localStorage.getItem(`cached_monthly_att_${userKey}_${monthKey}`);
        if (cached) val = JSON.parse(cached);
      } catch (e) {}
    }
    const hasData = profileDetailsStore[monthKey] !== undefined || (memoryStore?.targetMonth === monthKey && memoryStore?.monthlyAttendance !== undefined);
    return {
      exists: () => hasData || (val !== null && typeof val === 'object' && Object.keys(val).length > 0),
      val: () => val || {}
    };
  },

  /**
   * قراءة snapshot متوافقة مع Firebase لسلف الموظف من الذاكرة
   */
  getMemoryLoans(userKey: string) {
    let val = memoryStore?.loans ?? null;
    let balance = memoryStore?.loansBalance ?? 0;
    if (!val) {
      const details = Object.values(profileDetailsStore)[0];
      if (details?.loans) {
        val = details.loans;
        balance = details.loansBalance ?? 0;
      }
    }
    if (balance === 0 && userKey) {
      try {
        const cached = localStorage.getItem(`last_loans_balance_${userKey}`);
        if (cached) balance = parseFloat(cached) || 0;
      } catch (e) {}
    }
    return {
      exists: () => val !== null,
      val: () => val || {},
      balance
    };
  },

  /**
   * قراءة قائمة المعدات من الذاكرة أو الكاش المحلي
   */
  getMemoryMachinesList(): any[] | null {
    if (memoryStore?.machinesList && Array.isArray(memoryStore.machinesList) && memoryStore.machinesList.length > 0) {
      return memoryStore.machinesList;
    }
    const details = Object.values(profileDetailsStore).find(d => d.machinesList && d.machinesList.length > 0);
    if (details?.machinesList) {
      return details.machinesList;
    }
    try {
      const cached = localStorage.getItem('cached_machines_list') || localStorage.getItem('cached_all_machines');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return null;
  },

  /**
   * طلب قائمة المعدات مباشرة من Cloudflare Worker عند الحاجة
   */
  async fetchMachines(timeoutMs: number = 4000): Promise<any[] | null> {
    if (!CLOUDFLARE_AUTH_URL) return null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(CLOUDFLARE_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_machines' }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.success && Array.isArray(data.machinesList)) {
        if (memoryStore) memoryStore.machinesList = data.machinesList;
        try {
          localStorage.setItem('cached_machines_list', JSON.stringify(data.machinesList));
        } catch (e) {}
        return data.machinesList;
      }
      return null;
    } catch (e) {
      clearTimeout(timeoutId);
      return null;
    }
  },

  /**
   * تفريغ الذاكرة
   */
  clearMemory() {
    memoryStore = null;
    profileDetailsStore = {};
  }
};
