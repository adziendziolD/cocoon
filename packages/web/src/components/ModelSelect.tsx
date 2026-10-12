import { useState } from 'react';
import { useT } from '../i18n';
import { Input, Select } from './Field';

const OTHER = '\u0000other';

/**
 * Model picker: a list of known models (e.g. discovered by the connection test) with an
 * "enter another model" escape hatch; a plain text field if no models are known.
 */
export function ModelSelect({
  value,
  onChange,
  models,
  invalid,
  placeholder,
  id,
  className,
  allowEmpty,
  emptyLabel,
}: {
  value: string;
  onChange: (model: string) => void;
  models: string[];
  invalid?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  /** Offer an empty choice (e.g. "provider default"); otherwise the empty option is only a prompt. */
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const t = useT();
  const list = Array.from(new Set(models.filter(Boolean)));
  const [manual, setManual] = useState(() => !!value && !list.includes(value));
  const invalidCls = invalid ? 'border-red-500 focus:border-red-500 focus:ring-red-500/25' : undefined;

  if (list.length === 0 || manual) {
    return (
      <div className={className}>
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} invalid={invalid} className="font-mono" placeholder={placeholder ?? 'model-name'} />
        {list.length > 0 && (
          <button
            type="button"
            className="mt-1 text-xs text-accent hover:underline"
            onClick={() => {
              setManual(false);
              if (!list.includes(value)) onChange(allowEmpty ? '' : list[0]!);
            }}
          >
            {t('compat.model.fromList', { count: list.length })}
          </button>
        )}
      </div>
    );
  }

  return (
    <Select
      id={id}
      value={list.includes(value) ? value : ''}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setManual(true);
          return;
        }
        onChange(e.target.value);
      }}
      className={[className, 'font-mono', invalidCls].filter(Boolean).join(' ')}
    >
      {(allowEmpty || !list.includes(value)) && (
        <option value="" disabled={!allowEmpty}>
          {allowEmpty ? (emptyLabel ?? t('compat.model.default')) : t('compat.model.choose')}
        </option>
      )}
      {list.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={OTHER}>{t('compat.model.other')}</option>
    </Select>
  );
}
