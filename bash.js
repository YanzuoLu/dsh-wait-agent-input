import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'

const originalService = service => service?.[symbols.original] ?? service
const terminal = job => job.status !== 'running' && job.status !== 'stopping'

/** Share temporary method adapters across concurrent calls and restore exact descriptors. */
function methodLeases() {
  const patches = new Map()
  function restore(object, key, patch) {
    if (patch.restored) return
    patch.restored = true
    if (object[key] === patch.wrapped) {
      if (patch.descriptor) Object.defineProperty(object, key, patch.descriptor)
      else delete object[key]
    }
    const methods = patches.get(object)
    methods.delete(key)
    if (methods.size === 0) patches.delete(object)
  }
  return {
    acquire(object, key, decorate) {
      let methods = patches.get(object)
      if (methods === undefined) { methods = new Map(); patches.set(object, methods) }
      let patch = methods.get(key)
      if (patch === undefined) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        patch = { descriptor, wrapped: decorate(object[key]), users: 0, restored: false }
        Object.defineProperty(object, key, { configurable: true, writable: true, ...descriptor, value: patch.wrapped })
        methods.set(key, patch)
      }
      patch.users++
      return () => { if (!patch.restored && --patch.users === 0) restore(object, key, patch) }
    },
    dispose() {
      for (const [object, methods] of patches) for (const [key, patch] of methods) restore(object, key, patch)
    },
  }
}

/**
 * End only the native foreground job wait. The native bash body still owns
 * validation, approval, process creation, output consumption and handoff.
 */
export function installBashInputPromotion(ctx, pendingInput, recordNotice) {
  const scope = new AsyncLocalStorage()
  const leases = methodLeases()
  const calls = new Map()
  let closing = false

  const watchPreparation = original => async function(spec) {
    const state = scope.getStore()
    if (!state?.active || state.shell !== originalService(this) || spec.onExpiry !== 'none') return original.call(this, spec)
    const process = await original.call(this, spec)
    // The native caller assigns its process handle after this promise resolves.
    // Run after that microtask chain so early input never looks like a preparation timeout.
    if (state.active) state.readyTick = setImmediate(() => {
      state.readyTick = undefined
      state.ready = true
      state.check()
    })
    return process
  }

  const interruptibleWait = original => async function(id, timeoutMs, caller, signal) {
    const state = scope.getStore()
    if (!state?.active || state.jobs !== originalService(this) || signal !== state.signal || caller !== state.agent.id) {
      return original.call(this, id, timeoutMs, caller, signal)
    }
    const controller = new AbortController()
    const received = new Error('User input received during the foreground wait')
    state.interrupt = () => controller.abort(received)
    try {
      state.check()
      let view
      try {
        view = await original.call(this, id, timeoutMs, caller, AbortSignal.any([signal, controller.signal]))
      } catch (error) {
        if (signal.aborted || controller.signal.reason !== received || !(error instanceof Error) || error.message !== 'wait aborted') throw error
        // A cancelled registry wait has not read output or stopped the process.
        view = this.get(id, caller)
        state.interrupted = true
      }
      // Real Stop/caller cancellation must reach bash's native kill-and-join path.
      signal.throwIfAborted()
      return view
    } finally {
      state.interrupt = undefined
    }
  }

  const scopedBody = original => async function(args, exec) {
    const state = calls.get(exec.token)
    if (!state?.active) return original.call(this, args, exec)
    state.signal = exec.signal
    return scope.run(state, async () => {
      const value = await original.call(this, args, exec)
      // Cover cancellation after the early wait returned but before the native
      // body completed its handoff. Never rerun the command to recover a result.
      if (state.interrupted && value.kind === 'promoted' && exec.signal.aborted) {
        state.jobs.kill(value.jobId, state.agent.id, 'tool call aborted')
        const job = await state.jobs.wait(value.jobId, value.timeoutMs, state.agent.id)
        if (terminal(job)) state.jobs.remove(value.jobId, state.agent.id)
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return value
    })
  }

  ctx.on('tools/execute', async (exec, next) => {
    if (closing || exec.name !== 'bash' || exec.agent === undefined || exec.arguments?.run_in_background === true) return next()
    const jobs = originalService(exec.agent.ctx.get('jobs'))
    const shell = originalService(exec.agent.ctx.get('shell'))
    if (jobs === undefined || shell === undefined) return next()
    const tool = ctx.tools.get(exec.name, exec.agent)
    if (tool === undefined || tool.parameters.properties?.run_in_background === undefined) return next()
    const state = { agent: exec.agent, jobs, shell, active: true, ready: false, signal: exec.signal }
    state.check = () => {
      if (!state.active || !state.ready || state.signal.aborted) return
      const notice = pendingInput(state.agent)
      if (notice === undefined) return
      state.notice = notice
      state.interrupt?.()
    }
    const unsubscribe = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === state.agent && message.source.kind === 'user') state.check()
    })
    state.stop = () => {
      state.active = false
      clearImmediate(state.readyTick)
      unsubscribe()
    }
    const release = []
    calls.set(exec.token, state)
    try {
      release.push(leases.acquire(shell, 'execute', watchPreparation))
      release.push(leases.acquire(jobs, 'wait', interruptibleWait))
      release.push(leases.acquire(tool, 'execute', scopedBody))
      const result = await next()
      if (state.active && state.interrupted && !state.signal.aborted && !result.isError && result.value.kind === 'promoted') {
        recordNotice(exec, state.notice)
      }
      return result
    } finally {
      state.stop()
      calls.delete(exec.token)
      for (const dispose of release.reverse()) dispose()
    }
  })

  ctx.effect(() => () => {
    closing = true
    // In-flight native calls keep their original deadlines and cancellation.
    // Unloading this adapter does not cancel processes or fabricate user input.
    for (const state of calls.values()) state.stop()
    leases.dispose()
    scope.disable()
  }, 'wait-agent-input: foreground bash adapter')
}
