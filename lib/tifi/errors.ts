class TifiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TifiError';
    this.code = code;
    this.status = status;
  }
}

function iso(clock?: () => Date): string {
  const date = clock ? clock() : new Date();
  return date.toISOString();
}

function userActor(userId: number): { type: 'user'; id: string; userId: number } {
  return { type: 'user', id: 'user:' + userId, userId };
}

function utcDay(value: string): string {
  return String(value || '').slice(0, 10);
}

module.exports = {
  TifiError,
  iso,
  userActor,
  utcDay,
};
