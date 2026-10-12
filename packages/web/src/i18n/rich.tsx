import { Fragment, type ReactNode } from 'react';

/**
 * Replaces `{name}` placeholders in an already translated text with React nodes, e.g.
 * `rich(t('spawn.description'), { sandbox: <strong>{name}</strong> })`.
 * Placeholders without a node are left as they are (so `t(key, params)` can fill plain values first).
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && m[1]! in nodes) return <Fragment key={i}>{nodes[m[1]!]}</Fragment>;
    return part ? <Fragment key={i}>{part}</Fragment> : null;
  });
}
