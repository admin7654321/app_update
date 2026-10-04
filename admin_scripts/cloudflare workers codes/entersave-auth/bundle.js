/**
 * ============================================================================
 * Cloudflare Worker: entersave-auth (بوابة تسجيل الدخول، التهيئة السريعة، والتقارير المضغوطة)
 * الرابط: https://entersave-auth.admin-a.workers.dev
 * ============================================================================
 */

const DEFAULT_CONFIG = {
    FIREBASE_DATABASE_URL: "https://entersave1-default-rtdb.firebaseio.com",
    FIREBASE_SECRET: "UWv7r1V7eSgX46fiHcy2wm0GwQlyzed8uKQtWaBk",
    FIREBASE_API_KEY: "AIzaSyAmZXH0s2D_uU95XDrhs3YSFVQiSoG82BU",
    FIREBASE_AUTH_DOMAIN: "entersave1.firebaseapp.com",
    FIREBASE_PROJECT_ID: "entersave1",
    FIREBASE_STORAGE_BUCKET: "entersave1.firebasestorage.app",
    FIREBASE_MESSAGING_SENDER_ID: "174050062389",
    APP_ID: "1:174050062389:android:babe68dd11d5a72e52017c"
};

// ── 1. دوال التحقق من الموظف والجهاز (Login Flow) ───────────────────────────
async function checkEmployee(env, iqama) {
    const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
    const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;

    const encodedPath = encodeURIComponent("قائمة_الموظفين");
    const empUrl = `${dbUrl}/${encodedPath}.json?auth=${secret}&orderBy="iqama"&equalTo="${iqama}"`;
    const res = await fetch(empUrl);
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (e) {
        throw new Error("تعذر قراءة بيانات الموظف من الخادم");
    }

    if (!data || Object.keys(data).length === 0) return { valid: false, error: "عذراً، هذا الرقم غير موجود" };

    const userKey = Object.keys(data)[0];
    return { valid: true, userKey };
}

async function checkDevice(env, iqama, currentDeviceId) {
    const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
    const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;

    const devUrl = `${dbUrl}/devices.json?auth=${secret}&orderBy="iqama"&equalTo="${iqama}"`;
    const res = await fetch(devUrl);
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (e) {
        throw new Error("تعذر قراءة بيانات الأجهزة من الخادم");
    }

    if (data && Object.keys(data).length > 0) {
        const existingDevice = Object.values(data)[0];
        if (existingDevice.deviceId !== currentDeviceId) {
            return { 
                registered: true, 
                error: "عذراً، هذا الرقم مسجل بجهاز آخر مسبقاً. تواصل مع المسؤول." 
            };
        }
        return { registered: false };
    }

    return { registered: false };
}

function getFirebaseConfig(env, userKey) {
    return {
        apiKey: env?.FIREBASE_API_KEY || DEFAULT_CONFIG.FIREBASE_API_KEY,
        authDomain: env?.FIREBASE_AUTH_DOMAIN || DEFAULT_CONFIG.FIREBASE_AUTH_DOMAIN,
        databaseURL: env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL,
        projectId: env?.FIREBASE_PROJECT_ID || DEFAULT_CONFIG.FIREBASE_PROJECT_ID,
        storageBucket: env?.FIREBASE_STORAGE_BUCKET || DEFAULT_CONFIG.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: env?.FIREBASE_MESSAGING_SENDER_ID || DEFAULT_CONFIG.FIREBASE_MESSAGING_SENDER_ID,
        appId: env?.APP_ID || env?.FIREBASE_APP_ID || DEFAULT_CONFIG.APP_ID,
        userKey,
        appLogo: "https://i.imgur.com/hx9ajQ5.png"
    };
}

// ── 2. محرك التهيئة السريعة الموحدة (Edge Bootstrap Flow) ──────────────────────
// مخصص للإقلاع الصباحي وتسجيل الحضور وتحديد الموقع بأقصى سرعة ممكنة
async function handleBootstrap(body, env) {
    const { userKey, deviceId, date } = body;
    if (!userKey) {
        return { error: "userKey is required for bootstrap" };
    }

    const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
    const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;

    const now = new Date();
    const riyadhOffsetMs = 3 * 60 * 60 * 1000;
    const riyadhDate = new Date(now.getTime() + riyadhOffsetMs);
    const targetDate = date || `${riyadhDate.getUTCFullYear()}-${String(riyadhDate.getUTCMonth() + 1).padStart(2, '0')}-${String(riyadhDate.getUTCDate()).padStart(2, '0')}`;

    // جلب بيانات الحضور والملف والموقع والإعدادات في طلب فائق الخفة
    const [
        userRes, attRes, versionsRes, lockRes, userLockRes,
        devRes, userPermRes, areaPermRes, workAreasRes, settingsRes
    ] = await Promise.all([
        fetch(`${dbUrl}/${encodeURIComponent("قائمة_الموظفين")}/${encodeURIComponent(userKey)}.json?auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("بيانات_الحضور_حسب_اليوم")}/${targetDate}/${encodeURIComponent(userKey)}.json?auth=${secret}`),
        fetch(`${dbUrl}/SystemSettings/AppSettings/versions.json?auth=${secret}`),
        fetch(`${dbUrl}/SystemLockData/General.json?auth=${secret}`),
        fetch(`${dbUrl}/SystemLockData/Users/${encodeURIComponent(userKey)}.json?auth=${secret}`),
        deviceId ? fetch(`${dbUrl}/devices/${encodeURIComponent(deviceId)}.json?auth=${secret}`) : Promise.resolve(null),
        fetch(`${dbUrl}/user_permissions/${encodeURIComponent(userKey)}.json?auth=${secret}`),
        fetch(`${dbUrl}/areapermissions/${encodeURIComponent(userKey)}.json?auth=${secret}`),
        fetch(`${dbUrl}/workAreas.json?auth=${secret}`),
        fetch(`${dbUrl}/SystemSettings/AppSettings/settings.json?auth=${secret}`)
    ]);

    const [
        userData, attData, versionsData, lockData, userLockData,
        devData, userPermData, areaPermData, workAreasData, settingsData
    ] = await Promise.all([
        userRes.json().catch(() => null),
        attRes.json().catch(() => null),
        versionsRes.json().catch(() => null),
        lockRes.json().catch(() => null),
        userLockRes.json().catch(() => null),
        devRes ? devRes.json().catch(() => null) : null,
        userPermRes.json().catch(() => null),
        areaPermRes.json().catch(() => null),
        workAreasRes.json().catch(() => null),
        settingsRes.json().catch(() => null)
    ]);

    // إذا كان للموظف معدة مسجلة كرقم، نجلب اسمها ونوعها ورقم اللوحة فورياً
    if (userData && userData.machine && userData.machine !== '---' && userData.machine !== 'لا يوجد' && !userData.machine.includes(' ')) {
        try {
            const mRes = await fetch(`${dbUrl}/${encodeURIComponent("قائمة_المعدات")}/${encodeURIComponent(userData.machine)}.json?auth=${secret}`);
            const mVal = await mRes.json();
            if (mVal && typeof mVal === 'object') {
                const type = mVal.type || '';
                userData.machine_type = type;
                userData.machine_plate = mVal.plate || '';
                userData.machine_name = type ? `${type} ${userData.machine}`.trim() : userData.machine;
            }
        } catch (e) {}
    }

    let areaswork = userPermData?.areaswork || {};
    if (Object.keys(areaswork).length === 0 && areaPermData) {
        areaswork = areaPermData;
    }
    const tasks = userPermData?.tasks || {};

    return {
        success: true,
        serverTime: now.getTime(),
        riyadhDate: targetDate,
        user: userData,
        attendance: attData,
        versions: versionsData,
        lock: lockData,
        userLock: userLockData,
        device: devData,
        userPermissions: { areaswork, tasks },
        areapermissions: areaswork,
        workAreas: workAreasData,
        appSettings: settingsData
    };
}

// ── 3. محرك تفاصيل الملف الشخصي والتقويم (Profile Details Flow) ─────────────────
// لا يُطلب إلا عند الضغط على تبويب "ملفي" فقط
async function handleProfileDetails(body, env) {
    const { userKey, month } = body;
    if (!userKey) {
        return { error: "userKey is required for profile_details" };
    }

    const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
    const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;

    const now = new Date();
    const riyadhOffsetMs = 3 * 60 * 60 * 1000;
    const riyadhDate = new Date(now.getTime() + riyadhOffsetMs);
    const targetMonth = month || `${riyadhDate.getUTCFullYear()}-${String(riyadhDate.getUTCMonth() + 1).padStart(2, '0')}`;

    const [holidaysRes, monthlyAttRes, loansRes, machinesRes] = await Promise.all([
        fetch(`${dbUrl}/${encodeURIComponent("ايام_الاجازات")}.json?auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("بيانات_الحضور_حسب_الموظف")}/${encodeURIComponent(userKey)}/${targetMonth}.json?auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("جدول_السلف")}.json?orderBy=%22employee_id%22&equalTo=%22${encodeURIComponent(userKey)}%22&auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("قائمة_المعدات")}.json?auth=${secret}`)
    ]);

    const [holidaysData, monthlyAttData, loansData, machinesData] = await Promise.all([
        holidaysRes.json().catch(() => null),
        monthlyAttRes.json().catch(() => null),
        loansRes.json().catch(() => null),
        machinesRes.json().catch(() => null)
    ]);

    let totalLoansBalance = 0;
    if (loansData && typeof loansData === 'object') {
        totalLoansBalance = Object.values(loansData).reduce((sum, advance) => {
            const debit = parseFloat(advance.debit) || parseFloat(advance.amount) || 0;
            const credit = parseFloat(advance.credit) || 0;
            return sum + (debit - credit);
        }, 0);
    }

    const machinesList = machinesData && typeof machinesData === 'object' ? Object.entries(machinesData).map(([id, mVal]) => {
        const type = mVal.type || '';
        const nameStr = mVal.name || mVal.costCenter || id;
        const fullTypeAndName = type && !nameStr.includes(type) ? `${type} ${nameStr}`.trim() : nameStr;
        return [id, fullTypeAndName, mVal.plate || '', mVal.driver || ''];
    }) : [];

    return {
        success: true,
        targetMonth,
        holidays: holidaysData,
        monthlyAttendance: monthlyAttData,
        loans: loansData,
        loansBalance: totalLoansBalance,
        machinesList
    };
}

// ── 3. محرك تقرير الحضور الفائق المضغوط (Ultra-Compressed Attendance Report) ──
async function handleAttendanceReport(body, env) {
    const { date, locId } = body;
    const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
    const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;

    const now = new Date();
    const riyadhOffsetMs = 3 * 60 * 60 * 1000;
    const riyadhDate = new Date(now.getTime() + riyadhOffsetMs);
    const selectedDate = date || `${riyadhDate.getUTCFullYear()}-${String(riyadhDate.getUTCMonth() + 1).padStart(2, '0')}-${String(riyadhDate.getUTCDate()).padStart(2, '0')}`;

    const [employeesRes, attendanceRes, machinesRes] = await Promise.all([
        fetch(`${dbUrl}/${encodeURIComponent("قائمة_الموظفين")}.json?auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("بيانات_الحضور_حسب_اليوم")}/${selectedDate}.json?auth=${secret}`),
        fetch(`${dbUrl}/${encodeURIComponent("قائمة_المعدات")}.json?auth=${secret}`)
    ]);

    const [allEmployeesRaw, attendanceDataRaw, machinesRaw] = await Promise.all([
        employeesRes.json().catch(() => ({})),
        attendanceRes.json().catch(() => ({})),
        machinesRes.json().catch(() => ({}))
    ]);

    const allEmployees = allEmployeesRaw || {};
    const attendanceToday = attendanceDataRaw || {};
    const machines = machinesRaw || {};

    // قواميس الفهارس للضغط الفائق
    const jobsDict = [];
    const subJobsDict = [];
    const locsDict = [];
    const machinesDict = [];

    const getIdx = (arr, val) => {
        const clean = (val || '').toString().trim();
        if (!clean || clean === '---' || clean === 'لا يوجد' || clean === 'بدون معدة' || clean === 'لا يوجد معدة') return -1;
        let idx = arr.indexOf(clean);
        if (idx === -1) {
            idx = arr.length;
            arr.push(clean);
        }
        return idx;
    };

    const rows = [];

    // فلترة الموظفين النشطين فقط وتكويدهم كأعمدة مضغوطة
    for (const [userKey, val] of Object.entries(allEmployees)) {
        if (!val || typeof val !== 'object') continue;
        const status = val.status;
        if (
            status === 'مخفي' || status === 'hidden' || status === 'hide' ||
            val.hidden || val.hide ||
            status === 'غير نشط' || status === 'منتهي' || status === 'خارج العمل' || status === 'inactive'
        ) {
            continue;
        }

        // فحص النشاط حسب تاريخ الاستحقاق وتاريخ انتهاء العقد
        let isActive = true;
        if (val.employment_history && typeof val.employment_history === 'object') {
            const history = Object.values(val.employment_history);
            isActive = history.some(p => {
                const start = p.start_date || '0000-00-00';
                const end = (p.status === 'نشط' || !p.end_date) ? '9999-99-99' : p.end_date;
                return selectedDate >= start && selectedDate <= end;
            });
        } else {
            const start = val.start_date || '';
            const end = val.end_date || '';
            if (status === 'نشط') {
                isActive = !start || start <= selectedDate;
            } else {
                isActive = (!start || start <= selectedDate) && (!end || end >= selectedDate);
            }
        }

        if (!isActive) continue;

        const loc = (val.lastLocation || '').trim();
        if (locId && locId !== 'الكل' && locId !== 'all' && loc !== locId) {
            continue;
        }

        const job = (val.job_title || '').trim();
        const subJob = (val.sub_job || val.subJob || '').trim();
        const machine = (val.machine || '').trim();
        const name = (val.name_ar || val.name || 'مستخدم').trim();

        // بيانات الحضور اليومي
        const att = attendanceToday[userKey];
        // 0: لم يسجل, 1: حاضر (present), 2: غائب (absent)
        const attStatus = att ? (att.status === 'present' ? 1 : (att.status === 'absent' ? 2 : 0)) : 0;
        const attTime = att?.time || '';
        const attArea = att?.area || '';

        const jobIdx = getIdx(jobsDict, job);
        const subJobIdx = getIdx(subJobsDict, subJob);
        const locIdx = getIdx(locsDict, loc);
        const machineIdx = getIdx(machinesDict, machine);

        // Tuple مضغوط للغاية:
        // [0:userKey, 1:name, 2:jobIdx, 3:subJobIdx, 4:locIdx, 5:machineIdx, 6:attStatus, 7:attTime, 8:attArea]
        rows.push([
            userKey,
            name,
            jobIdx,
            subJobIdx,
            locIdx,
            machineIdx,
            attStatus,
            attTime,
            attArea
        ]);
    }

    // ضغط قائمة المعدات للقوائم المنسدلة
    const mList = Object.entries(machines).map(([id, mVal]) => {
        const type = mVal.type || '';
        const nameStr = mVal.name || mVal.costCenter || id;
        const fullTypeAndName = type && !nameStr.includes(type) ? `${type} ${nameStr}`.trim() : nameStr;
        return [id, fullTypeAndName, mVal.plate || '', mVal.driver || ''];
    });

    return {
        success: true,
        date: selectedDate,
        totalCount: rows.length,
        dict: {
            jobs: jobsDict,
            subJobs: subJobsDict,
            locs: locsDict,
            machines: machinesDict
        },
        rows,
        machinesList: mList
    };
}

// ── 4. نقطة الدخول الرئيسية (Main Handler) ───────────────────────────────────
export default {
    async fetch(request, env) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        };

        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        if (request.method === "GET") {
            return new Response(JSON.stringify({ 
                status: "online", 
                worker: "entersave-auth (Login, Bootstrap & Compressed Reports)",
                features: ["login", "bootstrap", "attendance_report"],
                time: new Date().toISOString() 
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        try {
            const body = await request.json();

            // ⚡ المسار 1: محرك التهيئة السريعة الموحدة (Bootstrap)
            if (body.action === 'bootstrap') {
                const bootstrapResult = await handleBootstrap(body, env);
                if (bootstrapResult.error) {
                    return new Response(JSON.stringify(bootstrapResult), { status: 400, headers: corsHeaders });
                }
                return new Response(JSON.stringify(bootstrapResult), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // ⚡ المسار 2: محرك تفاصيل الملف الشخصي والتقويم (عند لمس تبويب "ملفي")
            if (body.action === 'profile_details') {
                const detailsResult = await handleProfileDetails(body, env);
                if (detailsResult.error) {
                    return new Response(JSON.stringify(detailsResult), { status: 400, headers: corsHeaders });
                }
                return new Response(JSON.stringify(detailsResult), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // ⚡ المسار 3: محرك تقرير الحضور الفائق المضغوط (Compressed Report)
            if (body.action === 'attendance_report') {
                const reportResult = await handleAttendanceReport(body, env);
                return new Response(JSON.stringify(reportResult), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // ⚡ المسار 4: جلب قائمة المعدات المضغوطة عند الطلب
            if (body.action === 'get_machines') {
                const dbUrl = (env?.FIREBASE_DATABASE_URL || DEFAULT_CONFIG.FIREBASE_DATABASE_URL).replace(/\/$/, "");
                const secret = env?.FIREBASE_SECRET || DEFAULT_CONFIG.FIREBASE_SECRET;
                const machinesRes = await fetch(`${dbUrl}/${encodeURIComponent("قائمة_المعدات")}.json?auth=${secret}`);
                const machinesData = await machinesRes.json().catch(() => ({}));
                const machinesList = Object.entries(machinesData || {}).map(([id, mVal]) => {
                    const type = mVal.type || '';
                    const nameStr = mVal.name || mVal.costCenter || id;
                    const fullTypeAndName = type && !nameStr.includes(type) ? `${type} ${nameStr}`.trim() : nameStr;
                    return [id, fullTypeAndName, mVal.plate || '', mVal.driver || ''];
                });
                return new Response(JSON.stringify({ success: true, machinesList }), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }

            // 🔒 المسار 3: تسجيل الدخول والتحقق من الأجهزة (الوضع الأصلي دون تغيير)
            const { iqama, deviceId } = body;

            // أ. الفحص الأول: هل الموظف موجود؟
            const empCheck = await checkEmployee(env, iqama);
            if (!empCheck.valid) {
                return new Response(JSON.stringify({ error: empCheck.error }), { status: 403, headers: corsHeaders });
            }

            // ب. الفحص الثاني: هل الرقم مسجل مسبقاً بجهاز مختلف؟
            const devCheck = await checkDevice(env, iqama, deviceId);
            if (devCheck.registered) {
                return new Response(JSON.stringify({ error: devCheck.error }), { status: 403, headers: corsHeaders });
            }

            // ج. استعادة الإعدادات إذا اجتاز الفحصين
            const config = getFirebaseConfig(env, empCheck.userKey);

            return new Response(JSON.stringify(config), {
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });

        } catch (err) {
            console.error("Worker Request Error:", err.message);
            return new Response(JSON.stringify({ error: "خطأ في السيرفر: " + err.message }), { status: 500, headers: corsHeaders });
        }
    }
};
