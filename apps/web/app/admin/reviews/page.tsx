import type { Metadata } from 'next';
import { ReviewModerationConsole } from '../../../components/admin/review-moderation-console';

export const metadata: Metadata = {
  title: '리뷰 신고 관리',
  robots: { index: false, follow: false },
};

export default function AdminReviewsPage() {
  return <ReviewModerationConsole />;
}
