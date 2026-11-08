import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import {
  CompleteUploadResponse,
  SignedPartsResponse,
  UploadSessionResponse,
} from './dto/upload-session.response';
import { VideoResponse, VideoStatusResponse } from './dto/video.response';
import { RangeNotSatisfiableFilter } from './filters/range-not-satisfiable.filter';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

// Multipart uploads and video players issue many requests per minute; the
// global 10 req/min auth throttle would break them (phase-03-videos validation #3)
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft with a unique slug in the caller's channel and opens a multipart upload. The response carries one presigned PUT URL per part; the file bytes go straight to storage, never through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload opened',
    type: UploadSessionResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'The user has no channel',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the configured maximum upload size',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Storage unavailable',
    schema: errorSchema,
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<UploadSessionResponse> {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Post(':slug/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Re-sign upload parts',
    description:
      'Issues fresh presigned URLs for the given part numbers, to resume an upload after the URLs expired or the connection dropped.',
  })
  @ApiResponse({
    status: 200,
    description: 'Fresh presigned URLs',
    type: SignedPartsResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not in draft',
    schema: errorSchema,
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignedPartsResponse> {
    return this.videosService.signParts(user.sub, slug, dto.partNumbers);
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts, moves the video to processing and enqueues the processing job (duration, metadata and thumbnail).',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing started',
    type: CompleteUploadResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or parts missing or invalid',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not in draft',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 503,
    description: 'Storage or processing queue unavailable',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponse> {
    return this.videosService.completeUpload(user.sub, slug, dto.parts);
  }

  @Delete(':slug/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description: 'Aborts the multipart upload and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted, draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not in draft',
    schema: errorSchema,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, slug);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns a processed (ready) video by its unique slug, with the stream, download and thumbnail URLs.',
  })
  @ApiResponse({ status: 200, description: 'The video', type: VideoResponse })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: errorSchema,
  })
  async findOne(@Param('slug') slug: string): Promise<VideoResponse> {
    return this.videosService.findReadyBySlug(slug);
  }

  @Get(':slug/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the processing status of a video',
    description:
      'Lets the owner follow the lifecycle draft → processing → ready | failed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current status',
    type: VideoStatusResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'The caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoStatusResponse> {
    return this.videosService.getStatusForOwner(user.sub, slug);
  }

  @Public()
  @Get(':slug/stream')
  @UseFilters(RangeNotSatisfiableFilter)
  @ApiHeader({
    name: 'Range',
    required: false,
    description: 'Byte range, e.g. bytes=0-1048575',
  })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Serves the video bytes. With a Range header the response is 206 Partial Content with only the requested bytes, so players can start and seek without downloading the whole file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video body (no Range header)',
  })
  @ApiResponse({ status: 206, description: 'Requested byte range' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 416,
    description: 'Range not satisfiable (Content-Range: bytes */size)',
    schema: errorSchema,
  })
  async stream(
    @Param('slug') slug: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.openStream(slug, range);

    res.status(video.partial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', video.contentType);
    res.setHeader('Content-Length', video.contentLength);
    if (video.partial) {
      res.setHeader(
        'Content-Range',
        `bytes ${video.start}-${video.end}/${video.totalSize}`,
      );
    }
    // Stop reading from storage when the player goes away (seek, close)
    res.on('close', () => video.stream.destroy());
    video.stream.pipe(res);
  }

  @Public()
  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived storage URL that downloads the original file as an attachment.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: errorSchema,
  })
  async download(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getDownloadUrl(slug) };
  }

  @Public()
  @Get(':slug/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description:
      'Redirects to a short-lived storage URL of the JPEG thumbnail.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: errorSchema,
  })
  async thumbnail(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getThumbnailUrl(slug) };
  }
}
