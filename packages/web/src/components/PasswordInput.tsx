import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { Input } from './Field';

/** Password field with a show/hide button. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { invalid?: boolean }>(function PasswordInput(
  { className, ...rest },
  ref,
) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={show ? 'text' : 'password'} className={cn('pr-10', className)} {...rest} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-subtle hover:text-fg"
        aria-label={show ? t('common.hide') : t('common.show')}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});
