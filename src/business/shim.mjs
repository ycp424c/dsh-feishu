import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

// The old package exposes JSON tool schemas through TypeBox. Keep the wire
// schema, without importing its gateway, account resolver or channel runtime.
const optional = Symbol('optional')
export const Type = {
  String: (x = {}) => ({ type: 'string', ...x }), Number: (x = {}) => ({ type: 'number', ...x }),
  Integer: (x = {}) => ({ type: 'integer', ...x }), Boolean: (x = {}) => ({ type: 'boolean', ...x }),
  Literal: x => ({ type: typeof x, const: x }), Unsafe: x => x,
  Optional: x => ({ ...x, [optional]: true }),
  Array: (items, x = {}) => ({ type: 'array', items, ...x }),
  Union: anyOf => ({ anyOf }), Record: (_, values, x = {}) => ({ type: 'object', additionalProperties: values, ...x }),
  Object: (properties, x = {}) => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !properties[k][optional]), ...x }),
}
export const optionalPositiveIntegerSchema = x => Type.Optional(Type.Integer({ minimum: 1, ...x }))
export function readPositiveIntegerParam(args, key, opts = {}) {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0 || (opts.max && value > opts.max)) throw new Error(opts.message ?? `Invalid ${key}`)
  return value
}
export const normalizeOptionalString = x => typeof x === 'string' && x.trim() ? x.trim() : undefined
export const normalizeLowercaseStringOrEmpty = x => normalizeOptionalString(x)?.toLowerCase() ?? ''
export const readStringValue = x => typeof x === 'string' ? x : undefined
export const readString = readStringValue
export const uniqueStrings = x => [...new Set(x)]
export const isRecord$1 = x => x !== null && typeof x === 'object' && !Array.isArray(x)
export const jsonResult = details => ({ details })
// Never echo SDK errors containing request headers, configuration or tokens.
export const formatErrorMessage = error => `Feishu operation failed (${error?.response?.data?.code ?? error?.code ?? 'API_ERROR'})`
export const formatFeishuApiError = formatErrorMessage
export const encodeQuery = args => { const p = new URLSearchParams(Object.entries(args).filter(([, v]) => v !== undefined)); return p.size ? `?${p}` : '' }
export const extractReplyText = reply => (reply?.content?.elements ?? []).flatMap(x => x?.elements ?? []).map(x => x?.text ?? '').join('')
export const extensionForMime = mime => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' })[mime]

export const execution = new AsyncLocalStorage()
export const resolveToolsConfig = () => ({ doc: true, chat: true, wiki: true, drive: true, scopes: true, bitable: true, perm: false })
export const resolveAnyEnabledFeishuToolsConfig = resolveToolsConfig
export const listEnabledFeishuAccounts = () => [{ accountId: 'default', enabled: true, configured: true, config: { tools: resolveToolsConfig() } }]
export function resolveFeishuToolAccount({ executeParams = {} } = {}) {
  if (executeParams.accountId !== undefined && executeParams.accountId !== 'default') throw new Error('Unsupported account')
  return { ...listEnabledFeishuAccounts()[0], config: { mediaMaxMb: 20, tools: resolveToolsConfig() } }
}
export function createFeishuClient() {
  const context = execution.getStore()
  if (!context?.client) throw new Error('No trusted execution context')
  return context.client
}
export const createFeishuToolClient = createFeishuClient

export async function localMedia(path, { maxBytes, localRoots = [] }) {
  const actual = await realpath(path)
  const roots = await Promise.all(localRoots.map(p => realpath(p)))
  const admitted = execution.getStore()?.turn?.allowedFiles ?? []
  if (!admitted.includes(actual) && !roots.some(root => { const p = relative(root, actual); return p === '' || (!p.startsWith('..') && !isAbsolute(p)) })) throw new Error('Media outside allowed workspace')
  const metadata=await stat(actual)
  if (!metadata.isFile() || metadata.size===0 || metadata.size>maxBytes) throw new Error('Invalid media size')
  const buffer = await readFile(actual)
  if (buffer.length > maxBytes) throw new Error('Media exceeds limit')
  const hashes = execution.getStore()?.mediaHashes
  if (hashes && hashes[actual] !== createHash('sha256').update(buffer).digest('hex')) throw new Error('Attachment changed after confirmation')
  return { buffer, actual }
}
export function getFeishuRuntime() {
  const remote = async () => { throw new Error('Remote image fetch requires downloading to the workspace first') }
  // Avoid introducing SSRF through Markdown image URLs. Local files/data URIs
  // are supported; fetched remote images must pass the normal attachment path.
  return { media: { loadWebMedia: localMedia }, channel: { media: { readRemoteMediaBuffer: remote } } }
}

export function validate(schema, value) {
  if (schema.anyOf) { if (!schema.anyOf.some(s => { try { validate(s, value); return true } catch { return false } })) throw new Error('Invalid action parameters'); return }
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) throw new Error('Invalid parameter type')
  if ('const' in schema && value !== schema.const || schema.enum && !schema.enum.includes(value)) throw new Error('Invalid parameter value')
  if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error('Parameter outside bounds')
  if (schema.type === 'object') {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) throw new Error(`Missing ${k}`)
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v)
      else if (schema.properties) throw new Error(`Unsupported parameter ${k}`)
    }
  }
  if (schema.type === 'array') for (const v of value) validate(schema.items, v)
}

// DSH's supported schema subset has an object root and no anyOf or numeric
// bounds. Flatten action variants for presentation; validate the complete
// original schema above immediately before execution.
export function dshSchema(schema) {
  if (schema.anyOf) {
    if (schema.anyOf.every(s => s.type === 'object')) {
      const properties = {}, branches = schema.anyOf
      for (const s of branches) for (const [k, v] of Object.entries(s.properties)) {
        if (!(k in properties)) properties[k] = dshSchema(v)
        else if (k === 'action') properties[k] = { type: 'string', enum: branches.map(b => b.properties.action.const) }
      }
      return { type: 'object', properties, required: branches[0].required.filter(k => branches.every(b => b.required.includes(k))), additionalProperties: false }
    }
    return {} // Original validation remains authoritative for nested unions.
  }
  if (Array.isArray(schema.type)) return {}
  const out = {}
  for (const k of ['type', 'const', 'enum', 'description', 'title']) if (schema[k] !== undefined) out[k] = schema[k]
  if (schema.properties) { out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, dshSchema(v)])); out.required = schema.required; out.additionalProperties = false }
  if (schema.items) out.items = dshSchema(schema.items)
  return out
}
