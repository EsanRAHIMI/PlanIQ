import './globals.css';
import type { Metadata } from 'next';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'PlanIQ — Smart Device Placement',
  description: 'Automatic CCTV / Wi-Fi / ELV / smart-home device placement on villa floor plans.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
