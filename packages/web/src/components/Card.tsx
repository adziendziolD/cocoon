import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start gap-3 border-b border-line px-5 py-4', className)}>
      {icon && <div className="mt-0.5 text-fg-muted">{icon}</div>}
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...rest} />;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {breadcrumb && <div className="mb-2 text-sm text-fg-muted">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-[15px] text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Key/value list used on detail pages. */
export function DetailList({ items }: { items: Array<{ label: ReactNode; value: ReactNode; hint?: ReactNode }> }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item, i) => (
        <div key={i} className="grid gap-1 py-2.5 sm:grid-cols-[200px_1fr] sm:gap-4">
          <dt className="text-sm text-fg-muted">{item.label}</dt>
          <dd className="min-w-0 text-sm text-fg">
            {item.value}
            {item.hint && <div className="mt-0.5 text-xs text-fg-subtle">{item.hint}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
