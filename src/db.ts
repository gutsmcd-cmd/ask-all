// IndexedDB only (no localStorage). Two stores: small key-value settings, and past rounds.
const DB_NAME = 'ask-all'
const KV = 'kv'
const ROUNDS = 'rounds'

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV)
      if (!db.objectStoreNames.contains(ROUNDS)) db.createObjectStore(ROUNDS, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbp = null
      reject(req.error ?? new Error('idb open'))
    }
  })
  return dbp
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const r = fn(tx.objectStore(store))
        tx.oncomplete = () => resolve(r.result as T)
        tx.onerror = () => reject(tx.error ?? r.error)
        tx.onabort = () => reject(tx.error ?? new Error('aborted'))
      }),
  )
}

export async function load<T>(key: string): Promise<T | undefined> {
  try {
    return await run<T | undefined>(KV, 'readonly', (s) => s.get(key))
  } catch {
    return undefined
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  await run(KV, 'readwrite', (s) => s.put(value, key))
}

export async function remove(key: string): Promise<void> {
  await run(KV, 'readwrite', (s) => s.delete(key))
}

export async function allRounds<T extends { ts: number }>(): Promise<T[]> {
  try {
    const list = await run<T[]>(ROUNDS, 'readonly', (s) => s.getAll())
    return list.sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

/** Saves a round and keeps only the newest `keep`. */
export async function putRound<T extends { id: string; ts: number }>(round: T, keep: number): Promise<void> {
  await run(ROUNDS, 'readwrite', (s) => s.put(round))
  const list = await allRounds<T>()
  for (const old of list.slice(keep)) await deleteRound(old.id)
}

export async function deleteRound(id: string): Promise<void> {
  await run(ROUNDS, 'readwrite', (s) => s.delete(id))
}

export async function clearRounds(): Promise<void> {
  await run(ROUNDS, 'readwrite', (s) => s.clear())
}

/** Best-effort. A denial must not block the app. */
export async function askPersist(): Promise<boolean> {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      if (await navigator.storage.persisted()) return true
      return await navigator.storage.persist()
    }
  } catch {
    /* ignore */
  }
  return false
}
