const crypto = require('crypto');

/**
 * Simple PIN-based authentication.
 *
 * Generates a random 4-digit PIN on startup. Clients authenticate by
 * submitting the PIN to get an HMAC-SHA256 session token. The token
 * is verified on every WebSocket connection and API request.
 */

class Auth {
  constructor(options = {}) {
    // Allow user-specified PIN or generate random 4-digit
    this.pin = options.pin || String(Math.floor(1000 + Math.random() * 9000));
    this.disabled = options.disabled || false;

    // Secret used for HMAC — unique per server start
    this.secret = crypto.randomBytes(32).toString('hex');
  }

  /**
   * Create a session token from a PIN.
   * Returns null if PIN is wrong.
   */
  createToken(pin) {
    if (!this.disabled && pin !== this.pin) return null;
    return this._hmac(pin || 'no-auth');
  }

  /**
   * Validate a session token.
   */
  validateToken(token) {
    if (this.disabled) return true;
    if (!token) return false;
    try {
      const expected = this._hmac(this.pin);
      const tokenBuf = Buffer.from(token, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (tokenBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(tokenBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Extract token from request — checks Authorization header and query string.
   */
  extractToken(req) {
    // Check Authorization: Bearer <token>
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // Check query param ?token=<token>
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return url.searchParams.get('token');
  }

  /**
   * Express/http middleware-style check. Returns true if authorized.
   */
  check(req) {
    if (this.disabled) return true;
    const token = this.extractToken(req);
    return this.validateToken(token);
  }

  _hmac(data) {
    return crypto.createHmac('sha256', this.secret).update(data).digest('hex');
  }
}

module.exports = { Auth };
