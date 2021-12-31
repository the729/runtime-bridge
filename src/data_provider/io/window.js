import { DB_WINDOW, getDb, getKeyExistence, waitFor } from './db'
import {
  LAST_COMMITTED_PARA_BLOCK,
  LAST_COMMITTED_PARENT_BLOCK,
} from '../../utils/constants'
import { getParentBlock } from './block'
import { pbToObject } from './db_encoding'
import { phalaApi } from '../../utils/api'
import { prb } from '@phala/runtime-bridge-walkie'
import logger from '../../utils/logger'

const { Window, RangeMeta } = prb.db

export const getWindow = async (windowId) => {
  const db = await getDb(DB_WINDOW)
  const buffer = await db.getBuffer(`window:${windowId}:pb`)
  if (!buffer) {
    return buffer
  }
  const pb = Window.decode(buffer)
  return pbToObject(pb)
}

export const createWindow = async (windowId, data) => {
  const db = await getDb(DB_WINDOW)
  const pb = Window.create(data)

  await db.set(`window:${windowId}:pb`, Window.encode(pb).finish())
  return pbToObject(pb)
}

export const setEmptyWindow = (windowId, parentStartBlock, paraStartBlock) => {
  return createWindow(windowId, {
    parentStartBlock,
    parentStopBlock: -1,
    paraStartBlock,
    paraStopBlock: -1,
    stopBlock: -1,
    windowId,
    setId: -1,
    isFinished: false,
  })
}
export const updateWindow = async (windowIdOrObject, data) => {
  const db = await getDb(DB_WINDOW)

  const windowId =
    typeof windowIdOrObject === 'number'
      ? windowIdOrObject
      : windowIdOrObject.windowId
  const windowObject =
    typeof windowIdOrObject === 'number'
      ? await getWindow(windowId)
      : windowIdOrObject
  Object.assign(windowObject, data)

  const pb = Window.create(windowObject)
  await db.set(`window:${windowId}:pb`, Window.encode(pb).finish())

  return pbToObject(pb)
}

export const getRangeByParentNumber = async (number) => {
  const db = await getDb(DB_WINDOW)
  const buffer = await db.getBuffer(`rangeByParentBlock:${number}:pb`)
  if (!buffer) {
    return buffer
  }
  const pb = RangeMeta.decode(buffer)
  return pbToObject(pb)
}
export const waitForRangeByParentNumber = (number) =>
  waitFor(() => getRangeByParentNumber(number))

export const getRangeByParaNumber = async (number) => {
  const db = await getDb(DB_WINDOW)
  const buffer = await db.getBuffer(`rangeByParaBlock:${number}:pb`)
  if (!buffer) {
    return buffer
  }
  const pb = RangeMeta.decode(buffer)
  return pbToObject(pb)
}
export const waitForRangeByParaNumber = (number) =>
  waitFor(() => getRangeByParaNumber(number))

export const setDryRange = async (
  parentStartBlock,
  paraStartBlock,
  paraBlocks,
  parentBlocks,
  latestSetId,
  setIdChanged
) => {
  const windowDb = await getDb(DB_WINDOW)

  const _parentStopBlock = parentBlocks[parentBlocks.length - 1]
  const _paraStopBlock = paraBlocks.length
    ? paraBlocks[paraBlocks.length - 1]
    : null
  const parentStopBlock = _parentStopBlock.number
  const paraStopBlock = _paraStopBlock ? _paraStopBlock.number : -1

  logger.info(
    {
      parentStartBlock,
      parentStopBlock,
      paraStartBlock,
      paraStopBlock,
    },
    'Start setDryRange'
  )

  const keySuffix = `${parentStartBlock}:${parentStopBlock}:${paraStartBlock}:${paraStopBlock}`
  const rangeWrittenMarkKey = `rangeWritten:${keySuffix}`
  const drySyncHeaderReqKey = `drySyncHeader:${keySuffix}`
  const shouldSkip = await getKeyExistence(windowDb, rangeWrittenMarkKey)

  const rangeMeta = {
    parentStartBlock,
    parentStopBlock,
    paraStartBlock,
    paraStopBlock,
    parentRange: parentBlocks.map((i) => i.number),
    paraRange: paraBlocks.map((i) => i.number),
    drySyncHeaderReqKey,
    latestSetId,
  }

  if (shouldSkip) {
    logger.info(
      {
        parentStartBlock,
        parentStopBlock,
        paraStartBlock,
        paraStopBlock,
      },
      `Found dryCache, skipping.`
    )

    return rangeMeta
  }

  const rawScaleData = {
    SyncHeaderReq: phalaApi.createType('SyncCombinedHeadersReq', {
      relaychainHeaders: parentBlocks.map((b) => b.syncHeaderData),
      authoritySetChange: setIdChanged
        ? _parentStopBlock.authoritySetChange
        : null,
      ...(_paraStopBlock
        ? {
            parachainHeaders: paraBlocks.map((b) => b.header),
            proof: _parentStopBlock.paraProof,
          }
        : {
            parachainHeaders: [],
            proof: [],
          }),
    }),
  }

  const drySyncHeaderReq = Buffer.from(rawScaleData.SyncHeaderReq.toU8a())

  const rangeMetaPb = RangeMeta.create(rangeMeta)
  const rangeMetaPbBuffer = RangeMeta.encode(rangeMetaPb).finish()

  const batch = windowDb.pipeline().set(drySyncHeaderReqKey, drySyncHeaderReq)

  parentBlocks.reduce(
    (b, { number }) =>
      b.set(`rangeByParentBlock:${number}:pb`, rangeMetaPbBuffer),
    batch
  )
  paraBlocks.reduce(
    (b, { number }) =>
      b.set(`rangeByParaBlock:${number}:pb`, rangeMetaPbBuffer),
    batch
  )
  batch.set(rangeWrittenMarkKey, Buffer.from([1]))
  await batch.exec()

  logger.info(
    { parentStartBlock, parentStopBlock, paraStartBlock, paraStopBlock },
    `Saved dryCache.`
  )

  rangeMeta.rawScaleData = rawScaleData
  return rangeMeta
}

export const commitBlobRange = async (ranges, paraRanges) => {
  const windowDb = await getDb(DB_WINDOW)
  const parentStartBlock = ranges[0].parentStartBlock
  const parentStopBlock = ranges[ranges.length - 1].parentStopBlock
  const paraStartBlock = paraRanges.length ? paraRanges[0] : -1
  const paraStopBlock = paraRanges.length
    ? paraRanges[paraRanges.length - 1]
    : -1

  const keySuffix = `${parentStartBlock}:${parentStopBlock}:${paraStartBlock}:${paraStopBlock}`

  const blobRangeCommittedMarkKey = `blobRangeCommitted:${keySuffix}`
  const blobRangeKey_SyncHeaderReq = `blobRange:${keySuffix}:SyncHeaderReq`
  const shouldSkip = await getKeyExistence(windowDb, blobRangeCommittedMarkKey)

  if (shouldSkip) {
    logger.info(
      { parentStartBlock, parentStopBlock, paraStartBlock, paraStopBlock },
      `Found blobRange, skipping.`
    )
    ranges.length = 0 // trigger GC
    return
  }

  const parent__headers = []
  let parent__authoritySetChange

  const para__headers = []
  const para__proof = (await getParentBlock(parentStopBlock)).paraProof

  // const blocks = []

  for (const [index, range] of ranges.entries()) {
    if (range.rawScaleData) {
      for (const h of range.rawScaleData.SyncHeaderReq.relaychainHeaders) {
        parent__headers.push(h)
      }
      if (index === ranges.length - 1) {
        parent__authoritySetChange =
          range.rawScaleData.SyncHeaderReq.authoritySetChange
      }

      if (range.paraRange.length) {
        for (const b of range.rawScaleData.SyncHeaderReq.parachainHeaders) {
          para__headers.push(b)
        }
      }
    } else {
      const drySyncHeader = phalaApi.createType(
        'SyncCombinedHeadersReq',
        await windowDb.getBuffer(range.drySyncHeaderReqKey)
      )
      for (const h of drySyncHeader.relaychainHeaders) {
        parent__headers.push(h)
      }
      if (index === ranges.length - 1) {
        parent__authoritySetChange = drySyncHeader.authoritySetChange
      }

      if (range.paraRange.length) {
        for (const b of drySyncHeader.parachainHeaders) {
          para__headers.push(b)
        }
      }
    }
  }

  const blobSyncHeaderReq = phalaApi.createType('SyncCombinedHeadersReq', {
    relaychainHeaders: parent__headers,
    authoritySetChange: parent__authoritySetChange,
    parachainHeaders: para__headers,
    proof: para__proof,
  })

  const startBlockRangeMetaKey = `rangeByParentBlock:${parentStartBlock}:pb`
  const startBlockRangeMetaPb = RangeMeta.decode(
    await windowDb.getBuffer(startBlockRangeMetaKey)
  )

  const paraStartBlockRangeMetaKey =
    startBlockRangeMetaPb.paraStartBlock >= 0
      ? `rangeByParaBlock:${startBlockRangeMetaPb.paraStartBlock}:pb`
      : null

  startBlockRangeMetaPb.blobParentStopBlock = parentStopBlock
  startBlockRangeMetaPb.blobParaStopBlock = paraStopBlock
  startBlockRangeMetaPb.blobSyncHeaderReqKey = blobRangeKey_SyncHeaderReq
  const startBlockRangeMetaPbBuffer = RangeMeta.encode(
    startBlockRangeMetaPb
  ).finish()

  const batch = windowDb.pipeline()

  batch
    .set(blobRangeKey_SyncHeaderReq, Buffer.from(blobSyncHeaderReq.toU8a()))
    .set(startBlockRangeMetaKey, startBlockRangeMetaPbBuffer)
  if (paraStartBlockRangeMetaKey) {
    batch.set(paraStartBlockRangeMetaKey, startBlockRangeMetaPbBuffer)
  }
  await batch.exec()
  await windowDb.set(blobRangeCommittedMarkKey, Buffer.from([1]))

  logger.info(
    { parentStartBlock, parentStopBlock, paraStartBlock, paraStopBlock },
    `Committed blobRange.`
  )

  ranges.length = 0
}

export const getLastCommittedParaBlock = async () => {
  const db = await getDb(DB_WINDOW)
  return parseInt(await db.get(LAST_COMMITTED_PARA_BLOCK)) || 0
}

export const setLastCommittedParaBlock = async (number) => {
  const db = await getDb(DB_WINDOW)
  return db.set(LAST_COMMITTED_PARA_BLOCK, number)
}

export const getLastCommittedParentBlock = async () => {
  const db = await getDb(DB_WINDOW)
  return parseInt(await db.get(LAST_COMMITTED_PARENT_BLOCK)) || 0
}

export const setLastCommittedParentBlock = async (number) => {
  const db = await getDb(DB_WINDOW)
  return db.set(LAST_COMMITTED_PARENT_BLOCK, number)
}

export const setDryParaBlockRange = async (block) => {
  const db = await getDb(DB_WINDOW)
  const indexKey = `rangeParaBlock:key:${block.number}`
  const key = `dryParaBlock:${block.number}`
  if (await getKeyExistence(db, key)) {
    logger.info(`Found dry cache for para block #${block.number}.`)
    return
  }
  const batch = db.pipeline()
  batch.set(
    key,
    Buffer.from(
      phalaApi
        .createType('Vec<BlockHeaderWithChanges>', [block.dispatchBlockData])
        .toU8a()
    )
  )
  batch.set(
    indexKey,
    JSON.stringify({
      firstBlockNumber: block.number,
      lastBlockNumber: block.number,
    })
  )
  await batch.exec()
  logger.info(`Saved dry cache for para block #${block.number}.`)
}

export const commitParaBlockRange = async (blocks) => {
  const db = await getDb(DB_WINDOW)
  const firstBlockNumber = blocks[0].number
  const lastBlockNumber = blocks[blocks.length - 1].number
  const indexKey = `rangeParaBlock:key:${firstBlockNumber}`
  const bufferKey = `rangeParaBlock:buffer:${firstBlockNumber}`
  const markKey = `rangeParaBlock:mark:${firstBlockNumber}`
  if (await getKeyExistence(db, markKey)) {
    logger.info(
      `Found range cache for para block #${firstBlockNumber} to #${lastBlockNumber}.`
    )
    return
  }
  const batch = db.pipeline()
  batch.set(
    bufferKey,
    Buffer.from(
      phalaApi
        .createType(
          'Vec<BlockHeaderWithChanges>',
          blocks.map((b) => b.dispatchBlockData)
        )
        .toU8a()
    )
  )
  batch.set(
    indexKey,
    JSON.stringify({ bufferKey, firstBlockNumber, lastBlockNumber })
  )
  await batch.exec()
  await db.set(markKey, Buffer.from([1]))
  await setLastCommittedParaBlock(lastBlockNumber)
  logger.info(
    `Saved range cache for para block #${firstBlockNumber} to #${lastBlockNumber}.`
  )
}

export const getParaBlockRange = async (number) => {
  const db = await getDb(DB_WINDOW)
  const indexKey = `rangeParaBlock:key:${number}`
  return JSON.parse(await db.get(indexKey))
}

export const waitForParaBlockRange = (number) =>
  waitFor(() => getParaBlockRange(number))
