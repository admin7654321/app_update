import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, CheckCircle, AlertTriangle, X, Truck } from 'lucide-react';
import { useTranslation } from '../utils/i18n';

export interface MachineSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  initModalReason?: 'none' | 'no_machine' | 'weekly_recommendation' | 'machine_withdrawn';
  allMachines: any[];
  isMachinesLoading?: boolean;
  currentMachineId?: string;
  employeeName?: string; // أضيف لتمييز تعديل معدة شخص آخر
  onConfirmMachine: (machineId: string) => Promise<void> | void;
  onClearMachine: () => Promise<void> | void;
}

export const MachineSelectionModal: React.FC<MachineSelectionModalProps> = ({
  isOpen,
  onClose,
  initModalReason = 'none',
  allMachines,
  isMachinesLoading = false,
  currentMachineId = '',
  employeeName,
  onConfirmMachine,
  onClearMachine,
}) => {
  const { t } = useTranslation();
  const [newMachineInput, setNewMachineInput] = useState('');
  const [selectedMachineIdx, setSelectedMachineIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // دالة موحدة وشاملة لاستخراج بيانات المركبة أياً كان شكل الكائن (Array أو Object بـ label أو name أو costCenter)
  const extractMachineInfo = (m: any) => {
    let id = '';
    let name = '';
    let costCenter = '';
    let plate = '';
    let driver = '';
    let status = '';

    if (Array.isArray(m)) {
      id = (m[0] || '').toString().trim();
      name = (m[1] || m[0] || '').toString().trim();
      costCenter = id;
      plate = (m[2] || '').toString().trim();
      driver = (m[3] || '').toString().trim();
    } else if (m && typeof m === 'object') {
      if (m[0] !== undefined || m[1] !== undefined) {
        id = (m.id || m[0] || m.key || '').toString().trim();
        name = (m.label || m.name || m[1] || id).toString().trim();
        costCenter = (m.costCenter || m[0] || id).toString().trim();
        plate = (m.plate || m[2] || '').toString().trim();
        driver = (m.driver || m[3] || '').toString().trim();
        status = (m.status || '').toString().trim();
      } else {
        id = (m.id || m.key || m.costCenter || '').toString().trim();
        const rawType = (m.type || '').toString().trim();
        const rawName = (m.label || m.name || m.costCenter || m.id || '').toString().trim();
        name = (rawType && !rawName.includes(rawType)) ? `${rawType} ${rawName}`.trim() : rawName;
        costCenter = (m.costCenter || m.cost_center || id).toString().trim();
        plate = (m.plate || m.plateNumber || m.serial || '').toString().trim();
        driver = (m.driver || m.driverId || m.driver_id || '').toString().trim();
        status = (m.status || '').toString().trim();
      }
    }

    return { id, name, costCenter, plate, driver, status };
  };

  // تصفية الشاحنات مع استبعاد خيارات الخالي أو لا يوجد المكررة
  const filteredMachines = allMachines.filter(m => {
    const info = extractMachineInfo(m);
    const cleanId = info.id;
    const cleanName = info.name;
    const cleanCost = info.costCenter;

    if (!cleanId || cleanId === '---' || cleanId === 'لا يوجد' || cleanId === 'خارجي') return false;
    if (cleanName === 'لا يوجد' || cleanName === 'بدون معدة' || cleanName === 'لا يوجد معدة' || cleanName === '---') return false;
    if (cleanCost === '---') return false;
    if (info.status === 'غير نشط' || info.status === 'مخفي' || info.status === 'hidden' || info.status === 'hide') return false;

    const search = newMachineInput.trim().toLowerCase();
    if (!search) return true;

    return cleanId.toLowerCase().includes(search) ||
      cleanName.toLowerCase().includes(search) ||
      cleanCost.toLowerCase().includes(search) ||
      info.plate.toLowerCase().includes(search);
  });

  // الخيارات القابلة للتحديد من قائمة الشاحنات متضمنة خيار خارجي في الأسفل
  const specialOptions = [
    { id: 'خارجي', name: 'خارجي', label: 'خارجي', type: '' }
  ].filter(item =>
    !newMachineInput.trim() ||
    item.name.toLowerCase().includes(newMachineInput.toLowerCase()) ||
    item.id.toLowerCase().includes(newMachineInput.toLowerCase())
  );

  const selectableMachines = [
    ...filteredMachines,
    ...specialOptions
  ];

  // التمرير التلقائي والقفز المباشر للمعدة الحالية عند فتح النافذة
  useEffect(() => {
    if (isOpen && selectableMachines.length > 0) {
      setError(null);
      const cleanCurrent = (currentMachineId || '').trim();
      const idx = selectableMachines.findIndex(m => {
        const info = extractMachineInfo(m);
        return info.id === cleanCurrent ||
          (info.costCenter && info.costCenter === cleanCurrent) ||
          info.name === cleanCurrent ||
          (cleanCurrent && info.id && cleanCurrent.endsWith(' ' + info.id)) ||
          (info.name && cleanCurrent && info.name.toLowerCase() === cleanCurrent.toLowerCase());
      });
      const targetIdx = idx !== -1 ? idx : 0;
      setSelectedMachineIdx(targetIdx);

      // 🎯 قفز وتمرير مباشر لمركز العنصر المختار
      setTimeout(() => {
        const listContainer = listRef.current;
        if (listContainer && listContainer.children[targetIdx]) {
          const selectedEl = listContainer.children[targetIdx] as HTMLElement;
          selectedEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 150);
    }
  }, [isOpen, allMachines, currentMachineId]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (selectableMachines.length === 0 || submitting) return;
    const selectedMachine = selectableMachines[selectedMachineIdx];
    if (!selectedMachine) {
      setError(t("يرجى اختيار مركبة أولاً للتأكيد"));
      return;
    }
    const info = extractMachineInfo(selectedMachine);
    if (!info.id || info.id === 'لا يوجد' || info.id === 'بدون معدة') {
      await handleClear();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onConfirmMachine(info.id);
      setNewMachineInput('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onClearMachine();
      setNewMachineInput('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-200 flex items-center justify-center p-4 animate-fade-in" dir="rtl">
      <div className="bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh] border border-blue-50 relative">
        
        {/* رأس النافذة */}
        <div className="p-4 bg-slate-800 text-white flex items-center justify-between shrink-0">
          <div className="flex flex-col text-right">
            <h3 className="text-sm font-black flex items-center gap-1.5">
              <Truck size={16} className="text-blue-400 shrink-0" />
              <span>{employeeName ? 'تعيين المعدة للموظف' : 'تحديد المركبة'}</span>
            </h3>
            {employeeName && <p className="text-xs text-gray-300 font-bold mt-0.5">{employeeName}</p>}
          </div>
          <button
            onClick={() => {
              setNewMachineInput('');
              onClose();
            }}
            className="w-8 h-8 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* محتوى النافذة */}
        <div className="p-4 flex flex-col flex-1 overflow-hidden bg-slate-50 gap-3">

          {/* حقل البحث */}
          <div className="relative w-full shrink-0 flex items-center">
            <input
              type="text"
              placeholder={t("ابحث برقم المعدة أو رقم اللوحة...")}
              value={newMachineInput}
              onChange={(e) => {
                setNewMachineInput(e.target.value);
                setSelectedMachineIdx(0);
                setError(null);
              }}
              className="w-full bg-white border border-slate-200 rounded-xl py-2.5 px-4 pl-10 text-right font-bold text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all placeholder:text-gray-400"
              ref={inputRef}
            />
            {isMachinesLoading ? (
              <Loader2 size={14} className="absolute left-3 top-3 animate-spin text-blue-500" />
            ) : (
              <Search size={14} className="absolute left-3 top-3 text-gray-400" />
            )}
          </div>

          {/* تنبيه الخطأ عند عدم اختيار معدة */}
          {error && (
            <div className="w-full bg-red-50 border border-red-200 rounded-xl p-2.5 text-right text-[11px] font-bold text-red-800 flex items-start gap-2 shrink-0 animate-fade-in">
              <AlertTriangle size={14} className="text-red-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* قائمة المركبات البسيطة والسهلة متضمنة خيار خارجي بالأسفل */}
          {selectableMachines.length > 0 ? (
            <div 
              ref={listRef}
              className="flex-1 overflow-y-auto max-h-56 border border-slate-200/60 rounded-xl bg-white p-1 gap-1 flex flex-col"
            >
              {selectableMachines.map((m, idx) => {
                const info = extractMachineInfo(m);
                const isSelected = idx === selectedMachineIdx;
                const isExternal = info.id === 'خارجي';
                const plateStr = info.plate && info.plate !== '****' && info.plate !== 'بدون لوحة' ? ` - ${info.plate}` : '';
                const machineLabel = isExternal ? 'خارجي' : (info.name ? `${info.name}${plateStr}` : `${info.id}${plateStr}`);
                const rawDriver = info.driver;
                const hasDriver = !!(
                  rawDriver &&
                  rawDriver !== 'بدون' &&
                  rawDriver !== 'لا يوجد' &&
                  rawDriver !== 'لا يوجد معدة' &&
                  rawDriver !== '---' &&
                  rawDriver !== 'false' &&
                  rawDriver !== 'null' &&
                  rawDriver !== 'undefined'
                );

                return (
                  <button
                    key={info.id || `option_${idx}`}
                    type="button"
                    onClick={() => {
                      setSelectedMachineIdx(idx);
                      setError(null);
                    }}
                    className={`w-full text-right p-3 rounded-xl flex items-center justify-between border transition-all ${
                      isSelected 
                        ? isExternal
                          ? 'bg-amber-100/90 border-amber-400 text-amber-950 font-black shadow-xs'
                          : 'bg-blue-50 border-blue-400 text-blue-950 font-black shadow-xs' 
                        : isExternal
                          ? 'bg-amber-50/60 border-amber-200 hover:bg-amber-100/60 text-amber-900 font-bold'
                          : 'bg-white border-slate-100 hover:bg-slate-50 text-slate-800 font-bold'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${isSelected ? 'text-blue-950 font-black' : 'text-slate-800 font-bold'}`}>
                        {machineLabel}
                      </span>
                      {hasDriver && !isExternal && (
                        <span className="text-[10px] text-rose-600 font-bold px-1.5 py-0.5 rounded-md bg-rose-50 border border-rose-200/80">
                          محجوز
                        </span>
                      )}
                    </div>
                    {isSelected && <CheckCircle size={15} className={isExternal ? 'text-amber-600 shrink-0' : 'text-blue-600 shrink-0'} />}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400 text-xs font-bold bg-white rounded-xl border border-slate-200/60 shadow-sm w-full">
              لا توجد شاحنات مطابقة للبحث
            </div>
          )}
        </div>

        {/* أزرار الإجراءات الأساسية */}
        <div className="p-3 bg-white border-t border-gray-100 shrink-0 w-full flex gap-2">
          {selectableMachines.length > 0 && (
            <button
              type="button"
              disabled={submitting}
              onClick={handleConfirm}
              className="flex-1 py-3 bg-primary hover:bg-blue-800 text-white rounded-xl font-black text-xs transition-all active:scale-[0.98] shadow-md shadow-blue-500/10 flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              <span>تأكيد الاختيار</span>
            </button>
          )}

          {/* خيار لا يوجد معدة - خيار أساسي في الشريط السفلي */}
          <button
            type="button"
            disabled={submitting}
            onClick={handleClear}
            className="flex-1 py-3 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200/80 rounded-xl font-black text-xs transition-all active:scale-[0.98] flex items-center justify-center gap-1 shadow-xs disabled:opacity-50"
          >
            <span>لا يوجد معدة</span>
          </button>
        </div>

      </div>
    </div>
  );
};
