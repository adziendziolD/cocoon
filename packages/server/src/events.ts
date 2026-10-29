import { EventEmitter } from 'node:events';
import type { CocoonEvent } from '@cocoon/protocol';

export class EventBus {
  // Every websocket client and every pending agent.wait subscribes; a high but finite limit still makes Node warn about leaks.
  private readonly emitter = new EventEmitter().setMaxListeners(1000);

  publish(event: CocoonEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: CocoonEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
