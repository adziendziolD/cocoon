import { useEffect, useRef } from 'react';
import type { AgentTool, ImageKind, MethodParams } from '@cocoon/protocol';
import { CircleCheck, CircleX, Hammer } from 'lucide-react';
import { buildStore, useBuild, type BuildKey } from '../api/builds';
import { qk } from '../api/keys';
import { useImages } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { useT, type MessageKey, type TFunction } from '../i18n';
import { Button } from './Button';
import { Spinner } from './States';

const IMAGE_LABEL_KEY: Record<ImageKind, MessageKey> = { sandbox: 'build.image.sandbox', proxy: 'build.image.proxy', agents: 'build.image.agents' };

/** Display name of an image kind in the active language. */
export function imageLabel(t: TFunction, kind: ImageKind): string {
  return t(IMAGE_LABEL_KEY[kind]);
}


/**
 * Button that starts an image build (the log appears in <BuildLog/>).
 * - sandbox: `sandboxVariant` picks the slim (default) or full image (adds compilers + Python).
 * - agents:  `tools` limits which agent CLIs are installed into the toolbox (default: all).
 */
export function BuildImageButton({
  kind,
  sandboxVariant = 'slim',
  tools,
  label,
  variant = 'primary',
  size,
  disabled,
}: {
  kind: ImageKind;
  sandboxVariant?: 'slim' | 'full';
  tools?: AgentTool[];
  label?: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm';
  disabled?: boolean;
}) {
  const t = useT();
  const build = useBuild(kind);
  const images = useImages();
  const serverBuilding = images.data?.find((i) => i.kind === kind)?.building;
  const action = useAction((v: MethodParams<'image.build'>) => rpc('image.build', v), {
    success: t('build.started'),
    error: t('build.startFailed'),
    invalidate: [qk.images],
    onSuccess: (res, v) => buildStore.start(v.kind, res.buildId),
  });
  const running = build?.status === 'running' || !!serverBuilding;
  const params: MethodParams<'image.build'> =
    kind === 'sandbox' ? { kind, variant: sandboxVariant } : kind === 'agents' ? { kind, ...(tools ? { tools } : {}) } : { kind };
  return (
    <Button
      variant={variant}
      size={size}
      icon={<Hammer className={size === 'sm' ? 'size-3.5' : 'size-4'} />}
      loading={action.isPending || running}
      disabled={disabled}
      onClick={() => action.mutate(params)}
    >
      {running ? t('build.building') : (label ?? t('build.buildImage', { image: imageLabel(t, kind) }))}
    </Button>
  );
}

/** Live build output for one image kind. Renders nothing if no build happened in this session. */
export function BuildLog({ kind, className }: { kind: BuildKey; className?: string }) {
  const t = useT();
  const build = useBuild(kind);
  const ref = useRef<HTMLPreElement>(null);
  const images = useImages();
  const serverBuilding = images.data?.find((i) => i.kind === kind)?.building;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [build?.lines.length]);

  if (!build) {
    if (!serverBuilding) return null;
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> {t('build.serverBuilding')}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 text-sm">
        {build.status === 'running' && (
          <>
            <Spinner /> <span className="text-fg-muted">{t('build.runningHint')}</span>
          </>
        )}
        {build.status === 'succeeded' && (
          <>
            <CircleCheck className="size-4 text-emerald-600" /> <span className="font-medium text-emerald-700 dark:text-emerald-400">{t('build.succeeded')}</span>
          </>
        )}
        {build.status === 'failed' && (
          <>
            <CircleX className="size-4 text-red-600" />
            <span className="font-medium text-red-700 dark:text-red-400">{build.error ? t('build.failedWithError', { error: build.error }) : t('build.failed')}</span>
          </>
        )}
      </div>
      <pre ref={ref} className="max-h-72 overflow-auto rounded-lg bg-gray-950 p-3 font-mono text-xs leading-relaxed text-gray-300">
        {build.lines.length ? build.lines.join('\n') : t('build.waiting')}
      </pre>
    </div>
  );
}
