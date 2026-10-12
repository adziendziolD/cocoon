import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from '../components/Toast';
import { describeError } from './rpc';

interface ActionOptions<TVars, TResult> {
  /** Toast title on success (omit for silent success). */
  success?: string | ((result: TResult, vars: TVars) => string | undefined);
  /** Toast title on failure, e.g. t('startStop.startFailed'). */
  error: string;
  /** Queries to refetch afterwards. */
  invalidate?: QueryKey[] | ((vars: TVars) => QueryKey[]);
  onSuccess?: (result: TResult, vars: TVars) => void;
}

/** useMutation with consistent toasts and cache invalidation. */
export function useAction<TVars = void, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>, opts: ActionOptions<TVars, TResult>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      const keys = typeof opts.invalidate === 'function' ? opts.invalidate(vars) : (opts.invalidate ?? []);
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
      const title = typeof opts.success === 'function' ? opts.success(result, vars) : opts.success;
      if (title) toast.success(title);
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => toast.error(opts.error, describeError(err)),
  });
}
