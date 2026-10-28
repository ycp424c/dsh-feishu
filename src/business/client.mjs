import { Client, defaultHttpInstance } from '@larksuiteoapi/node-sdk'

// Bound individual SDK requests, including tenant-token acquisition. No retry
// layer is introduced for writes: unknown outcomes stay in the durable ledger.
export function businessClient(options) {
  const httpInstance = Object.create(defaultHttpInstance)
  httpInstance.request = config => defaultHttpInstance.request({ ...config, timeout: 30000 })
  for (const method of ['get', 'delete', 'head', 'options']) httpInstance[method] = (url, config = {}) => defaultHttpInstance[method](url, { ...config, timeout: 30000 })
  for (const method of ['post', 'put', 'patch']) httpInstance[method] = (url, data, config = {}) => defaultHttpInstance[method](url, data, { ...config, timeout: 30000 })
  return new Client({ ...options, httpInstance })
}
