export class RepoGraphError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RepoGraphError';
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
