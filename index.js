import { HarnessError } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { installBashInputPromotion } from './bash.js'

export const name = 'wait-agent-input'
export const inject = ['tools']

const INPUT_RECEIVED = 'WAIT_AGENT_USER_INPUT'
const UNLOADED = 'WAIT_AGENT_INPUT_UNLOADED'
const STEER_NOTICE = 'User message received. Handle it before waiting again.'
const QUEUED_NOTICE = 'User message queued. Finish this turn to handle it.'
const isUser = message => message.source.kind === 'user'

/** Preserve the native distinction between steering and a queued follow-up. */
function pendingInput(agent) {
  if (agent.inbox.nextStep.some(isUser)) return STEER_NOTICE
  if (agent.inbox.nextTurn.some(isUser)) return QUEUED_NOTICE
}

/** Invalid calls retain the original tool's validation and error result. */
function waitingTool(ctx, exec) {
  if (exec.name !== 'wait_agent' && (exec.name !== 'job_output' || exec.arguments?.wait !== true)) return
  const tool = ctx.tools.get(exec.name, exec.agent)
  if (tool === undefined || validateJsonSchemaValue(tool.parameters, exec.arguments).length > 0) return
  if (exec.name === 'wait_agent') {
    const timeout = exec.arguments.timeout_ms ?? 30000
    if (!Number.isSafeInteger(timeout) || timeout < 10000 || timeout > 3600000) return
  }
  return tool
}

/**
 * Keep job_output's consuming read inside the native body, under a wait-only
 * signal. The dispatch signal stays live so a completed read is never discarded
 * by the runtime when job completion races with human input.
 */
function wrapJobOutput(wrappers, tool, token, wait) {
  let wrapper = wrappers.get(tool)
  if (wrapper === undefined) {
    const original = tool.execute
    const calls = new Map()
    const execute = async function(args, exec) {
      const current = calls.get(exec.token)
      if (current === undefined) return original.call(this, args, exec)
      const signal = AbortSignal.any([exec.signal, current.controller.signal])
      try {
        const value = await original.call(this, args, { ...exec, signal })
        if (signal.aborted && signal.reason !== current.received) throw signal.reason
        return value
      } catch (error) {
        // The native job registry rejects a cancelled wait before reading output.
        if (!signal.aborted || !(error instanceof Error) || error.message !== 'wait aborted') throw error
        exec.signal.throwIfAborted()
        if (signal.reason !== current.received) throw signal.reason
        return original.call(this, { ...args, wait: false }, exec)
      }
    }
    wrapper = { original, execute, calls }
    wrappers.set(tool, wrapper)
    tool.execute = execute
  }
  wrapper.calls.set(token, wait)
  return () => {
    wrapper.calls.delete(token)
    if (wrapper.calls.size > 0) return
    if (tool.execute === wrapper.execute) tool.execute = wrapper.original
    wrappers.delete(tool)
  }
}

/** End only this tool's cooperative wait when human input is pending. */
export function apply(ctx) {
  const active = new Set()
  const notices = new WeakMap()
  const jobWrappers = new Map()
  let closing = false
  installBashInputPromotion(ctx, pendingInput, (exec, notice) => notices.set(exec, notice))

  ctx.on('tools/execute', async (exec, next) => {
    if (closing || exec.agent === undefined) return next()
    const tool = waitingTool(ctx, exec)
    if (tool === undefined) return next()
    const jobOutput = exec.name === 'job_output'
    const upstream = exec.signal
    const controller = new AbortController()
    const received = new HarnessError(`User input received during ${exec.name}.`, INPUT_RECEIVED)
    const done = Promise.withResolvers()
    const wait = { controller, received, done: done.promise }
    let notice
    const interrupt = () => {
      if (upstream.aborted || controller.signal.aborted) return
      notice = pendingInput(exec.agent)
      if (notice !== undefined) controller.abort(received)
    }
    const unsubscribe = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === exec.agent && isUser(message)) interrupt()
    })
    const cancel = () => controller.abort(upstream.reason)
    upstream.addEventListener('abort', cancel, { once: true })
    if (upstream.aborted) cancel()
    active.add(wait)
    let release
    try {
      if (jobOutput) release = wrapJobOutput(jobWrappers, tool, exec.token, wait)
      else exec.signal = controller.signal
      interrupt()
      const result = await next()
      if (!upstream.aborted && controller.signal.reason === received) {
        if (jobOutput && !result.isError) notices.set(exec, notice)
        const code = result.isError ? result.error.info?.code : undefined
        if (!jobOutput && [INPUT_RECEIVED, 'ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(code)) {
          notices.set(exec, notice)
          return { isError: false, value: { timedOut: false }, content: [] }
        }
      }
      return result
    } finally {
      release?.()
      exec.signal = upstream
      unsubscribe()
      upstream.removeEventListener('abort', cancel)
      active.delete(wait)
      done.resolve()
    }
  })

  // Keep the native canonical value/schema. Only the model-facing text changes.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const notice = notices.get(exec)
    notices.delete(exec)
    const decision = await next()
    if (notice === undefined || result.isError || decision.kind !== 'accept'
      || Object.hasOwn(decision, 'value') || Object.hasOwn(decision, 'content')) return decision
    let text = notice
    if (exec.name === 'bash') {
      const { output, jobId } = result.value
      const received = notice === QUEUED_NOTICE ? 'User message queued.' : 'User message received.'
      const queued = notice === QUEUED_NOTICE ? ' Finish this turn to handle it.' : ''
      text = `${output}${output.length > 0 && !output.endsWith('\n') ? '\n' : ''}${received} Command continues as background job ${jobId}.${queued}`
    } else if (exec.name === 'job_output') {
      const body = result.content[0].text
      const status = body.lastIndexOf('\n')
      // Keep the native status at the tail when its finalizer enforces byte caps.
      text = `${body.slice(0, status)}\n${notice} Only this wait ended; the job was not cancelled.${body.slice(status)}`
    }
    return { ...decision, content: [{ type: 'text', text }] }
  })

  ctx.effect(() => async () => {
    closing = true
    for (const wait of active) wait.controller.abort(new HarnessError('wait-agent-input plugin unloaded.', UNLOADED))
    await Promise.allSettled([...active].map(wait => wait.done))
  }, 'wait-agent-input: active waits')
}
