import type { WorkspaceDocument, WorkspaceDocumentSummary, WorkspacePublishRequest, WorkspaceState } from './browser-workspace'

export type SyncBinding = { id: string; version: number; revision?: string }
export type SyncLocal = { key: string; binding?: SyncBinding }
export type SyncSnapshot = Omit<WorkspacePublishRequest, 'id' | 'expectedVersion' | 'clientId'> & { revision: string }
export interface SyncHooks {
  locals(): SyncLocal[]
  available(): boolean
  revision(key: string): Promise<string | undefined>
  snapshot(key: string): Promise<SyncSnapshot>
  bind(key: string, binding: SyncBinding): void
  /** Check canCommit immediately before replacing the editor, after async parsing. */
  adopt(key: string, document: WorkspaceDocument, expectedRevision: string, canCommit: () => boolean): Promise<boolean>
  fork(key: string, name: string): void
  notify(message: string): void
  state(value: WorkspaceState): void
}
export interface SyncTransport {
  state(): Promise<WorkspaceState>
  document(id: string): Promise<WorkspaceDocument>
  publish(request: WorkspacePublishRequest): Promise<{ status: 'accepted' | 'conflict'; document: WorkspaceDocumentSummary }>
}

type PendingPublication = {
  id: string
  expectedVersion: number
  source?: SyncBinding
  revision: string
  name: string
  extension: SyncSnapshot['extension']
  clientId: string
  conflictCopy: boolean
}

function sameBinding(left: SyncBinding | undefined, right: SyncBinding | undefined): boolean {
  return left?.id === right?.id && left?.version === right?.version && left?.revision === right?.revision
}

/** Full-document snapshots with compare-and-swap. A conflict becomes a new document;
 * neither a late response nor the last writer may silently replace another edit. */
export function createWorkspaceSync(transport: SyncTransport, hooks: SyncHooks, clientId: string, newId: () => string) {
  // Each concurrently running synchronizer needs a unique instance identifier.
  // Per-request suffixes distinguish a timed-out POST from a later local edit.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) throw Error('同步客户端标识无效。')
  let running = false, disposed = false, requestSequence = 0
  // Keep receipt metadata only, never retained document bytes. The workspace
  // admits at most 64 documents; closed tabs release their pending metadata.
  const pending = new Map<string, PendingPublication>()
  const available = () => !disposed && hooks.available()
  const currentLocal = (key: string) => hooks.locals().find(local => local.key === key)
  function matchesSource(key: string, source: SyncBinding | undefined) {
    const local = currentLocal(key)
    return !!local && sameBinding(local.binding, source)
  }

  function acknowledge(key: string, publication: PendingPublication, version: number) {
    if (disposed || !matchesSource(key, publication.source)) return
    if (publication.conflictCopy) hooks.fork(key, publication.name)
    hooks.bind(key, { id: publication.id, version, revision: publication.revision })
    pending.delete(key)
    if (publication.conflictCopy) hooks.notify('两端都有修改，当前内容已保留为冲突副本；另一端版本仍保留在共享工作区。')
  }

  function isReceipt(publication: PendingPublication, remote: WorkspaceDocumentSummary) {
    return remote.id === publication.id && remote.version === publication.expectedVersion + 1 &&
      remote.updatedBy === publication.clientId && remote.name === publication.name && remote.extension === publication.extension
  }

  async function publish(key: string, binding: SyncBinding, snapshot: SyncSnapshot,
    source: SyncBinding | undefined, conflictCopy = false, copyName?: string) {
    if (!available() || !matchesSource(key, source)) return
    const { revision, ...payload } = snapshot
    const name = copyName ?? payload.name
    let publication = pending.get(key)
    if (!publication || publication.id !== binding.id || publication.expectedVersion !== binding.version ||
        publication.revision !== revision || publication.name !== name || publication.extension !== payload.extension ||
        publication.conflictCopy !== conflictCopy || !sameBinding(publication.source, source)) {
      if (!pending.has(key) && pending.size >= 64) throw Error('等待同步确认的文档过多，请先重试已有文档。')
      publication = { id: binding.id, expectedVersion: binding.version, revision, name, extension: payload.extension,
        source: source && { ...source }, clientId: `${clientId}_${++requestSequence}`, conflictCopy }
      pending.set(key, publication)
    }
    const result = await transport.publish({ ...payload, name, id: publication.id,
      expectedVersion: publication.expectedVersion, clientId: publication.clientId })
    if (disposed || !matchesSource(key, source)) return
    if (result.status === 'accepted' || isReceipt(publication, result.document)) {
      acknowledge(key, publication, result.document.version)
      return
    }
    if (conflictCopy) {
      // Retrying may discover that another editor has already changed the copy.
      // A later tick will create another copy; never overwrite that remote edit.
      throw Error('冲突副本已被更新，当前修改仍保留在本端，请重试同步。')
    }
    await preserveConflict(key, snapshot, source)
  }

  async function preserveConflict(key: string, snapshot: SyncSnapshot, source?: SyncBinding) {
    if (!available() || !matchesSource(key, source)) return
    const name = Array.from(snapshot.name.replace(/\.[^.]+$/, '')).slice(0, 50).join('') + ' - 冲突副本.' + snapshot.extension
    await publish(key, { id: newId(), version: 0 }, snapshot, source, true, name)
  }
  return {
    async tick() {
      if (running || !available()) return
      running = true
      try {
        const state = await transport.state()
        if (disposed) return
        hooks.state(state)
        if (!state.running) return
        const locals = hooks.locals().map(local => ({ ...local, binding: local.binding && { ...local.binding } }))
        const keys = new Set(locals.map(local => local.key))
        for (const key of pending.keys()) if (!keys.has(key)) pending.delete(key)
        let failure: { cause: unknown } | undefined
        for (const local of locals) {
          if (!available()) break
          try {
            const previous = pending.get(local.key)
            if (previous && sameBinding(previous.source, local.binding)) {
              const remote = state.documents.find(item => item.id === previous.id)
              if (remote && isReceipt(previous, remote)) {
                acknowledge(local.key, previous, remote.version)
                continue
              }
              const snapshot = await hooks.snapshot(local.key)
              if (remote && remote.version > previous.expectedVersion) {
                await preserveConflict(local.key, snapshot, local.binding)
              } else {
                await publish(local.key, { id: previous.id, version: previous.expectedVersion }, snapshot,
                  local.binding, previous.conflictCopy, previous.conflictCopy ? previous.name : undefined)
              }
              continue
            }
            if (previous) pending.delete(local.key)
            const binding = local.binding ?? { id: newId(), version: 0 }
            const revision = await hooks.revision(local.key)
            if (revision === undefined || !available() || !matchesSource(local.key, local.binding)) continue
            const remote = state.documents.find(item => item.id === binding.id)
            if (remote && remote.version > binding.version) {
              if (binding.revision === revision) {
                const document = await transport.document(binding.id)
                if (!available() || !matchesSource(local.key, local.binding)) continue
                // The receiving shell prepares the new Rust model, then checks again
                // that no local keystroke arrived before replacing the old session.
                if (!await hooks.adopt(local.key, document, revision,
                  () => !disposed && matchesSource(local.key, local.binding))) continue
              } else {
                await preserveConflict(local.key, await hooks.snapshot(local.key), local.binding)
              }
            } else if (!local.binding || binding.revision !== revision) {
              await publish(local.key, binding, await hooks.snapshot(local.key), local.binding)
            }
          } catch (cause) {
            // One invalid/oversized document must not starve every later tab.
            // Retain its receipt and baseline for retry, and report after giving
            // the remaining available documents a chance to synchronize.
            failure ??= { cause }
          }
        }
        if (failure && !disposed) throw failure.cause
      } finally { running = false }
    },
    dispose() { disposed = true; pending.clear() },
  }
}
