import type { ReactNode } from 'react';
import { AdminAccessGate } from '../../components/admin/admin-access-gate';

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <AdminAccessGate>{children}</AdminAccessGate>;
}
