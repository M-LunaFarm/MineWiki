import type { Metadata } from 'next';
import { WikiReportAdminClient } from '../../../../components/wiki/wiki-report-admin-client';

export const metadata: Metadata = { title: '위키 신고 큐', robots: { index: false, follow: false } };
export default function AdminWikiReportsPage() { return <WikiReportAdminClient />; }
