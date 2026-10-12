import { EventEmitter } from 'node:events';
import type { CocoonEvent } from '@cocoon/protocol';

export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: CocoonEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: CocoonEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
