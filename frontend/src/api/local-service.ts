import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// —— 电源车可用台数：全系统只认设备状态这一份，下面是唯一取数口径 ——
// 冲突时以设备状态为准，依据：接机供电/结束供电/申请检修每个现场动作都直接改写设备状态，
// 它是唯一被事实驱动的数据；派发名单与资源缺口都是由它聚合出来的派生结果，不能反过来当源。
const GPU_KEY = 'gpu'
const GPU_AVAILABLE_STATUS = '待命'
const GPU_SUPPLYING_STATUS = '供电中'
const GPU_START_FIELD = '供电开始时间'
const GPU_HOURS_FIELD = '供电时长'
const GPU_FLIGHT_FIELD = '接机航班'
const GPU_STATUS_FIELD = '设备状态'
const RESPLAN_KEY = 'resplan'
const RESPLAN_DEMAND_FIELD = '车辆需求'
const RESPLAN_GAP_FIELD = '资源缺口'

// 接机航班字段里带航班日期时间（如 "CA1502 2026-10-04 08:40"），把第一段日期时间解析成时间戳。
function parseFlightTime(raw: unknown): number | null {
  const matched = String(raw ?? '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/)
  if (!matched) {
    return null
  }
  const time = new Date(`${matched[1]}T${matched[2]}:${matched[3]}:00`).getTime()
  return Number.isNaN(time) ? null : time
}

function toHours(milliseconds: number): number {
  return Math.max(0, Math.round((milliseconds / 3_600_000) * 10) / 10)
}

// 离开「供电中」时结算本次供电时长：优先用供电开始时间，存量数据没有就退回接机航班时间。
function settleGpuSupply(row: EntryRow, now: number): EntryRow {
  const stamped = Date.parse(String(row[GPU_START_FIELD] ?? ''))
  const begin = Number.isFinite(stamped) ? stamped : (parseFlightTime(row[GPU_FLIGHT_FIELD]) ?? now)
  const previous = Number(row[GPU_HOURS_FIELD])
  return {
    ...row,
    [GPU_HOURS_FIELD]: (Number.isFinite(previous) ? previous : 0) + toHours(now - begin),
    [GPU_START_FIELD]: '',
  }
}

// 存量回填：修复前「结束供电没回状态、没累计时长」的电源车。
// 判定依据：新逻辑下供电中必带供电开始时间，缺时间戳的供电中记录就是修复前的残留，
// 按接机航班时间补记时长并回待命；顺手把供电时长统一成数值、设备状态列与 status 对齐。
// 返回是否有改动；本身幂等，跑多少次结果都一样。
function migrateGpuRows(now: number = Date.now()): boolean {
  const rows = listRows(GPU_KEY)
  if (rows.length === 0) {
    return false
  }
  let changed = false
  const next = rows.map((row) => {
    let fixed = row
    if (!Number.isFinite(Number(fixed[GPU_HOURS_FIELD]))) {
      fixed = { ...fixed, [GPU_HOURS_FIELD]: 0 }
      changed = true
    }
    if (String(fixed.status) === GPU_SUPPLYING_STATUS && !fixed[GPU_START_FIELD]) {
      fixed = { ...settleGpuSupply(fixed, now), status: GPU_AVAILABLE_STATUS, pending: true }
      changed = true
    }
    if (String(fixed[GPU_STATUS_FIELD] ?? '') !== String(fixed.status)) {
      fixed = { ...fixed, [GPU_STATUS_FIELD]: fixed.status }
      changed = true
    }
    return fixed
  })
  if (changed) {
    saveRows(GPU_KEY, next)
  }
  return changed
}

// 可用台数唯一取数口：只数状态为「待命」的电源车，待检修/供电中/已停用都不算可用。
export function gpuAvailability(): number {
  migrateGpuRows()
  return listRows(GPU_KEY).filter((row) => String(row.status) === GPU_AVAILABLE_STATUS).length
}

// 把可用台数汇总进资源缺口清单：缺口 = 车辆需求 − 可用电源车，既有计划记录跟着联动改写。
export function syncGpuGapToResplan(): void {
  const available = gpuAvailability()
  const plans = listRows(RESPLAN_KEY)
  if (plans.length === 0) {
    return
  }
  let changed = false
  const next = plans.map((row) => {
    const demand = Number(row[RESPLAN_DEMAND_FIELD])
    const gap = Math.max(0, (Number.isFinite(demand) ? demand : 0) - available)
    if (Number(row[RESPLAN_GAP_FIELD]) === gap) {
      return row
    }
    changed = true
    return { ...row, [RESPLAN_GAP_FIELD]: gap }
  })
  if (changed) {
    saveRows(RESPLAN_KEY, next)
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  // 两个入口读到的可用台数要一致：进地面电源或资源调度前，先把存量回填与缺口联动跑一遍。
  if (key === GPU_KEY || key === RESPLAN_KEY) {
    syncGpuGapToResplan()
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === GPU_KEY) {
    syncGpuGapToResplan()
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 结束供电幂等：已经回到待命的电源车不重复累计供电时长，重复点击不算错。
  if (key === GPU_KEY && action === '结束供电' && current === GPU_AVAILABLE_STATUS) {
    return { ok: true, message: `${meta.entity}已结束供电，当前状态「${GPU_AVAILABLE_STATUS}」，供电时长不重复累计` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态机拦截：登记了来源状态的动作不许跳级（如待命直接跳待检修）。
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」，不允许直接${action}，只能从${sources.join('、')}流转` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === GPU_KEY) {
    const now = Date.now()
    // 离开供电中即结算本次时长，一次供电会话只累计一次。
    if (current === GPU_SUPPLYING_STATUS) {
      updated = settleGpuSupply(updated, now)
    }
    if (action === '接机供电') {
      updated = { ...updated, [GPU_START_FIELD]: new Date(now).toISOString() }
    }
    updated = { ...updated, [GPU_STATUS_FIELD]: target }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === GPU_KEY) {
    syncGpuGapToResplan()
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
