import type { BookRecord } from './types.ts'

const memory = {
  on: false,
  books: new Map<string, BookRecord>(),
  files: new Map<string, Blob>(),
}

let dbPromise: Promise<IDBDatabase> | null = null

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('aborted'))
  })
}

function database() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('seojae', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function safeDb() {
  if (memory.on || !globalThis.indexedDB) {
    memory.on = true
    return null
  }
  try {
    return await database()
  } catch (err) {
    console.error(err)
    memory.on = true
    dbPromise = null
    return null
  }
}

export function sortBooks(list: BookRecord[]) {
  return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function allBooks() {
  if (memory.on) return [...memory.books.values()]
  const db = await safeDb()
  if (!db) return allBooks()
  const tx = db.transaction('books', 'readonly')
  const done = txDone(tx)
  const rows = await request(tx.objectStore('books').getAll())
  await done
  return rows as BookRecord[]
}

export async function getFile(id: string) {
  if (memory.on) return memory.files.get(id) ?? null
  const db = await safeDb()
  if (!db) return getFile(id)
  const tx = db.transaction('files', 'readonly')
  const done = txDone(tx)
  const blob = await request(tx.objectStore('files').get(id))
  await done
  return (blob as Blob | undefined) ?? null
}

export async function putBook(meta: BookRecord, blob?: Blob) {
  if (memory.on) {
    memory.books.set(meta.id, meta)
    if (blob) memory.files.set(meta.id, blob)
    return
  }
  const db = await safeDb()
  if (!db) return putBook(meta, blob)
  const tx = db.transaction(['books', 'files'], 'readwrite')
  tx.objectStore('books').put(meta)
  if (blob) tx.objectStore('files').put(blob, meta.id)
  await txDone(tx)
}

export async function updateBook(meta: BookRecord) {
  if (memory.on) {
    memory.books.set(meta.id, meta)
    return
  }
  const db = await safeDb()
  if (!db) return updateBook(meta)
  const tx = db.transaction('books', 'readwrite')
  tx.objectStore('books').put(meta)
  await txDone(tx)
}

export async function removeBook(id: string) {
  if (memory.on) {
    memory.books.delete(id)
    memory.files.delete(id)
    return
  }
  const db = await safeDb()
  if (!db) return removeBook(id)
  const tx = db.transaction(['books', 'files'], 'readwrite')
  tx.objectStore('books').delete(id)
  tx.objectStore('files').delete(id)
  await txDone(tx)
}

export function storageIsMemory() {
  return memory.on || !globalThis.indexedDB
}
