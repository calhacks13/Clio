// A small typed, synchronous event emitter. Synchronous dispatch, observers first, keeps the
// recorded order causal. A throwing handler never breaks the others.

type Handler<T> = (payload: T) => void;
type AnyHandler<E> = <K extends keyof E>(type: K, payload: E[K]) => void;
export type ErrorReporter = (error: unknown, type: PropertyKey) => void;

export class Emitter<E extends object> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();
  private readonly anyHandlers = new Set<AnyHandler<E>>();

  constructor(private readonly onError: ErrorReporter = (err) => console.error(err)) {}

  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  once<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  onAny(handler: AnyHandler<E>): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /**
   * Wildcard observers (the recorder, logging) see the event first, then handlers react. Otherwise
   * an event emitted in reaction (a narration of a step) would be observed before its cause, and a
   * handler that ends the recording would stop it before the ending event was observed.
   */
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const observers = [...this.anyHandlers];
    const handlers = [...(this.handlers.get(type) ?? [])];
    for (const observe of observers) this.safely(type, () => observe(type, payload));
    for (const handler of handlers) this.safely(type, () => (handler as Handler<E[K]>)(payload));
  }

  private safely(type: keyof E, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.onError(err, type);
    }
  }
}
