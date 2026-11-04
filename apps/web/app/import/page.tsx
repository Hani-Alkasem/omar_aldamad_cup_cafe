import { Section } from '@/components/ui';
import { ImportForm } from './ImportForm';

export const metadata = { title: 'Import assets' };

const COLUMNS = 'name,type,status,asset_tag,serial_number,site,rack,start_u,size_u,face,depth,power_draw_w';

export default function ImportPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Import assets</h1>
      <Section title="CSV file">
        <div className="mb-4 space-y-2 text-sm text-slate-400">
          <p>Required columns: <code>name</code>, <code>type</code>. Rows that match an existing asset by asset tag, then serial, update it; others are created.</p>
          <p className="break-all">All columns: <code className="text-slate-300">{COLUMNS}</code></p>
          <p>Tip: an asset export from the overview uses the same columns, so you can export, edit and import back. Nothing is written until every row is valid.</p>
        </div>
        <ImportForm />
      </Section>
    </div>
  );
}
