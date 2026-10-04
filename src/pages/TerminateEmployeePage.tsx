import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, ensureAuthenticated } from '../services/firebase';
import { ref, get, set, push, update, query, orderByChild, equalTo, startAt } from 'firebase/database';
import { ArrowRight, Search, User, Calendar, Loader2, X, Save, CheckCircle, MapPin, RotateCcw } from 'lucide-react';
import { isAdmin } from '../constants';
import { CustomPickerModal } from '../components/CustomPickerModal';
import { useToast } from '../context/ToastContext';

export const TerminateEmployeePage: React.FC = () => {
    const navigate = useNavigate();
    const [employees, setEmployees] = useState<any[]>([]);
    const [filteredEmployees, setFilteredEmployees] = useState<any[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Location filtering states
    const [allLocationsList, setAllLocationsList] = useState<string[]>([]);
    const [selectedLocation, setSelectedLocation] = useState('الكل');
    const [locationMap, setLocationMap] = useState<Record<string, string>>({});
    const [areapermissions, setareapermissions] = useState<Record<string, { mode: 'read' | 'edit' }>>({});
    const [showLocationModal, setShowLocationModal] = useState(false);
    const [showStatusModal, setShowStatusModal] = useState(false);
    const [statusFilter, setStatusFilter] = useState<'active' | 'inactive'>('active');

    // Selection & Date State
    const [selectedEmployee, setSelectedEmployee] = useState<any | null>(null);
    const [endDate, setEndDate] = useState('');
    const [showDatePicker, setShowDatePicker] = useState(false);
    const { showToast, hideToast } = useToast();
    const setNotification = (n: { msg: string, type: 'success' | 'error' | 'info' | 'warning' } | null) => {
        if (!n) hideToast();
        else showToast(n.msg, n.type);
    };
    const [currentUser, setCurrentUser] = useState<any | null>(null);
    const [tooltipEmpKey, setTooltipEmpKey] = useState<string | null>(null);

    const datePickerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchEmployees();
        loadCurrentUser();
    }, []);

    const loadCurrentUser = async () => {
        try {
            const userKey = localStorage.getItem("userKey");
            if (userKey) {
                const userSnap = await get(ref(db, `قائمة_الموظفين/${userKey}`));
                if (userSnap.exists()) {
                    setCurrentUser(userSnap.val());
                }
            }
        } catch (error) {
            console.error("Error loading current user:", error);
        }
    };

    useEffect(() => {
        // Force body background to white when this page is active
        const originalBackground = document.body.style.background;
        const originalBackgroundImage = document.body.style.backgroundImage;
        const originalBackgroundColor = document.body.style.backgroundColor;

        document.body.style.background = 'white';
        document.body.style.backgroundImage = 'none';
        document.body.style.backgroundColor = 'white';

        return () => {
            // Restore original background when leaving the page
            document.body.style.background = originalBackground;
            document.body.style.backgroundImage = originalBackgroundImage;
            document.body.style.backgroundColor = originalBackgroundColor;
        };
    }, []);

    const fetchEmployees = async () => {
        setLoading(true);
        // 🔑 تجديد جلسة Auth
        await ensureAuthenticated();
        try {
            const currentUserKey = localStorage.getItem("userKey") || "";

            const [locSnap, permSnap] = await Promise.all([
                get(ref(db, 'workAreas')),
                get(ref(db, `areapermissions/${currentUserKey}`))
            ]);

            const perms = permSnap.exists() ? permSnap.val() : null;
            setareapermissions(perms || {});

            const availableLocIds: string[] = [];
            const allLocIds: string[] = [];
            const mapping: Record<string, string> = {};

            if (locSnap.exists()) {
                const rawLocs = locSnap.val();
                const collect = (obj: any) => {
                    if (!obj) return;
                    Object.entries(obj).forEach(([id, val]: any) => {
                        if (id === 'hide' || val?.hidden || val?.hide || val?.status === 'hidden' || val?.status === 'hide') return;
                        if (typeof val === 'object' && val !== null) {
                            const name = val.name || id;
                            mapping[id] = name;
                            allLocIds.push(id);
                            if (perms && perms[id]) {
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

                setAllLocationsList(availableLocIds.length > 0 ? availableLocIds : allLocIds);
                setLocationMap(mapping);
            }

            const employeesMap: Record<string, any> = {};

            // جلب كافة الموظفين بدون قيود (نشطين وغير نشطين لجميع المواقع)
            const snap = await get(ref(db, "قائمة_الموظفين"));
            if (snap.exists()) {
                snap.forEach(child => {
                    const val = child.val();
                    if (val?.status === 'مخفي' || val?.status === 'hidden' || val?.status === 'hide' || val?.hidden || val?.hide) return;
                    employeesMap[child.key!] = {
                        key: child.key,
                        ...val,
                        name_ar: val.name_ar || "بدون اسم",
                        iqama: val.iqama || "---",
                        job_title: val.job_title || "---",
                        imageurl: val.imageurl || "",
                        start_date: val.start_date || "",
                        end_date: val.end_date || "",
                        machine: val.machine || "",
                        lastLocation: val.lastLocation || "",
                        status: val.status || "",
                        last_modified_by: val.last_modified_by || ""
                    };
                });
            }

            const list = Object.values(employeesMap).sort((a: any, b: any) => {
                // موظفين على رأس العمل أولاً، ثم من انتهى دوامهم
                if (!a.end_date && b.end_date) return -1;
                if (a.end_date && !b.end_date) return 1;

                // إذا كان الموظفان منتهيان، نرتبهم بـ تاريخ النهاية تنازلياً (الأحدث أولاً)
                if (a.end_date && b.end_date) {
                    return b.end_date.localeCompare(a.end_date);
                }

                // ترتيب أبجدي للموظفين النشطين
                return a.name_ar.localeCompare(b.name_ar, 'ar');
            });

            setEmployees(list);
            setFilteredEmployees(list);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const results = employees.filter(emp => {
            const term = searchTerm.toLowerCase();

            // Enhanced search with location filtering
            const empLastLocationId = emp['lastLocation'] || '';
            const lastLocName = locationMap[empLastLocationId] || empLastLocationId;

            const matchesSearch = (
                emp.name_ar?.toLowerCase().includes(term) ||
                emp.iqama?.toLowerCase().includes(term) ||
                emp.job_title?.toLowerCase().includes(term) ||
                lastLocName.toLowerCase().includes(term)
            );

            // Location filter - match by ID only (same as attendance report)
            const matchesLocation = selectedLocation === 'الكل' ? true :
                (empLastLocationId === selectedLocation);

            const matchesStatus = statusFilter === 'active' ? emp.status === 'نشط' : emp.status !== 'نشط';

            return matchesSearch && matchesLocation && matchesStatus;
        });
        setFilteredEmployees(results);
    }, [searchTerm, employees, selectedLocation, locationMap, statusFilter]);

    const [pendingEndDate, setPendingEndDate] = useState('');

    const restoreEmployee = async (employee: any) => {
        if (!employee || saving) return;

        setSaving(true);
        try {
            const currentUserKey = localStorage.getItem("userKey") || "غير معروف";
            const userSnap = await get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`));
            const currentUserName = userSnap.exists() ? userSnap.val() : "مستخدم";

            const nowLog = new Date();
            const yearMonthMonth = `${nowLog.getFullYear()}-${(nowLog.getMonth() + 1).toString().padStart(2, '0')}`;
            const logDay = nowLog.getDate().toString().padStart(2, '0');
            const adminKey = localStorage.getItem("userKey") || "unknown";

            const updates: any = {};
            updates[`قائمة_الموظفين/${employee.key}/end_date`] = null;
            updates[`قائمة_الموظفين/${employee.key}/status`] = 'نشط';
            updates[`قائمة_الموظفين/${employee.key}/last_modified_by`] = currentUserName;

            // تحديث سجل فترات الدوام
            const empSnap = await get(ref(db, `قائمة_الموظفين/${employee.key}`));
            if (empSnap.exists()) {
                const empData = empSnap.val();
                const history = empData.employment_history || {};

                // البحث عن الفترة المنتهية التي تطابق تاريخ نهاية الدوام الحالي
                const terminatedPeriodKey = Object.keys(history).find(key =>
                    history[key].status === 'منتهي' &&
                    history[key].end_date === employee.end_date
                );
                if (terminatedPeriodKey) {
                    updates[`قائمة_الموظفين/${employee.key}/employment_history/${terminatedPeriodKey}/end_date`] = null;
                    updates[`قائمة_الموظفين/${employee.key}/employment_history/${terminatedPeriodKey}/status`] = 'نشط';
                    updates[`قائمة_الموظفين/${employee.key}/employment_history/${terminatedPeriodKey}/restored_by`] = currentUserName;
                }
            }

            // إضافة سجل LOG الموحد
            const newLogKey = push(ref(db, `LOG/${yearMonthMonth}/${logDay}`)).key;
            updates[`LOG/${yearMonthMonth}/${logDay}/${newLogKey}`] = {
                timestamp: nowLog.getTime(),
                operation: "إدارة شؤون الموظفين",
                admin_name: currentUserName,
                admin_id: adminKey,
                employee_name: employee.name_ar,
                employee_id: employee.key,
                action: "استعادة موظف للعمل",
                details: `تم إلغاء توقيف الموظف وإعادته للعمل`
            };

            // 🔥 تنفيذ التحديث الذري
            await update(ref(db), updates);

            // تحديث الموظف في القائمة المحلية
            setEmployees(prev => prev.map(e =>
                e.key === employee.key
                    ? { ...e, end_date: null, status: 'نشط' }
                    : e
            ));

            showNotification('تم استعادة الموظف بنجاح', 'success');
        } catch (error) {
            console.error(error);
            showNotification('حدث خطأ، حاول ثانية', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleFastTerminate = async () => {
        if (!selectedEmployee || !pendingEndDate) return;

        setSaving(true);
        try {
            const currentUserKey = localStorage.getItem("userKey") || "غير معروف";
            const userSnap = await get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`));
            const currentUserName = userSnap.exists() ? userSnap.val() : "مستخدم";

            const nowLog = new Date();
            const yearMonthMonth = `${nowLog.getFullYear()}-${(nowLog.getMonth() + 1).toString().padStart(2, '0')}`;
            const logDay = nowLog.getDate().toString().padStart(2, '0');
            const adminKey = localStorage.getItem("userKey") || "unknown";

            const updates: any = {};
            updates[`قائمة_الموظفين/${selectedEmployee.key}/end_date`] = pendingEndDate;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/status`] = 'خارج العمل';
            updates[`قائمة_الموظفين/${selectedEmployee.key}/last_modified_by`] = currentUserName;

            // تحديث سجل فترات الدوام
            const empSnap = await get(ref(db, `قائمة_الموظفين/${selectedEmployee.key}`));
            if (empSnap.exists()) {
                const empData = empSnap.val();
                const history = empData.employment_history || {};

                // البحث عن الفترة النشطة لإغلاقها
                const activePeriodKey = Object.keys(history).find(key => history[key].status === 'نشط');
                if (activePeriodKey) {
                    updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/end_date`] = pendingEndDate;
                    updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/status`] = 'منتهي';
                    updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/terminated_by`] = currentUserName;
                }
            }

            // 1. New Standardized LOG
            const newLogKey = push(ref(db, `LOG/${yearMonthMonth}/${logDay}`)).key;
            updates[`LOG/${yearMonthMonth}/${logDay}/${newLogKey}`] = {
                timestamp: nowLog.getTime(),
                operation: "إدارة شؤون الموظفين",
                admin_name: currentUserName,
                admin_id: adminKey,
                employee_name: selectedEmployee.name_ar,
                employee_id: selectedEmployee.key,
                action: "تسجيل نهاية دوام موظف",
                termination_date: pendingEndDate
            };

            // 3. Unlink from Shared Table & Equipment
            if (selectedEmployee.machine) {
                const machinesSnapshot = await get(ref(db, "قائمة_المعدات"));
                const machines = machinesSnapshot.val() || {};
                const empMachine = (selectedEmployee.machine || '').trim();
                const matched = Object.entries(machines).find(
                    ([key, eq]: [string, any]) => {
                        const costCenter = eq.costCenter || key;
                        const full = `${eq.type || ""} ${costCenter}`.trim();
                        return key === empMachine || costCenter === empMachine || full === empMachine;
                    }
                );

                const nowTs = Date.now();
                updates[`قائمة_الموظفين/${selectedEmployee.key}/machine_updated_at`] = nowTs;

                if (matched) {
                    const [costCenter, eqData]: [string, any] = matched;
                    updates[`جدول_المعدات_والسائقين_المشترك/${costCenter}`] = null;
                    updates[`جدول_المعدات_والسائقين_المشترك/${selectedEmployee.key}`] = null;
                    updates[`قائمة_المعدات/${costCenter}/driver`] = "";
                    updates[`قائمة_المعدات/${costCenter}/driver_updated_at`] = nowTs;
                }
            }

            // 🔥 EXECUTE ALL UPDATES AT ONCE (ATOMIC)
            await update(ref(db), updates);
            // ----------------------------------------

            // تحديث الموظف في القائمة المحلية بدلاً من حذفه ليبقى ظاهراً
            setEmployees(prev => prev.map(e =>
                e.key === selectedEmployee.key
                    ? { ...e, end_date: pendingEndDate, status: 'خارج العمل' }
                    : e
            ));

            showNotification('تم الحفظ بنجاح', 'success');
            setSelectedEmployee(null);
            setPendingEndDate('');
        } catch (error) {
            console.error(error);
            showNotification('حدث خطأ، حاول ثانية', 'error');
        } finally {
            setSaving(false);
        }
    };

    const showNotification = (msg: string, type: 'success' | 'error') => {
        setNotification({ msg, type });
        setTimeout(() => setNotification(null), 3000);
    };

    const dateListRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (selectedEmployee) {
            if (!pendingEndDate) {
                const today = new Date();
                const str = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
                setPendingEndDate(str);
            }
            setTimeout(() => {
                const selectedEl = dateListRef.current?.querySelector('[data-selected="true"]') as HTMLElement;
                if (selectedEl && dateListRef.current) {
                    const top = selectedEl.offsetTop - dateListRef.current.clientHeight / 2 + selectedEl.clientHeight / 2;
                    dateListRef.current.scrollTo({ top, behavior: 'smooth' });
                }
            }, 150);
        }
    }, [selectedEmployee]);

    const renderDatePicker = () => {
        if (!selectedEmployee) return null;
        const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const dates = [];
        const today = new Date();

        // الحصول على تاريخ بداية الدوام للموظف المختار
        const startDateStr = selectedEmployee.start_date;
        const startDate = startDateStr ? new Date(startDateStr + 'T00:00:00') : null;

        // توليد التواريخ من اليوم تنازلياً حتى تاريخ البداية (بحد أقصى 90 يوم)
        for (let i = 0; i < 90; i++) {
            const date = new Date();
            date.setDate(today.getDate() - i);

            // التوقف إذا وصلنا لتاريخ قبل تاريخ البداية
            if (startDate && date < startDate) break; // التاريخان كلاهما بالتوقيت المحلي الآن

            const str = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
            const isToday = i === 0;
            const dayName = isToday ? 'اليوم' : arabicDays[date.getDay()];
            dates.push({ str, dayName, isToday, dateObj: date });
        }

        return (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-100 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in no-print">
                <div className="bg-white w-full max-w-md rounded-t-[2.5rem] sm:rounded-4xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">

                    {/* Header - Simple & Clean */}
                    <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-white shrink-0">
                        <div className="flex flex-col text-right">
                            <h3 className="text-lg font-bold text-slate-800">تاريخ التوقيف</h3>
                            <p className="text-[10px] text-slate-400 font-bold">{selectedEmployee.name_ar}</p>
                        </div>
                        <button
                            onClick={() => { setSelectedEmployee(null); setPendingEndDate(''); }}
                            className="w-10 h-10 flex items-center justify-center bg-slate-50 text-slate-400 hover:bg-rose-50 hover:text-rose-500 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Wheel List Selection */}
                    <div ref={dateListRef} className="p-4 overflow-y-auto max-h-[55vh] space-y-2 no-scrollbar bg-slate-50 flex-1 scroll-smooth">
                        {dates.map((d, idx) => {
                            const isSelected = pendingEndDate === d.str;
                            const dayNum = d.dateObj.getDate();
                            const monthNum = d.dateObj.getMonth() + 1;
                            const yearNum = d.dateObj.getFullYear();
                            const displayStr = `${dayNum}-${monthNum}-${yearNum} ${d.dayName}`;

                            return (
                                <button
                                    key={idx}
                                    data-selected={isSelected}
                                    onClick={() => setPendingEndDate(d.str)}
                                    className={`w-full flex items-center justify-between p-3.5 px-5 rounded-2xl transition-all border font-bold text-sm text-right ${
                                        isSelected
                                            ? 'bg-primary text-white border-primary shadow-lg shadow-blue-500/20 scale-[1.02] z-10 font-black'
                                            : 'bg-white text-slate-700 border-slate-100 hover:bg-blue-50 hover:border-blue-200'
                                    }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`p-2 rounded-xl text-xs font-black ${isSelected ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                            <Calendar size={16} />
                                        </div>
                                        <span className="text-sm font-black">{displayStr}</span>
                                    </div>
                                    {isSelected && <CheckCircle size={18} className="text-white" />}
                                </button>
                            );
                        })}
                    </div>

                    {/* Footer - Minimalist */}
                    <div className="p-5 bg-white border-t border-gray-100 shrink-0">
                        <button
                            onClick={handleFastTerminate}
                            disabled={!pendingEndDate || saving}
                            className={`w-full py-4 rounded-2xl font-black text-base flex items-center justify-center gap-2 shadow-lg transition-all active:scale-[0.95]
                                ${pendingEndDate
                                    ? 'bg-primary text-white hover:bg-blue-800'
                                    : 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
                                }
                            `}
                        >
                            {saving ? <Loader2 size={20} className="animate-spin" /> : <Save size={18} />}
                            <span>حـفظ التـاريخ</span>
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="h-screen bg-white text-right font-sans flex flex-col overflow-hidden" dir="rtl">
            {/* Header - Compact Sticky Style */}
            <div className="bg-primary text-white p-2 z-50 shadow-lg shrink-0">
                <div className="flex items-center gap-2 mb-1.5 px-1">
                    <button onClick={() => navigate('/?tab=tasks')} className="p-1.5 hover:bg-white/10 rounded-lg">
                        <ArrowRight size={18} />
                    </button>

                    <div className="flex-1 relative flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute right-2 top-1.5 text-white/40" size={14} />
                            <input
                                type="text"
                                placeholder="بحث عن موظف..."
                                className="w-full bg-white/10 border-none rounded-lg py-1.5 pr-8 pl-3 text-xs text-white placeholder:text-white/40 focus:bg-white/20 outline-none transition-all font-bold"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>

                        {/* Location Filter Button */}
                        <button
                            onClick={() => setShowLocationModal(true)}
                            className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg transition-all flex items-center gap-1 shrink-0 font-bold text-[10px]"
                        >
                            <MapPin size={12} className="text-amber-300" />
                            <span>{selectedLocation === 'الكل' ? 'الكل' : (locationMap[selectedLocation] || selectedLocation)}</span>
                        </button>

                        {/* Status Filter Button */}
                        <button
                            onClick={() => setShowStatusModal(true)}
                            className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg transition-all flex items-center gap-1 shrink-0 font-bold text-[10px]"
                        >
                            <User size={12} className="text-amber-300" />
                            <span>{statusFilter === 'active' ? 'نشطين' : 'غير نشطين'}</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Location Picker Modal */}
            <CustomPickerModal
                isOpen={showLocationModal}
                onClose={() => setShowLocationModal(false)}
                title="اختيار الموقع"
                icon={MapPin}
                selectedValue={selectedLocation}
                onSelect={(locId) => setSelectedLocation(locId)}
                options={[
                    ...(areapermissions['الكل'] || allLocationsList.length > 0 ? [{ id: 'الكل', label: 'جميع المواقع (الكل)', icon: MapPin }] : []),
                    ...allLocationsList.map(locId => ({
                        id: locId,
                        label: locationMap[locId] || locId,
                        icon: MapPin,
                    }))
                ]}
            />

            {/* Status Picker Modal */}
            <CustomPickerModal
                isOpen={showStatusModal}
                onClose={() => setShowStatusModal(false)}
                title="فلترة الحالة"
                icon={User}
                selectedValue={statusFilter}
                searchable={false}
                onSelect={(val) => setStatusFilter(val as 'active' | 'inactive')}
                options={[
                    { id: 'active', label: 'نشطين', icon: CheckCircle },
                    { id: 'inactive', label: 'غير نشطين', icon: X },
                ]}
            />

            {/* Selection Area - Scrollable */}
            <div className="flex-1 overflow-y-auto pb-safe-lg">
                <div className="max-w-4xl mx-auto p-1 space-y-0.5 mt-2">
                    <div className="bg-white rounded-xl p-1">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-2">
                                <Loader2 className="animate-spin text-blue-600" size={24} />
                                <p className="text-blue-900 font-bold text-xs">جاري التحميل...</p>
                            </div>
                        ) : filteredEmployees.length === 0 ? (
                            <div className="text-center py-20 text-gray-400 text-xs">لا توجد نتائج</div>
                        ) : (
                            <div className="space-y-0.5">
                                {filteredEmployees.map((emp) => (
                                    <button
                                        key={emp.key}
                                        onClick={() => {
                                            if (!emp.end_date) {
                                                setSelectedEmployee(emp);
                                            }
                                        }}
                                        className={`w-full bg-white px-3 py-2 rounded-xl flex items-center justify-between gap-3 border-b border-gray-50 transition-all group ${!emp.end_date ? 'hover:bg-slate-50 active:scale-[0.98]' : 'cursor-default'}`}
                                    >
                                        <div className="flex items-center gap-3 overflow-hidden">
                                            <div className="w-10 h-10 bg-slate-50 rounded-lg flex items-center justify-center overflow-hidden border border-gray-100 shrink-0 group-hover:bg-white transition-colors">
                                                {emp.imageurl ? (
                                                    <img src={emp.imageurl} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <User size={18} className="text-slate-400" />
                                                )}
                                            </div>
                                            <div className="text-right min-w-0">
                                                <h3 className={`font-black text-xs truncate leading-tight ${emp.end_date ? 'text-rose-600' : 'text-gray-800'}`}>{emp.name_ar}</h3>
                                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                    <span className="text-[9px] text-gray-400 font-bold truncate">#{emp.iqama}</span>
                                                    {emp.start_date && (
                                                        <span className="text-[9px] text-emerald-600 font-bold flex items-center gap-1">
                                                            <Calendar size={10} />
                                                            {emp.start_date}
                                                        </span>
                                                    )}
                                                    {emp.lastLocation && (
                                                        <span className="text-[9px] text-blue-600 font-bold flex items-center gap-1">
                                                            <MapPin size={10} />
                                                            {locationMap[emp.lastLocation] || emp.lastLocation}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex flex-col items-end shrink-0">
                                            {emp.end_date ? (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-mono font-bold text-rose-600">{emp.end_date}</span>
                                                    {currentUser && isAdmin(currentUser.job_title) && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                restoreEmployee(emp);
                                                            }}
                                                            className="bg-emerald-600 text-white px-3 py-1 rounded-lg font-black text-[9px] shadow-sm active:scale-95 transition-all flex items-center gap-1 hover:bg-emerald-700"
                                                        >
                                                            <RotateCcw size={10} />
                                                            استعادة
                                                        </button>
                                                    )}
                                                    <div className="relative">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setTooltipEmpKey(tooltipEmpKey === emp.key ? null : emp.key);
                                                            }}
                                                            className="w-6 h-6 flex items-center justify-center bg-rose-50 hover:bg-rose-100 text-rose-500 rounded-full font-bold text-xs shadow-sm"
                                                            title="معلومات التوقيف"
                                                        >
                                                            ?
                                                        </button>
                                                        {tooltipEmpKey === emp.key && (
                                                            <div 
                                                                className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-max max-w-[160px] px-3 py-2 bg-slate-800 text-white text-[10px] rounded-xl shadow-xl z-50 animate-fade-in text-center before:content-[''] before:absolute before:bottom-full before:left-1/2 before:-translate-x-1/2 before:border-4 before:border-transparent before:border-b-slate-800"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <span className="text-slate-300 block mb-1">المسؤول عن التوقيف:</span>
                                                                <span className="font-bold text-amber-300">{emp.last_modified_by || 'غير معروف'}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="bg-blue-600 text-white px-4 py-1.5 rounded-lg font-black text-[10px] shadow-sm active:scale-95 transition-all">
                                                    تـوقيـف
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Render Date Picker Modal */}
            {selectedEmployee && renderDatePicker()}

            {saving && (
                <div className="fixed inset-0 bg-white/20 backdrop-blur-[1px] z-110 flex items-center justify-center no-print">
                    <div className="bg-primary text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
                        <Loader2 size={20} className="animate-spin" />
                        <span className="text-sm font-black italic">جاري التحديث...</span>
                    </div>
                </div>
            )}

            <style>{`
                .animate-slide-up { animation: slideUp 0.3s ease-out; }
                @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            `}</style>
        </div>
    );
};
