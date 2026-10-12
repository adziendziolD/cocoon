import { Compass } from 'lucide-react';
import { ButtonLink } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { useT } from '../i18n';

export function NotFoundPage() {
  const t = useT();
  return (
    <EmptyState
      icon={<Compass className="size-6" />}
      title={t('notFound.title')}
      action={
        <ButtonLink to="/" variant="primary">
          {t('notFound.toDashboard')}
        </ButtonLink>
      }
    >
      {t('notFound.text')}
    </EmptyState>
  );
}
