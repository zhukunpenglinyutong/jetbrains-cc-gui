type BlockLike = Record<string, unknown>;

function compactValueSignature(value: unknown, depth = 0): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return `s:${value.length}:${value.slice(0, 160)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${typeof value}:${String(value)}`;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `array:${value.length}`;
    return `[${value.slice(0, 8).map((item) => compactValueSignature(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (depth >= 2) return 'object';
    const record = value as BlockLike;
    return `{${Object.keys(record).sort().slice(0, 24)
      .map((key) => `${key}:${compactValueSignature(record[key], depth + 1)}`)
      .join(',')}}`;
  }
  return typeof value;
}

export function getStructuralBlockSignature(block: BlockLike): string {
  if (block.type === 'tool_use') {
    return `tool_use:${block.id ?? ''}:${block.name ?? ''}:${compactValueSignature(block.input)}`;
  }
  if (block.type === 'tool_result') {
    return `tool_result:${block.tool_use_id ?? ''}:${block.is_error === true ? '1' : '0'}:${compactValueSignature(block.content)}`;
  }
  if (block.type === 'attachment') {
    return `attachment:${block.fileName ?? ''}:${block.mediaType ?? ''}`;
  }
  if (block.type === 'image') {
    return `image:${block.src ?? ''}:${block.mediaType ?? ''}`;
  }
  return String(block.type ?? '');
}
