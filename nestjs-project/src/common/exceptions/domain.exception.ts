export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoForbiddenException extends DomainException {
  constructor() {
    super('VIDEO_FORBIDDEN', 403, 'You do not own this video');
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found');
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'Video upload is not in progress',
    );
  }
}

export class VideoUploadIncompleteException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_INCOMPLETE',
      400,
      'Uploaded parts are missing or invalid',
    );
  }
}

export class RangeNotSatisfiableException extends DomainException {
  constructor(public readonly totalSize: number) {
    super('RANGE_NOT_SATISFIABLE', 416, 'Requested range not satisfiable');
  }
}

export class StorageUnavailableException extends DomainException {
  constructor() {
    super('STORAGE_UNAVAILABLE', 503, 'Storage service unavailable');
  }
}

export class QueueUnavailableException extends DomainException {
  constructor() {
    super('QUEUE_UNAVAILABLE', 503, 'Processing queue unavailable');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the maximum upload size');
  }
}
