// The only execution venue in phase 1 is the paper engine.
// Anything else refuses. There is no exchange client in this module.

const LIVE_MESSAGE = 'Fas 2 är låst. Live-läge kan inte startas. Det kräver skriftligt godkännande från ägaren och en juridisk granskning innan någon riktig handel får byggas.';

interface VenueError extends Error {
  code: string;
}

function locked(mode: string): VenueError {
  const err = new Error(LIVE_MESSAGE + ' Begärt läge: ' + mode + '.') as VenueError;
  err.name = 'TifiLiveLocked';
  err.code = 'LIVE_LOCKED';
  return err;
}

function assertNotLive(flag: unknown): void {
  if (flag === true || flag === 'live' || flag === '1' || flag === 1) {
    throw locked('live');
  }
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
  assertNotLive,
  createVenue,
};
