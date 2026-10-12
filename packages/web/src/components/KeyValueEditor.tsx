import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from './Button';
import { useT } from '../i18n';
import { Input } from './Field';

export type KeyValueRow = [key: string, value: string];

export const toRows = (rec: Record<string, string> | undefined): KeyValueRow[] => Object.entries(rec ?? {});
export const fromRows = (rows: KeyValueRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));

/** Editable list of environment variables (NAME = value). */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'NAME',
  valuePlaceholder,
  addLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const t = useT();
  const update = (i: number, idx: 0 | 1, value: string) => onChange(rows.map((r, j) => (j === i ? ((idx === 0 ? [value, r[1]] : [r[0], value]) as KeyValueRow) : r)));
  return (
    <div className="space-y-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={k} onChange={(e) => update(i, 0, e.target.value)} placeholder={keyPlaceholder} className="w-2/5 font-mono" />
          <span className="text-fg-subtle">=</span>
          <Input value={v} onChange={(e) => update(i, 1, e.target.value)} placeholder={valuePlaceholder ?? t('common.value')} className="flex-1 font-mono" />
          <IconButton label={t('common.remove')} icon={<Trash2 className="size-4" />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, ['', '']])}>
        {addLabel ?? t('kv.addVariable')}
      </Button>
    </div>
  );
}
