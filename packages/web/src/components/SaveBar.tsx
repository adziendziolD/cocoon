import { Save, Undo2 } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './Button';

/** Sticky bar that appears when a form has unsaved changes. */
export function SaveBar({ visible, onSave, onDiscard, saving, disabled, message }: { visible: boolean; onSave: () => void; onDiscard: () => void; saving?: boolean; disabled?: boolean; message?: string }) {
  const t = useT();
  if (!visible) return null;
  return (
    <div className="animate-in sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
      <span className="flex-1 text-sm text-fg">{message ?? t('common.unsavedChanges')}</span>
      <Button icon={<Undo2 className="size-4" />} onClick={onDiscard}>
        {t('common.discard')}
      </Button>
      <Button variant="primary" icon={<Save className="size-4" />} onClick={onSave} loading={saving} disabled={disabled}>
        {t('common.save')}
      </Button>
    </div>
  );
}
