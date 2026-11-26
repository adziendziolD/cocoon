import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AttachmentType, type Task, type TaskAttachment } from '@cocoon/protocol';
import { ImageOff, ImagePlus, X } from 'lucide-react';
import { ApiError, rpc } from '../../api/rpc';
import { useT } from '../../i18n';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { useToast } from '../Toast';

/** An image in the task dialog: already stored with the task, or picked and not uploaded yet. */
export type DraftImage =
  | { kind: 'stored'; key: string; attachment: TaskAttachment }
  | { kind: 'new'; key: string; name: string; size: number; /** Data URL of the file: the preview, and what is uploaded. */ url: string };

/** Changes the images of the draft, from what they are at that moment (several files can be read at once). */
export type SetImages = (update: (images: DraftImage[]) => DraftImage[]) => void;

const ACCEPT = Object.keys(ATTACHMENT_TYPES).join(',');
const isImageType = (type: string): type is AttachmentType => type in ATTACHMENT_TYPES;
let nextKey = 1;

export const storedImages = (task?: Task): DraftImage[] => (task?.attachments ?? []).map((attachment) => ({ kind: 'stored', key: attachment.id, attachment }));

/** Ids of the stored images that `next` no longer has. */
export const removedImages = (before: DraftImage[], next: DraftImage[]): string[] =>
  before.flatMap((i) => (i.kind === 'stored' && !next.some((n) => n.key === i.key) ? [i.attachment.id] : []));

/**
 * Uploads the new images of the dialog and removes the stored ones the user took out (`removed`): only those, images
 * somebody else added in the meantime stay. `uploaded` hears of every image that is stored now, so a second try after
 * a failure does not upload it again.
 */
export async function syncImages(taskId: string, images: DraftImage[], removed: string[], uploaded?: (key: string, attachment: TaskAttachment) => void): Promise<void> {
  for (const attachmentId of removed) {
    await rpc('task.remove_attachment', { taskId, attachmentId }).catch((err: unknown) => {
      // Already removed by somebody else: that is what was wanted.
      if (!(err instanceof ApiError && err.code === 'not_found')) throw err;
    });
  }
  for (const image of images) {
    if (image.kind !== 'new') continue;
    const task = await rpc('task.add_attachment', { taskId, name: image.name, content: image.url.slice(image.url.indexOf(',') + 1) });
    uploaded?.(image.key, task.attachments[task.attachments.length - 1]!);
  }
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Base64 of a stored image as a data URL (loaded once per image). */
function useImageUrl(taskId: string | undefined, attachment: TaskAttachment | undefined) {
  return useQuery({
    queryKey: ['task.attachment', taskId, attachment?.id],
    queryFn: async () => {
      const file = await rpc('task.attachment', { taskId: taskId!, attachmentId: attachment!.id });
      return `data:${file.type};base64,${file.content}`;
    },
    enabled: !!taskId && !!attachment,
    staleTime: Infinity,
  });
}

function Thumbnail({ src, failed, name, onOpen, onRemove }: { src?: string; failed?: boolean; name: string; onOpen?: () => void; onRemove?: () => void }) {
  const t = useT();
  return (
    <div className="group relative size-20 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-2" title={name}>
      {src ? (
        <button type="button" onClick={onOpen} className="block size-full cursor-zoom-in" aria-label={t('taskImages.open', { name })}>
          <img src={src} alt={name} className="size-full object-cover" />
        </button>
      ) : failed ? (
        <div className="flex size-full items-center justify-center text-fg-subtle" role="img" aria-label={t('taskImages.failed', { name })}>
          <ImageOff className="size-5" />
        </div>
      ) : (
        <div className="size-full animate-pulse" />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('taskImages.remove', { name })}
          className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function StoredThumbnail({ taskId, attachment, onOpen, onRemove }: { taskId: string; attachment: TaskAttachment; onOpen: (src: string, name: string) => void; onRemove?: () => void }) {
  const url = useImageUrl(taskId, attachment);
  return <Thumbnail src={url.data} failed={url.isError} name={attachment.name} onOpen={() => url.data && onOpen(url.data, attachment.name)} onRemove={onRemove} />;
}

/** Full-size view of an image. */
function ImageViewer({ image, onClose }: { image: { src: string; name: string } | null; onClose: () => void }) {
  return (
    <Dialog open={!!image} onClose={onClose} size="xl" title={image?.name ?? ''}>
      {image && <img src={image.src} alt={image.name} className="mx-auto max-h-[70vh] max-w-full rounded-lg object-contain" />}
    </Dialog>
  );
}

/**
 * Adds images to a task in the task dialog: button, drag and drop onto the area, and pasting (use `onPaste` on the
 * description field too, so a screenshot from the clipboard lands here).
 */
export function useImagePicker(images: DraftImage[], setImages: SetImages, session: RefObject<number>) {
  const t = useT();
  const toast = useToast();
  const latest = useRef(images);
  latest.current = images;
  // Files that are being read: they count for the limit before they are in the draft.
  const reading = useRef(0);

  const add = async (files: File[]) => {
    const wanted = files.filter((f) => f.type.startsWith('image/'));
    if (!wanted.length) return false;
    let accepted = wanted.filter((file) => {
      if (!isImageType(file.type)) toast.error(t('taskImages.unsupported', { name: file.name || file.type }));
      else if (file.size > MAX_ATTACHMENT_BYTES) toast.error(t('taskImages.tooLarge', { name: file.name, mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
      else return true;
      return false;
    });
    const room = Math.max(0, MAX_ATTACHMENTS - latest.current.length - reading.current);
    if (accepted.length > room) {
      toast.error(t('taskImages.tooMany', { max: MAX_ATTACHMENTS }));
      accepted = accepted.slice(0, room);
    }
    if (!accepted.length) return true;
    const started = session.current;
    reading.current += accepted.length;
    try {
      const added = await Promise.all(
        accepted.map(async (file): Promise<DraftImage> => {
          const name =
            file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ATTACHMENT_TYPES[file.type as AttachmentType]}`;
          return { kind: 'new', key: `new-${nextKey++}`, name, size: file.size, url: await readDataUrl(file) };
        }),
      );
      // The dialog was closed or opened for another task while the files were read: they do not belong to this draft.
      if (session.current === started) setImages((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS));
    } catch {
      toast.error(t('taskImages.readFailed'));
    } finally {
      reading.current -= accepted.length;
    }
    return true;
  };

  const onPaste = (e: ClipboardEvent) => {
    // Office apps put a picture of the copied text next to the text: that paste is meant as text.
    if (e.clipboardData.types.includes('text/plain')) return;
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void add(files);
    }
  };
  return { add, onPaste };
}

export function ImageField({ taskId, images, setImages, add }: { taskId?: string; images: DraftImage[]; setImages: SetImages; add: (files: File[]) => Promise<boolean> }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<{ src: string; name: string } | null>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void add(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn('rounded-lg border border-dashed border-line p-3', dragging && 'border-accent bg-accent/5')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {images.map((image) => {
          const remove = () => setImages((current) => current.filter((i) => i.key !== image.key));
          return image.kind === 'stored' && taskId ? (
            <StoredThumbnail key={image.key} taskId={taskId} attachment={image.attachment} onOpen={(src, name) => setViewing({ src, name })} onRemove={remove} />
          ) : image.kind === 'new' ? (
            <Thumbnail key={image.key} name={image.name} src={image.url} onOpen={() => setViewing({ src: image.url, name: image.name })} onRemove={remove} />
          ) : null;
        })}
        {images.length < MAX_ATTACHMENTS && (
          <Button size="sm" variant="ghost" icon={<ImagePlus className="size-4" />} onClick={() => input.current?.click()}>
            {t('taskImages.add')}
          </Button>
        )}
        <span className="text-xs text-fg-muted">{t('taskImages.hint')}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <ImageViewer image={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/** The task's images in the task drawer (read only). */
export function TaskImageGallery({ task }: { task: Task }) {
  const [viewing, setViewing] = useState<{ src: string; name: string } | null>(null);
  if (!task.attachments?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {task.attachments.map((attachment) => (
        <StoredThumbnail key={attachment.id} taskId={task.id} attachment={attachment} onOpen={(src, name) => setViewing({ src, name })} />
      ))}
      <ImageViewer image={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
