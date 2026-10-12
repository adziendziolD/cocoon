import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';

const control =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle shadow-sm transition-colors ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-surface-2 disabled:text-fg-muted';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  optional,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  optional?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
          {label}
          {optional && <span className="ml-1.5 font-normal text-fg-subtle">{t('common.optional')}</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : hint ? <p className="text-xs leading-relaxed text-fg-muted">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(control, 'h-9', invalid && 'border-red-500 focus:border-red-500 focus:ring-red-500/25', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(control, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
      <label htmlFor={id} className="cursor-pointer">
        <div className="text-sm font-medium text-fg">{label}</div>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</div>}
      </label>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 rounded accent-[var(--color-accent)]" />
      <span>
        <span className="block text-sm text-fg">{label}</span>
        {description && <span className="block text-xs text-fg-muted">{description}</span>}
      </span>
    </label>
  );
}

/** Large selectable card used for "choose one" questions (network mode, size, agent type). */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  badge,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/60',
      )}
    >
      {icon && <div className={cn('mt-0.5 shrink-0', selected ? 'text-accent' : 'text-fg-muted')}>{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{title}</span>
          {badge}
        </div>
        {description && <div className="mt-1 text-sm leading-relaxed text-fg-muted">{description}</div>}
      </div>
      <span className={cn('mt-1 size-4 shrink-0 rounded-full border-2', selected ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--color-surface)]' : 'border-line-strong')} />
    </button>
  );
}
