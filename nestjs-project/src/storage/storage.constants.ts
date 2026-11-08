export const S3_CLIENT = Symbol('S3_CLIENT');
export const S3_SIGNING_CLIENT = Symbol('S3_SIGNING_CLIENT');

export function videoObjectKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}.jpg`;
}
