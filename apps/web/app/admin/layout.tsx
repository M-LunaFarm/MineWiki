import type { ReactNode } from 'react';
import { AdminAccessGate } from '../../components/admin/admin-access-gate';

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <AdminAccessGate><div className="admin-surface">{children}</div></AdminAccessGate>;
}
