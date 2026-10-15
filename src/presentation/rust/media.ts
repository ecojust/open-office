/** Match the native host's decoded-file limit before reading or base64-encoding
 * a file. Picture, audio and video deliveries share the same Rust inbox bound. */
export const PRESENTATION_MEDIA_MAX_BYTES = 32 * 1024 * 1024

export function validatePresentationMedia(file: { name: string; size: number }, purpose: string): void {
  if (file.size > PRESENTATION_MEDIA_MAX_BYTES) throw Error('插入的媒体不能超过 32 MiB。')
  const allowed = purpose === 'audio' ? /\.(mp3|wav|m4a|ogg|flac)$/i
    : purpose === 'video' ? /\.(mp4|webm|mov|m4v)$/i
      : purpose === 'picture' ? /\.(png|jpe?g|gif|webp|bmp|svg)$/i : undefined
  if (!allowed?.test(file.name)) throw Error('请选择此功能支持的文件格式。')
}
