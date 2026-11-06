import { ZodError } from 'zod';

/**
 * Validate request parts against Zod schemas.
 * Parsed (and stripped/coerced) values are stored on req.valid.{body,query,params}.
 * Handlers must read from req.valid, never from the raw req.body / req.query.
 *
 * Unknown keys are rejected for bodies (schemas use .strict()), so clients
 * cannot smuggle fields such as `role` or `totalAmount`.
 */
export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    try {
      req.valid = req.valid ?? {};
      if (params) req.valid.params = params.parse(req.params);
      if (query) req.valid.query = query.parse(req.query ?? {});
      if (body) req.valid.body = body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) return next(err);
      next(err);
    }
  };
}
