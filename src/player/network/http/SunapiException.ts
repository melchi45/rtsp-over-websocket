/** Ported from the legacy player’s Network/http/sunapiException.js. */
export class SunapiException {
  name?: string;
  message?: string;

  toString(): string {
    const name = this.name || 'unknown';
    const message = this.message || 'no description';
    return `[${name}] ${message}`;
  }
}
