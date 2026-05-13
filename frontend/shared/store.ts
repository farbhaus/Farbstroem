export type Subscriber<T> = (state: T) => void;

export type Store<T> = {
  get(): T;
  set(patch: Partial<T> | ((s: T) => T)): void;
  subscribe(fn: Subscriber<T>): () => void;
};

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<Subscriber<T>>();
  return {
    get: () => state,
    set: (patch) => {
      state = typeof patch === 'function' ? (patch as (s: T) => T)(state) : { ...state, ...patch };
      subs.forEach((fn) => fn(state));
    },
    subscribe: (fn) => {
      subs.add(fn);
      fn(state);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
