// Product limit (10GB); VIDEO_MAX_UPLOAD_BYTES may lower it per environment
export const MAX_VIDEO_SIZE_BYTES = 10737418240;
// S3 multipart limit
export const MAX_UPLOAD_PARTS = 10000;
export const SLUG_MAX_ATTEMPTS = 5;
export const VIDEO_CONTENT_TYPE_PATTERN = /^video\/[\w.+-]+$/;
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
export const THUMBNAIL_URL_TTL_SECONDS = 300;
