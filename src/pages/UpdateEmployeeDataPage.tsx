import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, ensureAuthenticated, getRealDate } from '../services/firebase';
import { ref, get, update, query, orderByChild, equalTo, push } from 'firebase/database';
import { Search, User, MapPin, Truck, Calendar, X, ChevronDown, Save, CheckCircle, AlertCircle, RefreshCw, Globe, Home, Briefcase, ArrowRight, Loader2 } from 'lucide-react';
import { useTranslation } from '../utils/i18n';
import { CustomPickerModal } from '../components/CustomPickerModal';
import { DatePickerSelector } from '../components/DatePickerSelector';
import { MachineSelectionModal } from '../components/MachineSelectionModal';
import { SUB_JOB_OPTIONS, getPrimaryJobTitle, ENABLE_FIREBASE_FALLBACK } from '../constants';
import { edgeBootstrapService } from '../services/edgeBootstrapService';
import { swrCache } from '../services/swrCache';
import { useToast } from '../context/ToastContext';
import { useClickOutside } from '../hooks/useClickOutside';

export const UpdateEmployeeDataPage: React.FC = () => {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [employees, setEmployees] = useState<any[]>([]);
    const [filteredEmployees, setFilteredEmployees] = useState<any[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // ⚡ Lists for pickers (تبدأ فوراً من الكاش لسرعة 0ms)
    const [locationsList, setLocationsList] = useState<{ id: string, name: string }[]>(() => swrCache.get('locations', []));
    const [machinesList, setMachinesList] = useState<{ id: string, label: string }[]>(() => swrCache.get('machines', []));
    const [locationMap, setLocationMap] = useState<Record<string, string>>({});
    const [selectedLocationFilter, setSelectedLocationFilter] = useState('الكل');
    const [showLocationFilterModal, setShowLocationFilterModal] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);

    // Selection & Edit State
    const [selectedEmployee, setSelectedEmployee] = useState<any | null>(null);
    const [formData, setFormData] = useState({
        lastLocation: '',
        machine: '',
        start_date: '',
        end_date: '',
        nationality: '',
        housing: '',
        housing_in: '',
        housing_out: ''
    });

    // Search inputs for pickers
    const [locationSearch, setLocationSearch] = useState('');
    const [machineSearch, setMachineSearch] = useState('');
    const [showLocationSuggestions, setShowLocationSuggestions] = useState(false);
    const [showMachineSuggestions, setShowMachineSuggestions] = useState(false);
    const [showDatePicker, setShowDatePicker] = useState<string | null>(null);
    const [showDutyDates, setShowDutyDates] = useState(false);
    const [showHousingFields, setShowHousingFields] = useState(false);
    const { showToast, hideToast } = useToast();
    const setNotification = (n: { msg: string, type: 'success' | 'error' | 'info' | 'warning' } | null) => {
        if (!n) hideToast();
        else showToast(n.msg, n.type);
    };

    const locationPickerRef = useRef<HTMLDivElement>(null);
    const machinePickerRef = useRef<HTMLDivElement>(null);

    useClickOutside(locationPickerRef, () => setShowLocationSuggestions(false), showLocationSuggestions);
    useClickOutside(machinePickerRef, () => setShowMachineSuggestions(false), showMachineSuggestions);

    useEffect(() => {
        const init = async () => {
            setLoading(true);
            await ensureAuthenticated();
            try {
                const currentUserKey = (localStorage.getItem("userKey") || "unknown").trim();
                
                // 🚀 المرحلة الأولى بالتوازي: جلب المواقع والمعدات وبيانات موقع المشرف معاً في نفس اللحظة
                const [locs, , userSnap] = await Promise.all([
                    loadLocations(),
                    loadMachines(),
                    currentUserKey !== "unknown" && currentUserKey !== "" ? get(ref(db, `قائمة_الموظفين/${currentUserKey}`)) : Promise.resolve(null)
                ]);

                let defaultLoc = 'الكل';
                if (userSnap && userSnap.exists()) {
                    const supervisorLoc = userSnap.val().lastLocation;
                    if (supervisorLoc && locs.some((l: any) => l.id === supervisorLoc)) {
                        defaultLoc = supervisorLoc;
                    }
                }

                setSelectedLocationFilter(defaultLoc);
                setIsInitialized(true);
                // 🚀 المرحلة الثانية: جلب موظفي الموقع المحدد
                await fetchEmployees(defaultLoc);
            } catch (err) {
                console.error("Error during parallel init in UpdateEmployeeDataPage:", err);
                setLoading(false);
            }
        };
        init();
    }, []);

    const loadLocations = async () => {
        try {
            const locSnap = await get(ref(db, 'workAreas'));
            if (locSnap.exists()) {
                const raw = locSnap.val();
                const list: { id: string, name: string }[] = [];
                const mapping: Record<string, string> = {};
                const collect = (obj: any) => {
                    if (!obj) return;
                    Object.entries(obj).forEach(([id, val]: any) => {
                        if (id === 'hide' || val?.hidden || val?.hide || val?.status === 'hidden' || val?.status === 'hide') return;
                        if (typeof val === 'object' && val !== null) {
                            const name = val.name || id;
                            list.push({ id, name });
                            mapping[id] = name;
                        }
                    });
                };
                collect(raw);
                setLocationsList(list);
                setLocationMap(mapping);
                swrCache.set('locations', list);
                return list;
            }
        } catch (error) {
            console.error("Error loading locations:", error);
        }
        return [];
    };

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

    const fetchEmployees = async (locFilter: string = selectedLocationFilter) => {
        setLoading(true);
        try {
            let snapshot;
            if (locFilter === 'الكل') {
                snapshot = await get(query(ref(db, "قائمة_الموظفين"), orderByChild("status"), equalTo("نشط")));
            } else {
                snapshot = await get(query(ref(db, "قائمة_الموظفين"), orderByChild("lastLocation"), equalTo(locFilter)));
            }

            const list: any[] = [];
            if (snapshot.exists()) {
                snapshot.forEach(child => {
                    const val = child.val();
                    if (val?.status !== 'مخفي' && val?.status !== 'hidden' && val?.status !== 'hide' && !val?.hidden && !val?.hide) {
                        if (locFilter === 'الكل' || val.status === 'نشط') {
                            list.push({ key: child.key, ...val });
                        }
                    }
                });
            }
            list.sort((a, b) => (a.name_ar || '').localeCompare(b.name_ar || '', 'ar'));
            setEmployees(list);
            setFilteredEmployees(list);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleLocationFilterChange = async (newLoc: string) => {
        setSelectedLocationFilter(newLoc);
        if (isInitialized) {
            await fetchEmployees(newLoc);
        }
    };

    useEffect(() => {
        const results = employees.filter(emp => {
            const term = searchTerm.toLowerCase();
            return (
                emp.name_ar?.toLowerCase().includes(term) ||
                emp.iqama?.toLowerCase().includes(term)
            );
        });
        setFilteredEmployees(results);
    }, [searchTerm, employees]);

    const handleSelectEmployee = (emp: any) => {
        setSelectedEmployee(emp);
        setFormData({
            lastLocation: emp.lastLocation || '',
            machine: emp.machine || '',
            sub_job: emp.sub_job || '',
            start_date: emp.start_date || '',
            end_date: emp.end_date || '',
            nationality: emp.nationality || '',
            housing: emp.housing || '',
            housing_in: emp.housing_in || '',
            housing_out: emp.housing_out || ''
        });
        setLocationSearch(locationMap[emp.lastLocation] || emp.lastLocation || '');
        const machineObj = machinesList.find(m => m.id === emp.machine);
        setMachineSearch(machineObj ? machineObj.label : emp.machine || '');
    };

    const handleSave = async () => {
        if (!selectedEmployee || saving) return;

        // Validation: Check if location and machine are valid
        const validLocation = locationsList.find(l => l.name === locationSearch || l.id === formData.lastLocation);
        const validMachine = formData.machine === '' || machinesList.find(m => m.label === machineSearch || m.id === formData.machine);

        if (!validLocation && locationSearch !== '') {
            setNotification({ msg: t('الموقع غير موجود في القائمة'), type: 'error' });
            setTimeout(() => setNotification(null), 3000);
            return;
        }

        setSaving(true);
        try {
            const currentUserKey = localStorage.getItem("userKey") || "unknown";
            const userSnap = await get(ref(db, `قائمة_الموظفين/${currentUserKey}/name_ar`));
            const currentUserName = userSnap.exists() ? userSnap.val() : "مستخدم";

            const now = getRealDate();
            const yearMonth = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
            const day = now.getDate().toString().padStart(2, '0');

            const nowTs = Date.now();
            const updates: Record<string, any> = {};

            // 1. Basic Employee Data Updates
            updates[`قائمة_الموظفين/${selectedEmployee.key}/lastLocation`] = formData.lastLocation;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/machine`] = formData.machine;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/sub_job`] = formData.sub_job;
            const computedMainJob = getPrimaryJobTitle(formData.sub_job);
            if (computedMainJob) {
                updates[`قائمة_الموظفين/${selectedEmployee.key}/job_title`] = computedMainJob;
            }
            updates[`قائمة_الموظفين/${selectedEmployee.key}/start_date`] = formData.start_date;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/end_date`] = formData.end_date;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/nationality`] = formData.nationality;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/housing`] = formData.housing;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/housing_in`] = formData.housing_in;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/housing_out`] = formData.housing_out;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/last_modified_by`] = currentUserName;

            // Always update modification timestamps (same effect as equipment update)
            updates[`قائمة_الموظفين/${selectedEmployee.key}/machine_updated_at`] = nowTs;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/driver_updated_at`] = nowTs;
            updates[`قائمة_الموظفين/${selectedEmployee.key}/updatedAt`] = nowTs;

            // 2. Update current active period in history
            const history = selectedEmployee.employment_history || {};
            const activePeriodKey = Object.keys(history).find(key => history[key].status === 'نشط');
            if (activePeriodKey) {
                updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/start_date`] = formData.start_date;
                updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/end_date`] = formData.end_date;
                updates[`قائمة_الموظفين/${selectedEmployee.key}/employment_history/${activePeriodKey}/updated_by`] = currentUserName;
            }

            // 3. Update Equipment Linkages & Timestamps
            if (formData.machine !== (selectedEmployee.machine || '')) {
                // Remove old links
                if (selectedEmployee.machine) {
                    updates[`جدول_المعدات_والسائقين_المشترك/${selectedEmployee.machine}`] = null;
                    updates[`جدول_المعدات_والسائقين_المشترك/${selectedEmployee.key}`] = null;
                    updates[`قائمة_المعدات/${selectedEmployee.machine}/driver`] = "";
                    updates[`قائمة_المعدات/${selectedEmployee.machine}/driver_updated_at`] = nowTs;
                    updates[`قائمة_المعدات/${selectedEmployee.machine}/machine_updated_at`] = nowTs;
                }
                // Add new links
                if (formData.machine) {
                    updates[`جدول_المعدات_والسائقين_المشترك/${formData.machine}`] = selectedEmployee.key;
                    updates[`جدول_المعدات_والسائقين_المشترك/${selectedEmployee.key}`] = formData.machine;
                    updates[`قائمة_المعدات/${formData.machine}/driver`] = selectedEmployee.key;
                    updates[`قائمة_المعدات/${formData.machine}/driver_updated_at`] = nowTs;
                    updates[`قائمة_المعدات/${formData.machine}/machine_updated_at`] = nowTs;
                }
            } else if (formData.machine) {
                // Machine remained same, update machine timestamps
                updates[`قائمة_المعدات/${formData.machine}/driver_updated_at`] = nowTs;
                updates[`قائمة_المعدات/${formData.machine}/machine_updated_at`] = nowTs;
            }

            // 4. Log the action
            const logKey = push(ref(db, `LOG/${yearMonth}/${day}`)).key;
            updates[`LOG/${yearMonth}/${day}/${logKey}`] = {
                timestamp: now.getTime(),
                operation: "تحديث بيانات الموظف",
                admin_name: currentUserName,
                admin_id: currentUserKey,
                employee_name: selectedEmployee.name_ar,
                employee_id: selectedEmployee.key,
                action: "تعديل بيانات شاملة",
                details: `تحديث شامل لبيانات الموظف بواسطة المشرف`
            };

            await update(ref(db), updates);

            setNotification({ msg: t('تم التحديث بنجاح'), type: 'success' });
            setSelectedEmployee(null);
            fetchEmployees();
        } catch (error) {
            console.error(error);
            setNotification({ msg: t('حدث خطأ أثناء الحفظ'), type: 'error' });
        } finally {
            setSaving(false);
            setTimeout(() => setNotification(null), 3000);
        }
    };

    const renderDatePicker = (field: string) => {
        const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
        const dates = [];
        const today = getRealDate();

        for (let i = 0; i < 90; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() - i);
            const str = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
            const dayName = i === 0 ? 'اليوم' : arabicDays[date.getDay()];
            dates.push({ str, dayName });
        }

        return (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-200 flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowDatePicker(null)}>
                <div className="bg-white rounded-3xl w-full max-w-sm max-h-[70vh] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                    <div className="p-4 bg-primary text-white flex justify-between items-center shrink-0">
                        <h3 className="font-black text-lg">{t('اختر التاريخ')}</h3>
                        <button onClick={() => setShowDatePicker(null)}><X size={24} /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-slate-50">
                        {dates.map((d, idx) => (
                            <button
                                key={idx}
                                onClick={() => {
                                    setFormData({ ...formData, [field as keyof typeof formData]: d.str });
                                    setShowDatePicker(null);
                                }}
                                className={`w-full p-4 rounded-2xl flex justify-between items-center transition-all ${formData[field as keyof typeof formData] === d.str ? 'bg-primary text-white shadow-lg' : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-100'}`}
                            >
                                <span className="font-mono font-black">{d.str}</span>
                                <span className={`text-xs font-bold ${formData[field as keyof typeof formData] === d.str ? 'text-white/60' : 'text-slate-400'}`}>{d.dayName}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="h-screen bg-white text-right font-sans flex flex-col overflow-hidden" dir="rtl">
            {/* Header - Styled like TerminateEmployeePage */}
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

                        <button
                            onClick={() => setShowLocationFilterModal(true)}
                            className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg transition-all flex items-center gap-1 shrink-0 font-bold text-[10px]"
                        >
                            <MapPin size={12} className="text-amber-300" />
                            <span>{selectedLocationFilter === 'الكل' ? 'الكل' : (locationMap[selectedLocationFilter] || selectedLocationFilter)}</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Location Filter Picker Modal */}
            <CustomPickerModal
                isOpen={showLocationFilterModal}
                onClose={() => setShowLocationFilterModal(false)}
                title="اختيار الموقع"
                icon={MapPin}
                selectedValue={selectedLocationFilter}
                onSelect={(locId) => handleLocationFilterChange(locId)}
                options={[
                    { id: 'الكل', label: 'جميع المواقع (الكل)', icon: MapPin },
                    ...locationsList.map(loc => ({
                        id: loc.id,
                        label: loc.name,
                        icon: MapPin,
                    }))
                ]}
            />

            {/* Employee List - TerminateEmployeePage Style */}
            <div className="flex-1 overflow-y-auto">
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
                                        onClick={() => handleSelectEmployee(emp)}
                                        className="w-full bg-white px-3 py-2 rounded-xl flex items-center justify-between gap-3 border-b border-gray-50 transition-all group hover:bg-slate-50 active:scale-[0.98]"
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
                                                <h3 className="font-bold text-[11px] truncate leading-tight text-slate-700">{emp.name_ar}</h3>
                                                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                    <span className="text-[9px] text-gray-400 font-bold truncate">#{emp.iqama}</span>
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
                                            <div className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-xs active:scale-95 transition-all">
                                                تعديل
                                            </div>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Edit Form Modal - Enhanced with search and extra fields */}
            {selectedEmployee && (
                <div className="fixed inset-0 z-100 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
                    <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] border border-slate-100">
                        <div className="p-4 bg-primary text-white flex justify-between items-center shrink-0">
                            <div className="flex items-center gap-3 text-right">
                                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center shrink-0">
                                    {selectedEmployee.imageurl ? <img src={selectedEmployee.imageurl} className="w-full h-full object-cover rounded-xl" /> : <User size={20} />}
                                </div>
                                <div>
                                    <h2 className="text-sm font-bold">{selectedEmployee.name_ar}</h2>
                                    <p className="text-[10px] text-white/70 font-semibold">تعديل بيانات الموظف الشاملة</p>
                                </div>
                            </div>
                            <button onClick={() => setSelectedEmployee(null)} className="p-1.5 hover:bg-white/10 rounded-full transition-colors">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-4 overflow-y-auto space-y-4 no-scrollbar">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                {/* Location Search Input */}
                                <div className="space-y-1" ref={locationPickerRef}>
                                    <label className="text-[11px] font-bold text-slate-500 mr-1">الموقع الحالي</label>
                                    <div className="relative">
                                        <MapPin className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={15} />
                                        <input
                                            type="text"
                                            value={locationSearch}
                                            onChange={(e) => {
                                                setLocationSearch(e.target.value);
                                                setShowLocationSuggestions(true);
                                            }}
                                            onFocus={() => setShowLocationSuggestions(true)}
                                            placeholder="ابحث عن موقع..."
                                            className="w-full bg-slate-50/80 border border-slate-200 rounded-xl py-2.5 px-3 pr-9 text-right font-bold text-slate-700 text-xs focus:bg-white focus:border-blue-500 outline-none transition-all"
                                        />
                                        {showLocationSuggestions && (
                                            <div className="absolute top-full left-0 w-full mt-1 bg-white border border-blue-500 rounded-xl shadow-xl z-150 max-h-36 overflow-y-auto animate-fade-in">
                                                {locationsList.filter(l => l.name.includes(locationSearch) || l.id.includes(locationSearch)).map(loc => (
                                                    <button
                                                        key={loc.id}
                                                        onClick={() => {
                                                            setFormData({ ...formData, lastLocation: loc.id });
                                                            setLocationSearch(loc.name);
                                                            setShowLocationSuggestions(false);
                                                        }}
                                                        className="w-full p-2.5 text-right font-bold text-xs hover:bg-blue-50 border-b border-slate-50 text-slate-700"
                                                    >
                                                        {loc.name}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Machine Search Input connected to Unified MachineSelectionModal */}
                                <div className="space-y-1">
                                    <label className="text-[11px] font-bold text-slate-500 mr-1">المعدة / المركبة</label>
                                    <div className="relative">
                                        <Truck className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={15} />
                                        <input
                                            type="text"
                                            value={machineSearch}
                                            readOnly
                                            onClick={() => setShowMachineSuggestions(true)}
                                            placeholder="اختر معدة..."
                                            className="w-full bg-slate-50/80 border border-slate-200 rounded-xl py-2.5 px-3 pr-9 text-right font-bold text-slate-700 text-xs focus:bg-white focus:border-blue-500 outline-none transition-all cursor-pointer"
                                        />
                                    </div>
                                </div>

                                <MachineSelectionModal
                                    isOpen={showMachineSuggestions}
                                    onClose={() => setShowMachineSuggestions(false)}
                                    allMachines={machinesList}
                                    currentMachineId={formData.machine}
                                    employeeName={formData.name_ar}
                                    onConfirmMachine={(mId) => {
                                        setFormData(prev => ({ ...prev, machine: mId }));
                                        const mObj = machinesList.find(m => m.id === mId);
                                        setMachineSearch(mId === 'خارجي' ? 'خارجي' : (mObj?.label || mId));
                                        setShowMachineSuggestions(false);
                                    }}
                                    onClearMachine={() => {
                                        setFormData(prev => ({ ...prev, machine: '' }));
                                        setMachineSearch('لا يوجد معدة');
                                        setShowMachineSuggestions(false);
                                    }}
                                />
                            </div>

                            {/* Sub-Job Dropdown Field */}
                            <div className="space-y-1">
                                <label className="text-[11px] font-bold text-slate-500 mr-1">الوظيفة الفرعية</label>
                                <div className="relative">
                                    <Briefcase className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={15} />
                                    <select
                                        value={formData.sub_job || ''}
                                        onChange={(e) => setFormData({ ...formData, sub_job: e.target.value })}
                                        className="w-full bg-slate-50/80 border border-slate-200 rounded-xl py-2.5 px-3 pr-9 text-right font-bold text-slate-700 text-xs focus:bg-white focus:border-blue-500 outline-none transition-all appearance-none cursor-pointer"
                                    >
                                        <option value="">بدون وظيفة فرعية</option>
                                        {SUB_JOB_OPTIONS.map(job => (
                                            <option key={job} value={job}>{job}</option>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={14} />
                                </div>
                            </div>

                            {/* Section 1: Duty Dates */}
                            <div className="pt-1">
                                <button
                                    onClick={() => setShowDutyDates(!showDutyDates)}
                                    className="w-full py-2 px-3 bg-blue-50/80 rounded-xl text-blue-600 font-bold text-xs flex items-center justify-center gap-2 hover:bg-blue-100/80 transition-all border border-blue-100"
                                >
                                    <span>{showDutyDates ? t('إخفاء تواريخ الدوام') : t('المزيد (تواريخ الدوام)')}</span>
                                    <ChevronDown size={14} className={`transition-transform ${showDutyDates ? 'rotate-180' : ''}`} />
                                </button>
                            </div>

                            {showDutyDates && (
                                <div className="grid grid-cols-2 gap-3 animate-fade-in bg-slate-50/80 p-3 rounded-xl border border-slate-100">
                                    <div className="space-y-1">
                                        <label className="text-[11px] font-bold text-slate-500 mr-1">بداية دوام الموظف</label>
                                        <DatePickerSelector
                                            selectedDate={formData.start_date}
                                            onDateChange={(newDate) => setFormData(prev => ({ ...prev, start_date: newDate }))}
                                            daysCount={90}
                                            dropUp={true}
                                            className="w-full"
                                            buttonClassName="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 text-right font-bold text-slate-700 text-xs shadow-none hover:border-blue-300 transition-all justify-between"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[11px] font-bold text-slate-500 mr-1">نهاية دوام الموظف</label>
                                        <DatePickerSelector
                                            selectedDate={formData.end_date}
                                            onDateChange={(newDate) => setFormData(prev => ({ ...prev, end_date: newDate }))}
                                            daysCount={90}
                                            dropUp={true}
                                            className="w-full"
                                            buttonClassName="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 text-right font-bold text-slate-700 text-xs shadow-none hover:border-blue-300 transition-all justify-between"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Section 2: Nationality & Housing */}
                            <div className="pt-1">
                                <button
                                    onClick={() => setShowHousingFields(!showHousingFields)}
                                    className="w-full py-2 px-3 bg-emerald-50/80 rounded-xl text-emerald-600 font-bold text-xs flex items-center justify-center gap-2 hover:bg-emerald-100/80 transition-all border border-emerald-100"
                                >
                                    <span>{showHousingFields ? t('إخفاء بيانات السكن') : t('المزيد (الجنسية والسكن)')}</span>
                                    <ChevronDown size={14} className={`transition-transform ${showHousingFields ? 'rotate-180' : ''}`} />
                                </button>
                            </div>

                            {showHousingFields && (
                                <div className="space-y-4 animate-fade-in bg-slate-50/80 p-3 rounded-xl border border-slate-100">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-[11px] font-bold text-slate-500 mr-1">الجنسية</label>
                                            <div className="relative">
                                                <Globe className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={15} />
                                                <input
                                                    type="text"
                                                    value={formData.nationality}
                                                    onChange={(e) => setFormData({ ...formData, nationality: e.target.value })}
                                                    className="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 pr-9 text-right font-bold text-slate-700 text-xs focus:bg-white focus:border-blue-500 outline-none transition-all"
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[11px] font-bold text-slate-500 mr-1">السكن</label>
                                            <div className="relative">
                                                <Home className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-500 pointer-events-none" size={15} />
                                                <input
                                                    type="text"
                                                    value={formData.housing}
                                                    onChange={(e) => setFormData({ ...formData, housing: e.target.value })}
                                                    className="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 pr-9 text-right font-bold text-slate-700 text-xs focus:bg-white focus:border-blue-500 outline-none transition-all"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-[11px] font-bold text-slate-500 mr-1">دخول السكن</label>
                                            <button
                                                onClick={() => setShowDatePicker('housing_in')}
                                                className="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 text-right font-mono font-bold text-slate-700 hover:bg-white hover:border-blue-300 transition-all text-xs flex items-center justify-between"
                                            >
                                                <span>{formData.housing_in || '---'}</span>
                                                <Calendar size={14} className="text-blue-500" />
                                            </button>
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[11px] font-bold text-slate-500 mr-1">خروج السكن</label>
                                            <button
                                                onClick={() => setShowDatePicker('housing_out')}
                                                className="w-full bg-white border border-slate-200 rounded-xl py-2 px-3 text-right font-mono font-bold text-slate-700 hover:bg-white hover:border-blue-300 transition-all text-xs flex items-center justify-between"
                                            >
                                                <span>{formData.housing_out || '---'}</span>
                                                <Calendar size={14} className="text-blue-500" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="p-3 sm:p-4 bg-slate-50 border-t border-slate-100 shrink-0">
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="w-full bg-primary text-white py-3 rounded-xl font-black text-sm flex items-center justify-center gap-2 shadow-md hover:bg-blue-800 active:scale-[0.98] transition-all disabled:opacity-50"
                            >
                                {saving ? <Loader2 className="animate-spin" size={18} /> : <Save size={16} />}
                                <span>{t('حفظ التعديلات')}</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showDatePicker && renderDatePicker(showDatePicker)}

            {saving && (
                <div className="fixed inset-0 bg-white/20 backdrop-blur-[2px] z-250 flex items-center justify-center">
                    <div className="bg-primary text-white px-8 py-4 rounded-3xl shadow-2xl flex items-center gap-4 animate-pulse">
                        <Loader2 size={24} className="animate-spin" />
                        <span className="font-black">جاري المعالجة...</span>
                    </div>
                </div>
            )}

            <style>{`
                .animate-fade-in { animation: fadeIn 0.3s ease-out; }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                .no-scrollbar::-webkit-scrollbar { display: none; }
                .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
            `}</style>
        </div>
    );
};
