type Listener = (event: any) => void;

const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: any): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A closed dashboard must not stop the runner.
    }
  }
}

module.exports = { subscribe, publish };
