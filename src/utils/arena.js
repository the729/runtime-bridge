import Arena from 'bull-arena'
import Bee from 'bee-queue'

import { DB_WORKER, setupDb } from '../io/db'
import { UPool } from '../io/worker'
import express from 'express'

export default async () => {
  await setupDb(DB_WORKER)
  const router = express.Router()

  const url = process.env.REDIS_ENDPOINT || 'redis://redis:6379/'

  const pools = await UPool.getAll()

  const arena = Arena({
    Bee,
    queues: [
      {
        name: 'prbmq__main',
        hostId: 'prb',
        type: 'bee',
        url,
      },
      ...pools.map((i) => ({
        name: `prbmq__${i.pid}`,
        hostId: 'prb',
        type: 'bee',
        url,
      })),
    ],
  })

  router.use('/', arena)
}