import { createWorkerContext, destroyWorkerContext } from './worker'
import { getAllWorker } from '../io/worker'
import { isEqual } from 'lodash'
import logger from '../utils/logger'
import wait from '../utils/wait'

const WORKER_ALTER = 'WORKER_ALTER'

const applyWorker = async (worker, context, result) => {
  const { workerContexts } = context
  let w = workerContexts.get(worker.id)
  if (!w) {
    result.added += 1
    await addWorker(worker, context)
    return
  }
  if (w.deleted) {
    result.deleted += 1
    await deleteWorker(worker, context)
    return
  }
  if (!isEqual(worker, w.snapshot)) {
    result.updated += 1
    await deleteWorker(worker, context)
    await addWorker(worker, context)
    return
  }
}

const addWorker = async (worker, context) => {
  const ret = await createWorkerContext(worker, context)
  context.workerContexts.set(worker.id, ret)
  logger.info(worker, 'Started worker lifecycle.')
  return ret
}

const deleteWorker = async (worker, context) => {
  await destroyWorkerContext(worker, context)
  context.workerContexts.delete(worker.id)
  logger.info(worker, 'Stopped worker lifecycle.')
  return worker.id
}

const waitUntilWorkerChanges = async (context) => {
  await wait(1000)
  await new Promise((resolve) => {
    const off = () => {
      context.eventEmitter.off(WORKER_ALTER, off)
      resolve()
    }
    context.eventEmitter.on(WORKER_ALTER, off)
    setTimeout(() => off(), 3600000)
  })
}

const setupWorkers = async (context) => {
  await wait(6000)
  const result = {
    added: 0,
    deleted: 0,
    updated: 0,
  }
  const workers = getAllWorker()
  for (const w of workers) {
    await applyWorker(w, context, result)
  }
  if (result.add + result.deleted + result.update > 0) {
    logger.info(result, 'Got workers!')
  }
}

const _watchWorkers = async (context) => {
  await setupWorkers(context)
  await waitUntilWorkerChanges(context)
  return _watchWorkers(context)
}

export const watchWorkers = async (context) => {
  logger.info('Watching for worker changes...')
  return _watchWorkers(context)
}
