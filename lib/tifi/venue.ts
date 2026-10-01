// The only execution venue in phase 1 is the paper engine.
// Anything else refuses. There is no exchange client in this module.

const LIVE_MESSAGE = 'Fas 2 är låst. Live-läge kan inte startas. Det kräver skriftligt godkännande från ägaren och en juridisk granskning innan någon riktig handel får byggas.';
const WORLD_LIVE_MESSAGE = 'Riktiga pengar är inte tillåtna. Juridisk granskning har sagt nej till World och PayBox. Inga riktiga order skickas.';

interface VenueError extends Error {
  code: string;
}

function locked(mode: string): VenueError {
  const realWorld = /world|paybox/i.test(mode);
  const message = realWorld ? WORLD_LIVE_MESSAGE : LIVE_MESSAGE;
  const err = new Error(message + ' Begärt läge: ' + mode + '.') as VenueError;
  err.name = 'TifiLiveLocked';
  err.code = 'LIVE_LOCKED';
  return err;
}

function assertNotLive(flag: unknown): void {
  const text = String(flag == null ? '' : flag).toLowerCase();
  if (flag === true || flag === 1 || text === '1' || text === 'live' || text === 'world' || text === 'paybox' || text === 'world-live' || text === 'paybox-live') {
    throw locked(text || 'live');
  }
}

function executeLiveWorld(): never {
  throw locked('paybox');
}

function createVenue(mode: string | undefined, deps: { placeOrder: (db: any, args: any) => Promise<any> }): {
  mode: 'paper';
  place: (db: any, args: any) => Promise<any>;
} {
  const requested = mode == null || mode === '' ? 'paper' : String(mode);
  if (requested !== 'paper') throw locked(requested);
  assertNotLive(false);
  return {
    mode: 'paper',
    place(db: any, args: any) {
      return deps.placeOrder(db, args);
    },
  };
}

module.exports = {
  LIVE_MESSAGE,
  WORLD_LIVE_MESSAGE,
  assertNotLive,
  createVenue,
  executeLiveWorld,
};
