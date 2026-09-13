/**
 * Whether a word following a space could be a continuation of a file path.
 * Accepts segments that contain a path separator (`\` or `/`), or that end
 * with a file extension — the latter covers filenames containing spaces
 * such as "第六章 框架开发实践.md". A trailing `#L10-20` line marker is
 * stripped first so the extension is still visible.
 */
export function looksLikePathSegment(segment: string): boolean {
  const withoutLineMarker = segment.replace(/#L\d+(?:-\d+)?$/, '');
  return (
    /[\\/]/.test(withoutLineMarker) || // contains a path separator (dir / absolute segment)
    /\.[A-Za-z0-9]{1,10}$/.test(withoutLineMarker) // ends with a file extension (filename with spaces)
  );
}
