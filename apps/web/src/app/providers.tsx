'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster
        position="top-right"
        richColors={false}
        closeButton
        toastOptions={{
          classNames: {
            toast: 'border border-slate-200 bg-white text-slate-900 shadow-sm',
            title: 'text-sm font-medium',
            description: 'text-xs text-slate-500',
            success: 'border-emerald-200',
            error: 'border-red-200',
            warning: 'border-amber-200',
            info: 'border-sky-200',
          },
        }}
      />
    </QueryClientProvider>
  );
}
