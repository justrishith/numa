import { EventEmitter } from "node:events";

export interface NumaEvent {
  type: string;
  executionId: string;
  at: string;
  data?: unknown;
}

export type EventListener = (event: NumaEvent) => void;

export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    // A slow dashboard subscriber must not take the agent down.
    this.#emitter.setMaxListeners(64);
  }

  publish(event: NumaEvent): void {
    this.#emitter.emit("event", event);
  }

  subscribe(listener: EventListener): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
