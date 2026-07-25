import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export const OTA_VERSION = '1.0.134';
export const APK_VERSION = '1.0.48';

/**
 * دالة جلب إصدار الـ APK الحقيقي من نظام الهواتف مباشرة
 */
export const getNativeApkVersion = async (): Promise<string> => {
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await App.getInfo();
      if (info && info.version) {
        return info.version;
      }
    } catch (e) {
      console.warn("⚠️ Failed to get native app version:", e);
    }
  }
  return APK_VERSION;
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