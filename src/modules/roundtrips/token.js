import { randomBytes } from 'node:crypto';

/** Shape of a report token: 128 random bits as base64url (22 characters). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,32}$/;

/** A new unguessable report token. */
export const newToken = () => randomBytes(16).toString('base64url');
