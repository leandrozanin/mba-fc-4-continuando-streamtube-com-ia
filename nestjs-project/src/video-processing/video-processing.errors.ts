// Raised inside the worker; never reaches HTTP, so it is not a DomainException
export class VideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProcessingError';
  }
}
