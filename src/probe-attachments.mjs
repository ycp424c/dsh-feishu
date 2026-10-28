// Authenticated, synthetic acceptance only: no paths, remote URLs or Feishu file keys.
export const probeBodyLimit = 3 * 1024 * 1024
export function decodeProbeAttachments(input = []) {
  const invalid = () => { throw Object.assign(new Error('invalid_probe'), { code: 'invalid_probe' }) }
  if (!Array.isArray(input) || input.length > 10) invalid()
  const resources = [], data = new Map()
  let bytes = 0
  for (const [index, item] of input.entries()) {
    if (!item || !['image', 'file'].includes(item.type) || typeof item.data !== 'string' ||
      (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 255))) invalid()
    const value = Buffer.from(item.data, 'base64')
    bytes += value.length
    if (value.toString('base64') !== item.data || bytes > 2 * 1024 * 1024) invalid()
    const fileKey = String(index)
    resources.push({ type: item.type, fileKey, fileName: item.name })
    data.set(fileKey, value)
  }
  return { resources, data }
}
