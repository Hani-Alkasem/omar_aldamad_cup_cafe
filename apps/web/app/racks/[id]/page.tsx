import { notFound } from 'next/navigation';
import { RackView } from '@/components/rack/RackView';
import { ApiError, getElevation } from '@/lib/api';

export default async function RackPage({ params }: { params: { id: string } }) {
  try {
    const elevation = await getElevation(params.id);
    return <RackView elevation={elevation} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
