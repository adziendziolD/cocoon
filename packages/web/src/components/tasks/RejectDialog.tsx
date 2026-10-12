import { useEffect, useState } from 'react';
import type { Task } from '@cocoon/protocol';
import { MessageSquareReply } from 'lucide-react';
import { rich, useT } from '../../i18n';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Field, Textarea } from '../Field';
import { useTaskActions } from './useTaskActions';

/** "Request changes": the agent continues with your feedback. */
export function RejectDialog({ task, open, onClose }: { task: Task | null; open: boolean; onClose: () => void }) {
  const t = useT();
  const { reject } = useTaskActions();
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (open) setFeedback('');
  }, [open]);
  const go = () => task && feedback.trim() && reject.mutate({ taskId: task.id, feedback: feedback.trim() }, { onSuccess: onClose });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!reject.isPending}
      title={t('reject.title')}
      description={task ? rich(t('reject.description'), { task: <strong className="text-fg">{task.title}</strong> }) : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={reject.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<MessageSquareReply className="size-4" />} loading={reject.isPending} disabled={!feedback.trim()} onClick={go}>
            {t('reject.submit')}
          </Button>
        </>
      }
    >
      <Field label={t('reject.feedback')} hint={t('reject.hint')}>
        <Textarea
          value={feedback}
          rows={5}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t('reject.placeholder')}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && go()}
        />
      </Field>
    </Dialog>
  );
}
