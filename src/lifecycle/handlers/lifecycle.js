const getWorkerStates = (ids, context) =>
  ids.map((id) => {
    const w = context.workerContexts.get(id)
    const { runtimeInfo, info, syncStatus } = w?.runtime || {}
    return {
      status: w?.stateMachineState,
      initialized: info?.initialized,
      parentHeaderSynchedTo: syncStatus?.parentHeaderSynchedTo,
      paraHeaderSynchedTo: syncStatus?.paraHeaderSynchedTo,
      paraBlockDispatchedTo: syncStatus?.paraBlockDispatchedTo,
      worker: w?.snapshotBrief,
      publicKey: runtimeInfo?.publicKey,
      lastMessage: w?.message,
      minerAccountId: w?.onChainState?.accountId?.toString(),
      minerInfoJson: JSON.stringify(w?.onChainState?.minerInfo || {}, null, 0),
    }
  })

const queryWorkerState = async (message, context) => {
  const ids = message.content.queryWorkerState.ids.map((i) => i.uuid)
  const results = getWorkerStates(ids, context)
  return {
    workerStateUpdate: {
      workerStates: results,
    },
  }
}
const requestKickWorker = async (message, context) => {}
const requestStartWorkerLifecycle = async (message, context) => {}

export default {
  queryHandlers: {
    queryWorkerState,
    requestKickWorker,
    requestStartWorkerLifecycle,
  },
  plainHandlers: {},
}
