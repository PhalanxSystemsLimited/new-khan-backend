export class AppError extends Error {
  constructor(statusCode, message, code = 'ERROR', details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(msg = 'Bad request', details) {
    return new AppError(400, msg, 'BAD_REQUEST', details);
  }
  static unauthorized(msg = 'Authentication required') {
    return new AppError(401, msg, 'UNAUTHORIZED');
  }
  static forbidden(msg = 'You do not have permission to perform this action') {
    return new AppError(403, msg, 'FORBIDDEN');
  }
  static notFound(msg = 'Resource not found') {
    return new AppError(404, msg, 'NOT_FOUND');
  }
  static conflict(msg = 'Conflict', details) {
    return new AppError(409, msg, 'CONFLICT', details);
  }
  static unprocessable(msg, details) {
    return new AppError(422, msg, 'UNPROCESSABLE', details);
  }
}
