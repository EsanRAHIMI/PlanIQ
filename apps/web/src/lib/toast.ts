import { toast as sonnerToast, ExternalToast } from 'sonner';

type ToastOpts = ExternalToast & { id?: string | number };

export const toast = {
  loading: (message: string, opts?: ToastOpts) => sonnerToast.loading(message, opts),
  success: (message: string, opts?: ToastOpts) => sonnerToast.success(message, opts),
  error: (message: string, opts?: ToastOpts) => sonnerToast.error(message, opts),
  warning: (message: string, opts?: ToastOpts) => sonnerToast.warning(message, opts),
  info: (message: string, opts?: ToastOpts) => sonnerToast.info(message, opts),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  promise: sonnerToast.promise,
};
