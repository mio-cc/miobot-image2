/**
 * Phase-UI 控件库统一导出。
 *
 * 页面用显式 import（与项目现有约定一致）：
 *   import UiNumberField from '../components/ui/UiNumberField.vue';
 * 或按需从桶文件取：
 *   import { UiNumberField, UiSwitch } from '../components/ui';
 */
export { default as UiNumberField } from './UiNumberField.vue';
export { default as UiSlider } from './UiSlider.vue';
export { default as UiSwitch } from './UiSwitch.vue';
export { default as UiCheckbox } from './UiCheckbox.vue';
export { default as UiRadioGroup } from './UiRadioGroup.vue';
export { default as UiRadio } from './UiRadio.vue';
export { default as UiSegmented } from './UiSegmented.vue';
export { default as UiTextField } from './UiTextField.vue';
export { default as UiFilePicker } from './UiFilePicker.vue';
export { default as UiModal } from './UiModal.vue';
export { default as UiSkeleton } from './UiSkeleton.vue';
export { default as UiSpinner } from './UiSpinner.vue';
export { default as UiEmptyState } from './UiEmptyState.vue';
export { default as UiTooltip } from './UiTooltip.vue';
export { default as UiProgress } from './UiProgress.vue';
export { default as UiToastHost } from './UiToastHost.vue';

export { pushToast, dismissToast, clearToasts, toastItems } from './useToast';
export type { ToastItem, ToastTone } from './useToast';
