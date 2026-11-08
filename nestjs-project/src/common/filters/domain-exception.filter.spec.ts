import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  ChannelNotFoundException,
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  QueueUnavailableException,
  RangeNotSatisfiableException,
  StorageUnavailableException,
  TokenExpiredException,
  TokenReuseDetectedException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoUploadIncompleteException,
  VideoUploadNotInProgressException,
} from '../exceptions/domain.exception';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as any,
      switchToWs: () => ({}) as any,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    filter.catch(new InvalidCredentialsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: expect.any(String),
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    filter.catch(new EmailNotConfirmedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: expect.any(String),
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    filter.catch(new InvalidTokenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: expect.any(String),
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    filter.catch(new TokenExpiredException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: expect.any(String),
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    filter.catch(new TokenReuseDetectedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: expect.any(String),
    });
  });

  it.each([
    [new VideoNotFoundException(), 404, 'VIDEO_NOT_FOUND'],
    [new VideoForbiddenException(), 403, 'VIDEO_FORBIDDEN'],
    [new ChannelNotFoundException(), 404, 'CHANNEL_NOT_FOUND'],
    [
      new VideoUploadNotInProgressException(),
      409,
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    ],
    [new VideoUploadIncompleteException(), 400, 'VIDEO_UPLOAD_INCOMPLETE'],
    [new RangeNotSatisfiableException(100), 416, 'RANGE_NOT_SATISFIABLE'],
    [new StorageUnavailableException(), 503, 'STORAGE_UNAVAILABLE'],
    [new QueueUnavailableException(), 503, 'QUEUE_UNAVAILABLE'],
  ])('maps %p to its status and code', (exception, status, code) => {
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(status);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: status,
      error: code,
      message: exception.message,
    });
  });
});
