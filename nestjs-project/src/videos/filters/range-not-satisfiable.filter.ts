import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { RangeNotSatisfiableException } from '../../common/exceptions/domain.exception';

// RFC 9110: a 416 must tell the client the current length of the resource
@Catch(RangeNotSatisfiableException)
export class RangeNotSatisfiableFilter implements ExceptionFilter {
  catch(exception: RangeNotSatisfiableException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response
      .status(exception.httpStatus)
      .setHeader('Content-Range', `bytes */${exception.totalSize}`)
      .json({
        statusCode: exception.httpStatus,
        error: exception.errorCode,
        message: exception.message,
      });
  }
}
