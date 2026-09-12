import { notFound } from 'next/navigation';

import { getStore } from '@/store';
import { Workspace } from '@/components/Workspace';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await getStore().getDocument(id);
  if (!loaded) notFound();

  return <Workspace document={loaded.document} initialContent={loaded.content} />;
}
