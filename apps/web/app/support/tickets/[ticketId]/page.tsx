import { redirect } from 'next/navigation';

interface PageProps {
  readonly params: Promise<{
    readonly ticketId: string;
  }>;
}

export default async function SupportTicketRoutePage({ params }: PageProps) {
  const { ticketId } = await params;
  redirect(`/support?ticket=${encodeURIComponent(ticketId)}`);
}
