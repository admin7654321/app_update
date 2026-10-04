import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, auth, ensureAuthenticated } from '../services/firebase';
import { ref, set, get, push, runTransaction, query, orderByChild, equalTo, update, startAt, endAt, limitToFirst } from 'firebase/database';
import { initializeApp as initSecondaryApp, deleteApp } from 'firebase/app';
import { getAuth as getSecondaryAuth, createUserWithEmailAndPassword, signOut as signOutSecondary } from 'firebase/auth';
import { ArrowRight, Save, Loader2, Calendar, Truck, User, Briefcase, Hash, MapPin, ChevronDown, ChevronUp, CheckCircle, ShieldAlert, X, Search, Lock, Copy, Check } from 'lucide-react';
import { SUB_JOB_OPTIONS, getPrimaryJobTitle, ENABLE_FIREBASE_FALLBACK } from '../constants';
import { edgeBootstrapService } from '../services/edgeBootstrapService';
import { swrCache } from '../services/swrCache';
import { DatePickerSelector } from '../components/DatePickerSelector';
import { MachineSelectionModal } from '../components/MachineSelectionModal';
import { useToast } from '../context/ToastContext';
import { useClickOutside } from '../hooks/useClickOutside';

const createEmployeeAuthAccount = async (targetId: string, customPass?: string) => {
    const email = `${targetId}@company.com`;
    const password = customPass && customPass.trim() ? customPass.trim() : `123456`;
    let secondaryApp: any = null;
    try {
        const appConfig = db?.app?.options;
        if (!appConfig) {
            console.warn("⚠️ Firebase app options unavailable for secondary auth creation");
            return null;
        }
        secondaryApp = initSecondaryApp(appConfig, `SecondaryAuth_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
        const secondaryAuth = getSecondaryAuth(secondaryApp);
        const userCred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const uid = userCred.user.uid;
        await signOutSecondary(secondaryAuth);
        return uid;
    } catch (authErr: any) {
        console.warn("⚠️ Secondary Auth creation failed or account already exists:", authErr.code || authErr.message);
        return null;
    } finally {
        if (secondaryApp) {
            try { await deleteApp(secondaryApp); } catch (_) {}
        }
    }
};

export const AddEmployeePage: React.FC = () => {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const { showToast, hideToast } = useToast();
    const setNotification = (n: { msg: string, type: 'success' | 'error' | 'info' | 'warning' } | null) => {
        if (!n) hideToast();
        else showToast(n.msg, n.type);
    };
    const [errorModal, setErrorModal] = useState<{ title: string, details: string } | null>(null);
    const [copiedError, setCopiedError] = useState(false);
    const [showMore, setShowMore] = useState(false);

    const [formData, setFormData] = useState({
        name_ar: '',
        job_title: '',
        sub_job: '',
        lastLocation: '',
        start_date: '',
        machine: '',
        end_date: '',
        nationality: '',
        iqama: '',
        housing: '',
        housing_in: '',
        housing_out: '',
        password: ''
    });

    const [isIqamaValid, setIsIqamaValid] = useState(false);
    const [searchingIqama, setSearchingIqama] = useState(false);
    const [isRehire, setIsRehire] = useState(false);
    const [existingId, setExistingId] = useState<string | null>(null);

    // ⚡ Lists for pickers (تبدأ فوراً من الكاش لسرعة 0ms)
    const [machinesList, setMachinesList] = useState<{ id: string, label: string }[]>(() => swrCache.get('machines', []));
    const [showMachineSuggestions, setShowMachineSuggestions] = useState(false);

    const [showDatePicker, setShowDatePicker] = useState<string | null>(null);
    const datePickerRef = useRef<HTMLDivElement>(null);
    const machinePickerRef = useRef<HTMLDivElement>(null);

    const [showJobTitlePicker, setShowJobTitlePicker] = useState(false);
    const jobTitlePickerRef = useRef<HTMLDivElement>(null);

    const [showSubJobPicker, setShowSubJobPicker] = useState(false);
    const subJobPickerRef = useRef<HTMLDivElement>(null);

    const [locationsList, setLocationsList] = useState<{ id: string, name: string }[]>(() => swrCache.get('locations', []));
    const [showLocationPicker, setShowLocationPicker] = useState(false);
    const locationPickerRef = useRef<HTMLDivElement>(null);

    useClickOutside(locationPickerRef, () => setShowLocationPicker(false), showLocationPicker);
    useClickOutside(subJobPickerRef, () => setShowSubJobPicker(false), showSubJobPicker);
    useClickOutside(jobTitlePickerRef, () => setShowJobTitlePicker(false), showJobTitlePicker);
    useClickOutside(machinePickerRef, () => setShowMachineSuggestions(false), showMachineSuggestions);
    useClickOutside(datePickerRef, () => setShowDatePicker(null), showDatePicker !== null);

    useEffect(() => {
        const loadMachines = async () => {
            try {
                // 1. فحص الذاكرة أو الكاش المحلي فوراً (0ms)
                const memMachines = edgeBootstrapService.getMemoryMachinesList();
                if (memMachines && Array.isArray(memMachines) && memMachines.length > 0) {
                    const list = memMachines.map((m: any) => {
                        if (Array.isArray(m)) {
                            return { id: m[0] || '', label: m[1] || m[0] || '', driver: m[3] || '' };
                        }
                        return { id: m.id || m.costCenter || '', label: m.label || m.name || m.id || '', driver: m.driver || '' };
                    });
                    setMachinesList(list);
                    swrCache.set('machines', list);
                    return;
                }

                if (!ENABLE_FIREBASE_FALLBACK) {
                    const edgeList = await edgeBootstrapService.fetchMachines();
                    if (edgeList && Array.isArray(edgeList) && edgeList.length > 0) {
                        const list = edgeList.map((m: any) => ({
                            id: m[0] || '',
                            label: m[1] || m[0] || '',
                            driver: m[3] || ''
                        }));
                        setMachinesList(list);
                        swrCache.set('machines', list);
                        return;
                    }
                }

                if (ENABLE_FIREBASE_FALLBACK && db) {
                    const machinesRef = ref(db, "قائمة_المعدات");
                    const snapshot = await get(machinesRef);
                    if (snapshot.exists()) {
                        const data = snapshot.val();
                        const list = Object.entries(data)
                            .filter(([_, machine]: [string, any]) => machine.status !== 'غير نشط')
                            .map(([key, machine]: [string, any]) => {
                                const type = machine.type || "";
                                const costCenter = machine.costCenter || key;
                                return {
                                    id: costCenter,
                                    label: `${type} ${costCenter}`.trim(),
                                    driver: machine.driver || ""
                                };
                            });
                        setMachinesList(list);
                        swrCache.set('machines', list);
                    }
                }
            } catch (error) {
                console.error("Error loading machines:", error);
            }
        };

        const loadLocations = async () => {
            try {
                const locSnap = await get(ref(db, 'workAreas'));
                if (locSnap.exists()) {
                    const raw = locSnap.val();
                    const list: { id: string, name: string }[] = [];
                    const collect = (obj: any) => {
                        if (!obj) return;
                        Object.entries(obj).forEach(([id, val]: any) => {
                            if (id === 'hide' || val?.hidden || val?.hide || val?.status === 'hidden' || val?.status === 'hide') return;
                            if (typeof val === 'object' && val !== null) {
                                list.push({ id, name: val.name || id });
                            }
                        });
                    };
                    collect(raw);
                    setLocationsList(list);
                    swrCache.set('locations', list);
                }
            } catch (error) {
                console.error("Error loading locations:", error);
            }
        };

        const init = async () => {
            await ensureAuthenticated();
            await Promise.all([loadMachines(), loadLocations()]);
        };
        init();
    }, []);

    const [isExistingEmployee, setIsExistingEmployee] = useState(false);

    // Name Search States
    const [showNameSearchModal, setShowNameSearchModal] = useState(false);
    const [nameSearchTerm, setNameSearchTerm] = useState('');
    const [nameSearchResults, setNameSearchResults] = useState<any[]>([]);
    const [isSearchingName, setIsSearchingName] = useState(false);
    const activeSearchRef = useRef<string>('');

    const handleNameSearch = async (term: string) => {
        setNameSearchTerm(term);
        activeSearchRef.current = term;

        if (term.length < 2) {
            setNameSearchResults([]);
            return;
        }

        setIsSearchingName(true);
        try {
            const nameQuery = query(
                ref(db, "قائمة_الموظفين"),
                orderByChild("name_ar"),
                startAt(term),
                endAt(term + "\uf8ff"),
                limitToFirst(20)
            );
            const snapshot = await get(nameQuery);
            // إلغاء تحديث الحالة إذا قام المستخدم بكتابة نص أحدث أثناء انتظار الشبكة
            if (activeSearchRef.current !== term) return;

            if (snapshot.exists()) {
                const results = Object.entries(snapshot.val()).map(([key, val]: [string, any]) => ({
                    key,
                    ...val
                }));
                setNameSearchResults(results);
            } else {
                setNameSearchResults([]);
            }
        } catch (error) {
            console.error("Name search error:", error);
        } finally {
            if (activeSearchRef.current === term) {
                setIsSearchingName(false);
            }
        }
    };

    const selectEmployeeFromSearch = (emp: any) => {
        setFormData(prev => ({
            ...prev,
            iqama: emp.iqama || '',
            name_ar: emp.name_ar || '',
            job_title: emp.job_title || '',
            sub_job: emp.sub_job || '',
            nationality: emp.nationality || '',
            housing: emp.housing || '',
            lastLocation: '',
            machine: '',
        }));

        setIsExistingEmployee(true);
        setIsIqamaValid(true);

        if (emp.status?.trim() === 'خارج العمل') {
            setIsRehire(true);
            setExistingId(emp.key);
            showNotification('تم اختيار موظف سابق، سيتم إعادة تفعيله', 'success');
        } else {
            setIsRehire(false);
            setExistingId(null);
            showNotification('تم استيراد بيانات الموظف المختار', 'success');
        }

        setShowNameSearchModal(false);
        setNameSearchTerm('');
        setNameSearchResults([]);
    };

    const handleIqamaChange = async (val: string) => {
        setFormData({ ...formData, iqama: val });

        if (val.length === 10) {
            setSearchingIqama(true);
            try {
                const iqamaQuery = query(ref(db, "قائمة_الموظفين"), orderByChild("iqama"), equalTo(val));
                const snapshot = await get(iqamaQuery);

                if (snapshot.exists()) {
                    const data = snapshot.val();
                    const employeeKey = Object.keys(data)[0];
                    const employeeData = data[employeeKey];

                    setIsExistingEmployee(true);
                    setFormData(prev => ({
                        ...prev,
                        name_ar: employeeData.name_ar || '',
                        job_title: employeeData.job_title || '',
                        sub_job: employeeData.sub_job || '',
                        nationality: employeeData.nationality || '',
                        housing: employeeData.housing || '',
                        lastLocation: '',
                        machine: '', // تفريغ حقل المعدة لضمان عدم استيرادها تلقائياً
                    }));

                    if (employeeData.status?.trim() === 'خارج العمل') {
                        setIsRehire(true);
                        setExistingId(employeeKey);
                        showNotification('تم العثور على موظف سابق (خارج العمل)، سيتم إعادة تفعيله', 'success');
                    } else {
                        setIsRehire(false);
                        setExistingId(null);
                        showNotification('تم استيراد بيانات الموظف (على رأس العمل حالياً)', 'success');
                    }
                } else {
                    setIsExistingEmployee(false);
                    setIsRehire(false);
                    setExistingId(null);
                }
                setIsIqamaValid(true);
            } catch (error) {
                console.error("Error searching iqama:", error);
            } finally {
                setSearchingIqama(false);
            }
        } else {
            setIsIqamaValid(false);
            setIsRehire(false);
            setIsExistingEmployee(false);
            setExistingId(null);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.name_ar) {
            showNotification('يرجى إدخال اسم الموظف', 'error');
            return;
        }

        if (!formData.iqama || formData.iqama.length !== 10) {
            showNotification('رقم الإقامة يجب أن يكون 10 أرقام بالضبط', 'error');
            return;
        }

        if (!formData.start_date) {
            showNotification('يرجى اختيار تاريخ بداية الدوام', 'error');
            return;
        }

        if (!formData.lastLocation) {
            showNotification('يرجى تحديد موقع عمل الموظف', 'error');
            return;
        }

        setLoading(true);

        // 🔑 تجديد جلسة Auth قبل أي عملية كتابة
        await ensureAuthenticated();

        // 🛡️ التحقق من تكرار رقم الإقامة (فقط للموظفين النشطين)
        try {
            const iqamaQuery = query(ref(db, "قائمة_الموظفين"), orderByChild("iqama"), equalTo(formData.iqama));
            const iqamaSnap = await get(iqamaQuery);

            if (iqamaSnap.exists()) {
                const data = iqamaSnap.val();
                const empKey = Object.keys(data)[0];
                const empData = data[empKey];

                if (empData.status === 'نشط') {
                    showNotification('عذراً، رقم الإقامة هذا مسجل لموظف نشط حالياً', 'error');
                    setLoading(false);
                    return;
                }
            }
        } catch (error) {
            console.error("Iqama check error:", error);
        }

        try {
            let targetId = existingId;

            if (!isRehire || !targetId) {
                const counterRef = ref(db, "employee_counter");
                const result = await runTransaction(counterRef, (current) => {
                    if (current === null) return 1001;
                    return current + 1;
                });
                const newNumber = result.snapshot.val();
                targetId = `person${newNumber}`;
            }

            const currentUserKey = localStorage.getItem("userKey") || "غير معروف";
            const userSnap = await get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`));
            const currentUserName = userSnap.exists() ? userSnap.val() : "مستخدم";

            const nowLog = new Date();
            const yearMonthMonth = `${nowLog.getFullYear()}-${(nowLog.getMonth() + 1).toString().padStart(2, '0')}`;
            const logDay = nowLog.getDate().toString().padStart(2, '0');
            const adminKey = localStorage.getItem("userKey") || "unknown";

            // 1. Prepare Employee Data
            const firstPeriodKey = `period_${nowLog.getTime()}`;

            // جلب بيانات الموظف القديمة لضمان عدم ضياع الـ history
            let existingHistory = {};
            let existingLoans = 0;
            let existingAbsence = 0;
            let existingCreatedAt = nowLog.getTime();

            if (targetId) {
                const empSnap = await get(ref(db, `قائمة_الموظفين/${targetId}`));
                if (empSnap.exists()) {
                    const oldData = empSnap.val();
                    existingHistory = oldData.employment_history || {};
                    existingLoans = oldData.loans || 0;
                    existingAbsence = oldData.absence || 0;
                    existingCreatedAt = oldData.createdAt || nowLog.getTime();

                    // إذا كان الموظف قديماً جداً وليس لديه سجل history، ننشئ له فترة أولى بناءً على بياناته القديمة
                    if (Object.keys(existingHistory).length === 0 && oldData.start_date) {
                        const legacyKey = `period_${nowLog.getTime() - 1000}`; // نستخدم نفس التنسيق الموحد
                        existingHistory[legacyKey] = {
                            start_date: oldData.start_date,
                            end_date: oldData.end_date || '',
                            status: 'منتهي',
                            added_by: oldData.last_modified_by || 'النظام',
                            added_at: oldData.createdAt || nowLog.getTime()
                        };
                    }
                }
            }

            // 🛡️ إنشاء حساب Auth مع ضمان عدم إفساد أو تسجيل خروج جلسة الأدمن الحالية
            let createdUid: string | null = null;
            let existingAuthUid: string | null = null;

            if (targetId) {
                const empCheckSnap = await get(ref(db, `قائمة_الموظفين/${targetId}/auth_uid`));
                if (empCheckSnap.exists()) {
                    existingAuthUid = empCheckSnap.val();
                }
            }

            if (!existingAuthUid && targetId) {
                createdUid = await createEmployeeAuthAccount(targetId, formData.password);
            }

            const { password: userPassword, ...cleanFormData } = formData;

            const finalData: any = {
                ...cleanFormData,
                status: 'نشط',
                loans: existingLoans,
                absence: existingAbsence,
                employment_history: {
                    ...existingHistory,
                    [firstPeriodKey]: {
                        start_date: formData.start_date,
                        end_date: '',
                        status: 'نشط',
                        added_by: currentUserName,
                        added_at: nowLog.getTime()
                    }
                },
                last_modified_by: currentUserName,
                createdAt: existingCreatedAt
            };

            if (createdUid) {
                finalData.auth_uid = createdUid;
            } else if (existingAuthUid) {
                finalData.auth_uid = existingAuthUid;
            }

            // 2. Prepare Atomic Updates Object
            const updates: any = {};

            // Path: New Standardized LOG
            const newLogKey = push(ref(db, `LOG/${yearMonthMonth}/${logDay}`)).key;
            updates[`LOG/${yearMonthMonth}/${logDay}/${newLogKey}`] = {
                timestamp: nowLog.getTime(),
                operation: "إدارة شؤون الموظفين",
                admin_name: currentUserName,
                admin_id: adminKey,
                employee_name: formData.name_ar,
                employee_id: targetId,
                action: isRehire ? "إعادة توظيف (Rehire)" : "إضافة موظف جديد",
                job_title: formData.job_title,
                start_date: formData.start_date
            };

            // 3. Handle Equipment Uniting (if machine selected)
            const storedMachineId = formData.machine;
            if (storedMachineId && formData.name_ar) {
                const eqRef = ref(db, `قائمة_المعدات/${storedMachineId}`);
                const eqSnap = await get(eqRef);

                if (eqSnap.exists()) {
                    const eqData = eqSnap.val();
                    const nowTs = Date.now();
                    const oldDriverId = eqData.driver;

                    // فك ارتباط السائق القديم إن وجد
                    if (oldDriverId && oldDriverId !== targetId) {
                        updates[`قائمة_الموظفين/${oldDriverId}/machine`] = "";
                        updates[`قائمة_الموظفين/${oldDriverId}/machine_updated_at`] = nowTs;
                        updates[`جدول_المعدات_والسائقين_المشترك/${oldDriverId}`] = null;

                        const oldDriverLogKey = push(ref(db, `logs/كشف الموظفين/${oldDriverId}`)).key;
                        updates[`logs/كشف الموظفين/${oldDriverId}/${oldDriverLogKey}`] = {
                            field: "machine",
                            from: storedMachineId,
                            to: "",
                            by: currentUserName,
                            time: nowLog.toLocaleString('ar-SA')
                        };
                    }

                    updates[`جدول_المعدات_والسائقين_المشترك/${storedMachineId}`] = targetId;
                    updates[`جدول_المعدات_والسائقين_المشترك/${targetId}`] = storedMachineId;
                    updates[`قائمة_المعدات/${storedMachineId}/driver`] = targetId;
                    updates[`قائمة_المعدات/${storedMachineId}/driver_updated_at`] = nowTs;
                    finalData.machine_updated_at = nowTs;

                    const equipLogKey = push(ref(db, `logs/قائمة_المعدات/${storedMachineId}`)).key;
                    updates[`logs/قائمة_المعدات/${storedMachineId}/${equipLogKey}`] = {
                        field: "driver",
                        from: oldDriverId || "",
                        to: targetId,
                        by: currentUserName,
                        time: nowLog.toLocaleString('ar-SA')
                    };
                }
            }

            // Path: Employee Record
            updates[`قائمة_الموظفين/${targetId}`] = { ...finalData, machine: storedMachineId };

            // 🔥 EXECUTE ALL UPDATES AT ONCE ATOMICALLY
            await update(ref(db), updates);

            showNotification(isRehire ? 'تمت إعادة التوظيف بنجاح' : 'تمت الإضافة بنجاح', 'success');

            // Reset
            setFormData({
                name_ar: '',
                job_title: '',
                sub_job: '',
                lastLocation: '',
                start_date: '',
                machine: '',
                end_date: '',
                nationality: '',
                iqama: '',
                housing: '',
                housing_in: '',
                housing_out: '',
                password: ''
            });
            setIsIqamaValid(false);
            setIsRehire(false);
            setIsExistingEmployee(false);
            setExistingId(null);
            setShowMore(false);
        } catch (error: any) {
            console.error("Error adding employee:", error);
            const errCode = error?.code || '';
            const errMessage = error?.message || (typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error));
            const fullDetails = `الرمز / الكود: ${errCode || 'غير محدد'}\nالرسالة: ${errMessage}\n\nتتبع الأخطاء والتفاصيل:\n${error?.stack || 'لا تتوفر تفاصيل تتبع إضافية'}`;

            setErrorModal({
                title: isRehire ? 'فشل إعادة توظيف الموظف' : 'فشل إضافة الموظف',
                details: fullDetails
            });
            showNotification(isRehire ? 'فشل عملية إعادة التوظيف — تم فتح نافذة التفاصيل' : 'فشل عملية إضافة الموظف — تم فتح نافذة التفاصيل', 'error');
        } finally {
            setLoading(false);
        }
    };

    const showNotification = (msg: string, type: 'success' | 'error') => {
        setNotification({ msg, type });
        setTimeout(() => setNotification(null), 3000);
    };

    const handleMachineInput = (val: string) => {
        setFormData({ ...formData, machine: val });
        setShowMachineSuggestions(true);
    };

    const renderDatePicker = (field: string) => {
        const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const dates = [];
        const today = new Date();

        for (let i = 0; i < 90; i++) {
            const date = new Date();
            date.setDate(today.getDate() - i);
            const str = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
            const dayName = i === 0 ? 'اليوم' : arabicDays[date.getDay()];
            dates.push({ str, dayName });
        }

        return (
            <div ref={datePickerRef} className="absolute bottom-full mb-2 left-0 w-full bg-white border-2 border-blue-500 rounded-2xl shadow-2xl z-100 max-h-60 overflow-y-auto animate-fade-in">
                {dates.map((d, idx) => (
                    <div
                        key={idx}
                        onClick={() => {
                            setFormData({ ...formData, [field]: d.str });
                            setShowDatePicker(null);
                        }}
                        className="p-3 hover:bg-blue-50 cursor-pointer font-bold border-b border-gray-50 flex justify-between items-center"
                    >
                        <span>{d.str}</span>
                        <span className="text-blue-400 text-xs">{d.dayName}</span>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-slate-50 flex flex-col font-sans mb-10 text-right" dir="rtl">
            {/* Header */}
            <div className="bg-primary text-white p-6 pb-12 rounded-b-[2.5rem] shadow-xl relative shrink-0">
                <div className="flex items-center gap-4 mb-4">
                    <button onClick={() => navigate('/?tab=tasks')} className="p-2 hover:bg-white/20 rounded-xl transition-colors">
                        <ArrowRight size={24} />
                    </button>
                    <h1 className="text-2xl font-black">إضافة موظف</h1>
                </div>
            </div>

            {/* Form Container */}
            <div className="px-4 -mt-8 relative z-10 max-w-2xl mx-auto w-full flex-1">
                <form onSubmit={handleSubmit} className="bg-white rounded-3xl shadow-2xl p-4 sm:p-6 space-y-3.5 border border-blue-50">

                    <h3 className="text-center font-black text-gray-400 text-sm mb-4 uppercase tracking-widest">المعلومات الأساسية</h3>

                    {/* IQAMA (Moved to Top) */}
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <Hash className={`absolute right-4 top-1/2 -translate-y-1/2 ${isIqamaValid ? 'text-emerald-500' : 'text-blue-500'}`} size={18} />
                            <input
                                type="text"
                                placeholder="أدخل رقم الإقامة أو إبحث بالاسم"
                                value={formData.iqama}
                                onChange={(e) => handleIqamaChange(e.target.value)}
                                className={`w-full bg-gray-50 border-2 ${isIqamaValid ? 'border-emerald-500 bg-white' : 'border-blue-200'} rounded-xl py-3 px-4 pr-11 outline-none font-bold text-sm focus:border-blue-500 transition-all`}
                            />
                            {searchingIqama && (
                                <div className="absolute left-4 top-1/2 -translate-y-1/2">
                                    <Loader2 className="animate-spin text-blue-500" size={16} />
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowNameSearchModal(true)}
                            className="bg-blue-100 text-blue-600 px-4 rounded-xl hover:bg-blue-200 transition-colors flex items-center gap-2 font-bold text-xs shrink-0"
                        >
                            <Search size={16} />
                            <span>بحث بالاسم</span>
                        </button>
                    </div>

                    <div className={`space-y-3 transition-all duration-500 ${isIqamaValid ? 'opacity-100' : 'opacity-40 pointer-events-none grayscale'}`}>
                        {/* Name */}
                        <div className="space-y-1">
                            <div className="relative">
                                <User className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500" size={18} />
                                <input
                                    type="text"
                                    placeholder="الاسم"
                                    value={formData.name_ar}
                                    onChange={(e) => setFormData({ ...formData, name_ar: e.target.value })}
                                    readOnly={isExistingEmployee}
                                    className={`w-full bg-gray-50 border-2 ${formData.name_ar ? 'border-emerald-500 bg-white' : 'border-transparent'} rounded-xl py-3 px-4 pr-11 outline-none font-bold text-sm focus:border-blue-500 transition-all ${isExistingEmployee ? 'cursor-not-allowed opacity-80' : ''}`}
                                />
                            </div>
                        </div>

                        {/* Start Date */}
                        <div className="space-y-1">
                            <label className="text-[11px] font-bold text-gray-500 pr-1">تاريخ بداية الدوام</label>
                            <DatePickerSelector
                                selectedDate={formData.start_date}
                                onDateChange={(newDate) => setFormData(prev => ({ ...prev, start_date: newDate }))}
                                daysCount={90}
                                className="w-full"
                                buttonClassName={`w-full bg-gray-50 border-2 ${formData.start_date ? 'border-emerald-500 bg-white' : 'border-blue-200'} rounded-xl py-3 px-4 outline-none font-bold text-sm text-slate-800 shadow-none hover:bg-white justify-between`}
                            />
                        </div>

                        {/* Location Picker */}
                        <div className="relative" ref={locationPickerRef}>
                            <MapPin className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={18} />
                            <input
                                type="text"
                                placeholder="موقع العمل ..."
                                value={locationsList.find(l => l.id === formData.lastLocation)?.name || ''}
                                readOnly
                                onClick={() => setShowLocationPicker(!showLocationPicker)}
                                className={`w-full bg-gray-50 border-2 ${formData.lastLocation ? 'border-emerald-500 bg-white' : 'border-rose-300'} rounded-xl py-3 px-4 pr-11 outline-none font-bold text-sm cursor-pointer focus:border-blue-500 transition-all`}
                            />
                            <ChevronDown className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={16} />

                            {showLocationPicker && (
                                <div className="absolute bottom-full mb-2 left-0 w-full bg-white border-2 border-blue-500 rounded-2xl shadow-2xl z-100 max-h-48 overflow-y-auto animate-fade-in">
                                    {locationsList.length === 0 ? (
                                        <div className="p-4 text-center text-gray-400 text-sm font-bold">لا توجد مواقع مسجلة</div>
                                    ) : (
                                        locationsList.map((loc) => (
                                            <div
                                                key={loc.id}
                                                onClick={() => {
                                                    setFormData({ ...formData, lastLocation: loc.id });
                                                    setShowLocationPicker(false);
                                                }}
                                                className={`p-3 hover:bg-blue-50 cursor-pointer font-bold border-b border-gray-50 text-gray-700 flex justify-between items-center ${formData.lastLocation === loc.id ? 'bg-blue-50 text-blue-700' : ''}`}
                                            >
                                                <span>{loc.name}</span>
                                                {formData.lastLocation === loc.id && <CheckCircle size={14} className="text-emerald-500" />}
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Unified Profession Picker */}
                        <div className="relative" ref={subJobPickerRef}>
                            <Briefcase className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={18} />
                            <input
                                type="text"
                                placeholder="اختر المهنة..."
                                value={formData.sub_job || formData.job_title}
                                readOnly
                                onClick={() => setShowSubJobPicker(!showSubJobPicker)}
                                className={`w-full bg-gray-50 border-2 ${formData.sub_job || formData.job_title ? 'border-emerald-500 bg-white' : 'border-blue-200'} rounded-xl py-3 px-4 pr-11 outline-none font-bold text-sm cursor-pointer focus:border-blue-500 transition-all`}
                            />
                            <ChevronDown className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={16} />

                            {showSubJobPicker && (
                                <div className="absolute bottom-full mb-2 left-0 w-full bg-white border-2 border-blue-500 rounded-2xl shadow-2xl z-100 animate-fade-in overflow-hidden max-h-60 overflow-y-auto">
                                    {SUB_JOB_OPTIONS.map((title) => (
                                        <div
                                            key={title}
                                            onClick={() => {
                                                const mainJob = getPrimaryJobTitle(title);
                                                setFormData(prev => ({ ...prev, job_title: mainJob, sub_job: title }));
                                                setShowSubJobPicker(false);
                                            }}
                                            className={`p-3 hover:bg-blue-50 cursor-pointer font-bold border-b border-gray-50 text-gray-700 flex justify-between items-center ${formData.sub_job === title ? 'bg-blue-50 text-blue-700' : ''}`}
                                        >
                                            <span>{title}</span>
                                            {formData.sub_job === title && <CheckCircle size={14} className="text-emerald-500" />}
                                        </div>
                                    ))}
                                    <div
                                        onClick={() => {
                                            setFormData(prev => ({ ...prev, job_title: '', sub_job: '' }));
                                            setShowSubJobPicker(false);
                                        }}
                                        className="p-3 hover:bg-red-50 cursor-pointer font-bold border-t border-gray-100 text-red-600 flex justify-between items-center"
                                    >
                                        <span>إلغاء الاختيار</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Machine with Selection Only */}
                        <div className="relative">
                            <Truck className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500" size={18} />
                            <input
                                type="text"
                                placeholder="المعدة..."
                                value={formData.machine === 'خارجي' ? 'خارجي' : (machinesList.find(m => m.id === formData.machine)?.label || (formData.machine ? formData.machine : 'لا يوجد معدة'))}
                                readOnly
                                onClick={() => setShowMachineSuggestions(true)}
                                className={`w-full bg-gray-50 border-2 ${formData.machine ? 'border-emerald-500 bg-white' : 'border-blue-200'} rounded-xl py-3 px-4 pr-11 outline-none font-bold text-sm cursor-pointer focus:border-blue-500 transition-all`}
                            />
                        </div>

                        <MachineSelectionModal
                            isOpen={showMachineSuggestions}
                            onClose={() => setShowMachineSuggestions(false)}
                            allMachines={machinesList}
                            currentMachineId={formData.machine}
                            onConfirmMachine={(mId) => {
                                setFormData(prev => ({ ...prev, machine: mId }));
                                setShowMachineSuggestions(false);
                            }}
                            onClearMachine={() => {
                                setFormData(prev => ({ ...prev, machine: '' }));
                                setShowMachineSuggestions(false);
                            }}
                        />
                    </div>


                    {/* More Fields Toggle */}
                    <div id="moreFields" className={`space-y-3 overflow-hidden transition-all duration-500 ${showMore ? 'max-h-[1000px] opacity-100 mt-3' : 'max-h-0 opacity-0'}`}>
                        <div className="h-px bg-gray-100 my-2" />

                        {/* End Date */}
                        <div className="space-y-1">
                            <label className="text-[11px] font-bold text-gray-500 pr-1">تاريخ نهاية الدوام</label>
                            <DatePickerSelector
                                selectedDate={formData.end_date}
                                onDateChange={(newDate) => setFormData(prev => ({ ...prev, end_date: newDate }))}
                                daysCount={90}
                                dropUp={true}
                                className="w-full"
                                buttonClassName={`w-full bg-gray-50 border-2 ${formData.end_date ? 'border-emerald-500 bg-white' : 'border-transparent'} rounded-xl py-3 px-4 outline-none font-bold text-sm text-slate-800 shadow-none hover:bg-white justify-between`}
                            />
                        </div>

                        <div className="relative">
                            <MapPin className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500" size={18} />
                            <input type="text" placeholder="الجنسية" value={formData.nationality} onChange={(e) => setFormData({ ...formData, nationality: e.target.value })} className="w-full bg-gray-50 border-2 border-transparent rounded-xl py-3 px-4 pr-11 font-bold text-sm outline-none focus:border-blue-500" />
                        </div>

                        <div className="relative">
                            <MapPin className="absolute right-4 top-1/2 -translate-y-1/2 text-blue-500" size={18} />
                            <input type="text" placeholder="السكن" value={formData.housing} onChange={(e) => setFormData({ ...formData, housing: e.target.value })} className="w-full bg-gray-50 border-2 border-transparent rounded-xl py-3 px-4 pr-11 font-bold text-sm outline-none focus:border-blue-500" />
                        </div>

                        <div className="space-y-1">
                            <label className="text-[11px] font-bold text-gray-500 pr-1">تاريخ دخول السكن</label>
                            <DatePickerSelector
                                selectedDate={formData.housing_in}
                                onDateChange={(newDate) => setFormData(prev => ({ ...prev, housing_in: newDate }))}
                                daysCount={90}
                                dropUp={true}
                                className="w-full"
                                buttonClassName="w-full bg-gray-50 border-2 border-transparent rounded-xl py-3 px-4 outline-none font-bold text-sm text-slate-800 shadow-none hover:bg-white justify-between"
                            />
                        </div>

                        <div className="space-y-1">
                            <label className="text-[11px] font-bold text-gray-500 pr-1">تاريخ الخروج من السكن</label>
                            <DatePickerSelector
                                selectedDate={formData.housing_out}
                                onDateChange={(newDate) => setFormData(prev => ({ ...prev, housing_out: newDate }))}
                                daysCount={90}
                                dropUp={true}
                                className="w-full"
                                buttonClassName="w-full bg-gray-50 border-2 border-transparent rounded-xl py-3 px-4 outline-none font-bold text-sm text-slate-800 shadow-none hover:bg-white justify-between"
                            />
                        </div>
                    </div>

                    <div className="flex justify-center mt-2">
                        <button
                            type="button"
                            onClick={() => setShowMore(!showMore)}
                            className="text-blue-500 font-bold text-sm flex items-center gap-1 hover:underline underline-offset-4"
                        >
                            {showMore ? 'عرض أقل' : 'عرض المزيد من الحقول'}
                            {showMore ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className={`w-full py-3.5 rounded-xl font-black text-base flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95 disabled:opacity-50 mt-2 ${isRehire ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                    >
                        {loading ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
                        <span>{isRehire ? 'اعادة توظيف' : 'حفظ موظف'}</span>
                    </button>
                </form>
            </div>
            {/* Name Search Modal */}
            {showNameSearchModal && (
                <div className="fixed inset-0 z-10000 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
                        <div className="p-6 bg-primary text-white flex justify-between items-center shrink-0">
                            <h2 className="text-xl font-black">البحث عن موظف سابق</h2>
                            <button onClick={() => setShowNameSearchModal(false)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
                                <X size={24} />
                            </button>
                        </div>

                        <div className="p-4 border-b shrink-0">
                            <div className="relative">
                                <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
                                <input
                                    type="text"
                                    autoFocus
                                    placeholder="اكتب اسم الموظف هنا..."
                                    value={nameSearchTerm}
                                    onChange={(e) => handleNameSearch(e.target.value)}
                                    className="w-full bg-gray-50 border-2 border-gray-100 rounded-2xl py-3 px-4 pr-12 outline-none font-bold focus:border-blue-500 transition-all"
                                />
                                {isSearchingName && (
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2">
                                        <Loader2 className="animate-spin text-blue-500" size={18} />
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            {nameSearchResults.length > 0 ? (
                                nameSearchResults.map((emp) => (
                                    <button
                                        key={emp.key}
                                        type="button"
                                        onClick={() => selectEmployeeFromSearch(emp)}
                                        className="w-full flex items-center gap-3 p-3 rounded-2xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-all text-right group"
                                    >
                                        <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 shrink-0 group-hover:bg-blue-200 transition-colors">
                                            <User size={18} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h3 className="font-black text-gray-800 text-xs truncate leading-tight">{emp.name_ar}</h3>
                                            <div className="text-[10px] text-gray-500 flex gap-2 mt-0.5 font-bold">
                                                <span>{emp.iqama}</span>
                                                <span className="text-blue-400">•</span>
                                                <span>{emp.job_title}</span>
                                            </div>
                                        </div>
                                        <div className={`px-2.5 py-1 rounded-full text-[10px] font-black shrink-0 ${emp.status === 'نشط' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                                            {emp.status === 'نشط' ? 'على رأس العمل' : 'خارج العمل'}
                                        </div>
                                    </button>
                                ))
                            ) : nameSearchTerm.length >= 2 ? (
                                <div className="text-center py-10 text-gray-400">
                                    <Search size={48} className="mx-auto mb-4 opacity-20" />
                                    <p className="font-bold">لم يتم العثور على نتائج لـ "{nameSearchTerm}"</p>
                                </div>
                            ) : (
                                <div className="text-center py-10 text-gray-400">
                                    <p className="font-bold">ابدأ بكتابة حرفين على الأقل للبحث...</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* نافذة عرض تفاصيل الخطأ المباشرة على شاشة الهاتف */}
            {errorModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4 animate-fade-in" dir="rtl">
                    <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border-2 border-red-500 overflow-hidden flex flex-col max-h-[85vh]">
                        <div className="flex justify-between items-center pb-4 border-b border-gray-100 mb-4">
                            <div className="flex items-center gap-3">
                                <div className="p-2.5 bg-red-100 text-red-600 rounded-2xl">
                                    <ShieldAlert size={24} />
                                </div>
                                <div>
                                    <h3 className="font-black text-gray-900 text-base">{errorModal.title}</h3>
                                    <p className="text-xs text-red-500 font-bold mt-0.5">تفاصيل الاستثناء المباشر من الهاتف</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setErrorModal(null)}
                                className="p-2 text-gray-400 hover:text-gray-600 rounded-full bg-gray-100 hover:bg-gray-200 transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto bg-gray-900 text-red-400 p-4 rounded-2xl font-mono text-xs leading-relaxed select-text border border-gray-800 dir-ltr text-left mb-4 whitespace-pre-wrap break-all">
                            {errorModal.details}
                        </div>

                        <div className="flex gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => {
                                    navigator.clipboard.writeText(errorModal.details);
                                    setCopiedError(true);
                                    setTimeout(() => setCopiedError(false), 2000);
                                }}
                                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-2xl transition-all flex items-center justify-center gap-2 text-xs shadow-lg shadow-red-200 active:scale-95 cursor-pointer"
                            >
                                {copiedError ? <Check size={16} /> : <Copy size={16} />}
                                <span>{copiedError ? 'تم النسخ!' : 'نسخ تفاصيل الخطأ'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setErrorModal(null)}
                                className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 px-5 rounded-2xl transition-all text-xs cursor-pointer"
                            >
                                إغلاق
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
