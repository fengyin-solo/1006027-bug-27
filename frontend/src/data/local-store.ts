import { migrateGpuRows } from './gpu-domain'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalizeLoaded(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalizeLoaded({ ...fallback, ...parsed })
  } catch {
    const seeded = normalizeLoaded(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

// 读取时统一过一遍存量迁移：电源车的历史脏数据（结束供电没回状态/没累计时长）
// 在这里一次性修复并落盘，后续既有记录都跟着新规则联动。
function normalizeLoaded(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (!data.gpu) {
    return data
  }
  const migratedGpu = migrateGpuRows(data.gpu)
  const changed = migratedGpu.some((row, index) => row !== data.gpu[index])
  if (!changed) {
    return data
  }
  const next = { ...data, gpu: migratedGpu }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  // 重置同样要走迁移：种子里带的遗留记录不能绕过回填直接进缓存。
  const rows = key === 'gpu' ? migrateGpuRows(clone(SEED_ROWS[key] ?? [])) : clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
