// DSH model-gateway plugin entry.
//
// One Host row can supervise any number of local gateway processes and, for
// each gateway with a provider block, register an OpenAI Chat Completions
// route on DSH's `llm` service.  The process remains the unit of adaptation:
// a gateway can translate any upstream protocol into the small OpenAI surface
// this adapter consumes, while the plugin owns start, readiness, health,
// restart and shutdown.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, GatewayConfigError } from './lib/config.js'
import { GatewayManager } from './lib/supervisor.js'
import { createOpenAIAdapter } from './lib/openai-adapter.js'
import { registerGatewayTools } from './lib/tools.js'

const packageDir = path.dirname(fileURLToPath(import.meta.url))

export const name = 'model-gateway'
export const inject = ['tools', 'llm']

export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig, { packageDir })
  } catch (error) {
    const message = error instanceof GatewayConfigError ? error.message : String(error?.message ?? error)
    ctx.logger.error(`[model-gateway] invalid configuration: ${message}`)
    throw error
  }

  if (config.gateways.length === 0) {
    ctx.logger.info('[model-gateway] no gateways configured; plugin is dormant')
    return
  }

  const manager = new GatewayManager({ configs: config.gateways, ctx, packageDir })
  const llm = ctx.get('llm')
  if (llm === undefined) {
    ctx.logger.warn('[model-gateway] the llm service is unavailable; gateways will run without model routes')
  }

  const adapterHandles = []
  if (llm !== undefined) {
    for (const gateway of config.gateways) {
      if (gateway.provider === null || !gateway.enabled) continue
      const supervisor = manager.get(gateway.id)
      try {
        const adapter = createOpenAIAdapter({ config: gateway, supervisor, ctx, log: supervisor.logs })
        const handle = llm.registerAdapter([gateway.provider.route], adapter)
        adapterHandles.push(handle)
        ctx.logger.info(`[model-gateway:${gateway.id}] registered model route "${gateway.provider.route}"`)
      } catch (error) {
        supervisor.providerError = String(error?.message ?? error)
        ctx.logger.error(`[model-gateway:${gateway.id}] cannot register model route "${gateway.provider.route}": ${supervisor.providerError}`)
      }
    }
  }

  ctx.logger.info(`[model-gateway] managing ${config.gateways.length} gateway(s): ${config.gateways.map((gateway) => gateway.id).join(', ')}`)

  let toolsDisposer
  try {
    toolsDisposer = registerGatewayTools(ctx, manager)
  } catch (error) {
    ctx.logger.error(`[model-gateway] cannot register lifecycle tools: ${String(error?.message ?? error)}`)
    throw error
  }

  // Autostart is deliberately asynchronous: plugin activation must not block
  // the whole Host while a Python gateway boots.  The effect owns the timer so
  // an unload during boot cannot leave a process behind.
  ctx.effect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      manager.startAll().then((results) => {
        for (const result of results) {
          if (!result.ok) ctx.logger.warn(`[model-gateway:${result.id}] autostart failed: ${result.error}`)
        }
      }).catch((error) => {
        ctx.logger.error(`[model-gateway] autostart error: ${String(error?.message ?? error)}`)
      })
    }, 50)
    timer.unref?.()

    return async () => {
      disposed = true
      clearTimeout(timer)
      try { toolsDisposer?.() } catch {}
      for (const handle of adapterHandles) {
        try { handle() } catch {}
      }
      await manager.dispose()
    }
  }, 'model-gateway: lifecycle and autostart')
}

export { normalizeConfig, GatewayConfigError }
