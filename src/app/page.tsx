import { getStore } from '@/store';
import { DocumentList } from '@/components/DocumentList';

// The document list reflects writes made during this session.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const store = getStore();
  const documents = await store.listDocuments();

  return (
    <main className="home">
      <h1>TextRippleAI</h1>
      <p className="lede">
        A change-aware writing environment for long-form documents. Edit normally; the editor
        records what changed, in which paragraph, and when - without sending anything to a model.
      </p>
      <DocumentList documents={documents} storeKind={store.kind} />
    </main>
  );
}
