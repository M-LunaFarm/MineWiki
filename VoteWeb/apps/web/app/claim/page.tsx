import { ClaimWorkflow } from '../../components/claim/claim-workflow';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '서버 소유권 검증',
  description: '서버 운영자임을 검증하고 Lunaf.kr 서버 정보를 관리하세요.',
  path: '/claim',
  noIndex: true,
});

export default function ClaimWizardPage() {
  return <ClaimWorkflow />;
}
