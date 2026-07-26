import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { Preferences } from '@capacitor/preferences';

export const OTA_VERSION = '1.0.154';
export const APK_VERSION = '1.0.51';

/**
 * دالة جلب إصدار الـ OTA الحقيقي النشط حالياً في الجهاز (محفوظ في 4 طبقات حماية لمنع الضياع)
 */
export const getRunningOtaVersion = async (): Promise<string> => {
  if (Capacitor.isNativePlatform()) {
    try {
      const currentBundle = await CapacitorUpdater.current();
      if (currentBundle && currentBundle.bundle) {
        const rawVer = (currentBundle.bundle.version || currentBundle.bundle.id || '').trim();
        if (rawVer && rawVer !== 'builtin' && rawVer !== 'public' && rawVer !== 'default') {
          localStorage.setItem("last_installed_ota_version", rawVer);
          try { await Preferences.set({ key: "active_ota_version", value: rawVer }); } catch(e) {}
          return rawVer;
        }
      }
    } catch (e) {}
  }

  try {
    const { value: prefVersion } = await Preferences.get({ key: "active_ota_version" });
    if (prefVersion && prefVersion.trim() !== '') return prefVersion.trim();
  } catch (e) {}

  const cachedLocal = localStorage.getItem("last_installed_ota_version");
  if (cachedLocal && cachedLocal.trim() !== '') return cachedLocal.trim();

  return OTA_VERSION;
};

/**
 * دالة حفظ إصدار الـ OTA في التخزين الدائم للهاتف (SharedPreferences + localStorage)
 */
export const setRunningOtaVersion = async (version: string): Promise<void> => {
  const cleanVer = version.trim();
  localStorage.setItem("last_installed_ota_version", cleanVer);
  try {
    await Preferences.set({ key: "active_ota_version", value: cleanVer });
  } catch (e) {}
};

/**
 * دالة جلب إصدار الـ APK الحقيقي المعزول من نظام الهواتف مباشرة
 */
export const getNativeApkVersion = async (): Promise<string> => {
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      if (info && info.version && info.version.trim() !== '') {
        const realNativeVer = info.version.trim();
        localStorage.setItem("native_apk_real_version", realNativeVer);
        return realNativeVer;
      }
    } catch (e) {
      console.warn("⚠️ Failed to get native app version:", e);
    }
  }
  const cachedNative = localStorage.getItem("native_apk_real_version");
  if (cachedNative && cachedNative.trim() !== '') return cachedNative.trim();

  // إذا كان من المتصفح (غير تطبيق هاتف أصلي)، يرجع WEB
  return "WEB";
};

// ── أدوار المستخدمين ──────────────────────────────────────────────────────────
// جميع الأدوار ذات صلاحية الإشراف والإدارة
export const SUPERVISOR_ROLES = ['مراقب', 'مسؤول', 'مشرف', 'Admin', 'Owner', 'manager'] as const;

// الأدوار الإدارية العليا فقط (Admin وما فوق)
export const ADMIN_ROLES = ['Admin'] as const;

// نوع TypeScript مستنتج من الثوابت
export type SupervisorRole = typeof SUPERVISOR_ROLES[number];
export type AdminRole = typeof ADMIN_ROLES[number];

// دوال مساعدة للتحقق من الصلاحيات
export const isSupervisor = (jobTitle: string): boolean =>
  (SUPERVISOR_ROLES as readonly string[]).includes(jobTitle);

export const isAdmin = (jobTitle: string): boolean =>
  (ADMIN_ROLES as readonly string[]).includes(jobTitle);