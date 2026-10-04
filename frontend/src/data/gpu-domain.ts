import type { ActionResult, EntryRow } from './types'

// 电源车领域规则：设备状态是唯一事实源。
// 可用台数、调度缺口、派发名单是否有效，全部以这里的状态判断为准，
// 任何页面都不允许再自己维护一份「可用」口径。
export const GPU_KEY = 'gpu'

export const GPU_STATUS_IDLE = '待命'
export const GPU_STATUS_POWERING = '供电中'
export const GPU_STATUS_REPAIR = '待检修'
export const GPU_STATUS_DISABLED = '已停用'

// 可用 = 待命。供电中（占用）、待检修（在修）、已停用都不能派。
const GPU_AVAILABLE_STATUSES: ReadonlySet<string> = new Set([GPU_STATUS_IDLE])

const FIELD_DURATION = '供电时长'
const FIELD_ARRIVAL = '到达时间'
const START_KEY = '_供电开始'
const END_KEY = '_供电结束'
const SETTLED_KEY = '_已结算'
// 存量脏数据标记：结束供电点过、但状态没回待命、时长也没累计的设备。
const LEGACY_STUCK_KEY = '_遗留未回令'

export type GpuActionOutcome = ActionResult & { row?: EntryRow }

export type GpuSummary = {
  total: number
  available: number
  powering: number
  repairing: number
  disabled: number
}

export function isGpuAvailableStatus(status: unknown): boolean {
  return GPU_AVAILABLE_STATUSES.has(String(status))
}

export function gpuAvailableCount(rows: EntryRow[]): number {
  return rows.reduce((sum, row) => sum + (isGpuAvailableStatus(row.status) ? 1 : 0), 0)
}

export function gpuSummary(rows: EntryRow[]): GpuSummary {
  return rows.reduce<GpuSummary>(
    (acc, row) => {
      acc.total += 1
      const status = String(row.status)
      if (isGpuAvailableStatus(status)) acc.available += 1
      else if (status === GPU_STATUS_POWERING) acc.powering += 1
      else if (status === GPU_STATUS_REPAIR) acc.repairing += 1
      else if (status === GPU_STATUS_DISABLED) acc.disabled += 1
      return acc
    },
    { total: 0, available: 0, powering: 0, repairing: 0, disabled: 0 },
  )
}

function durationMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
}

export function parseDateTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const time = Date.parse(value.trim().replace(' ', 'T'))
  return Number.isNaN(time) ? null : time
}

function formatDateTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function elapsedMinutes(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) / 60000))
}

/**
 * 电源车动作流转（唯一入口，页面层不做业务判断）。
 * 合法链路：待命 ⇄ 供电中；待命 → 待检修 → 待命。
 * 供电中不许直接跳待检修，跳级一律拦下。
 */
export function applyGpuAction(row: EntryRow, action: string, now: number = Date.now()): GpuActionOutcome {
  const status = String(row.status)

  if (action === '接机供电') {
    if (status === GPU_STATUS_POWERING) {
      return { ok: false, message: '设备已在供电中，不能重复接机供电' }
    }
    if (status !== GPU_STATUS_IDLE) {
      return { ok: false, message: `只有「${GPU_STATUS_IDLE}」设备可以接机供电，当前为「${status}」` }
    }
    const arrival = parseDateTime(row[FIELD_ARRIVAL])
    return {
      ok: true,
      message: '已接机供电，设备进入供电中',
      row: {
        ...row,
        status: GPU_STATUS_POWERING,
        pending: true,
        abnormal: false,
        [START_KEY]: formatDateTime(arrival ?? now),
        [END_KEY]: '',
        [SETTLED_KEY]: false,
      },
    }
  }

  if (action === '结束供电') {
    // 幂等：已经回到待命说明本次供电结算过了，重复点击直接成功返回，不再累计时长。
    if (status === GPU_STATUS_IDLE) {
      return { ok: true, message: '供电已结束，设备在待命；重复点击不重复累计时长' }
    }
    if (status !== GPU_STATUS_POWERING) {
      return { ok: false, message: `只有「${GPU_STATUS_POWERING}」设备可以结束供电，当前为「${status}」` }
    }
    if (row[SETTLED_KEY] === true) {
      return { ok: true, message: '本次供电时长已结算，重复点击不重复累计', row: { ...row, status: GPU_STATUS_IDLE } }
    }
    const end = now
    const start = parseDateTime(row[START_KEY]) ?? parseDateTime(row[FIELD_ARRIVAL]) ?? end
    const minutes = elapsedMinutes(start, end)
    return {
      ok: true,
      message: `供电结束，本次累计 ${minutes} 分钟，设备回到待命`,
      row: {
        ...row,
        status: GPU_STATUS_IDLE,
        pending: true,
        abnormal: false,
        [FIELD_DURATION]: durationMinutes(row[FIELD_DURATION]) + minutes,
        [START_KEY]: '',
        [END_KEY]: formatDateTime(end),
        [SETTLED_KEY]: true,
      },
    }
  }

  if (action === '申请检修') {
    // 跳级拦截：供电中必须先「结束供电」回待命，不许直接挂待检修。
    if (status === GPU_STATUS_POWERING) {
      return {
        ok: false,
        message: `设备处于供电中，只能先结束供电回到${GPU_STATUS_IDLE}，不允许直接跳${GPU_STATUS_REPAIR}（跳级已拦截）`,
      }
    }
    if (status === GPU_STATUS_REPAIR) {
      return { ok: false, message: '设备已经是待检修，无需重复申请' }
    }
    if (status !== GPU_STATUS_IDLE) {
      return { ok: false, message: `只有「${GPU_STATUS_IDLE}」设备可以申请检修，当前为「${status}」` }
    }
    return {
      ok: true,
      message: '已申请检修，设备进入待检修',
      row: { ...row, status: GPU_STATUS_REPAIR, pending: true, abnormal: false },
    }
  }

  if (action === '检修完成') {
    if (status !== GPU_STATUS_REPAIR) {
      return { ok: false, message: `只有「${GPU_STATUS_REPAIR}」设备可以检修完成，当前为「${status}」` }
    }
    return {
      ok: true,
      message: '检修完成，设备回到待命',
      row: { ...row, status: GPU_STATUS_IDLE, pending: true, abnormal: false },
    }
  }

  return { ok: false, message: `电源车没有登记「${action}」这个动作` }
}

/**
 * 存量数据修复（读取时执行，幂等可重复跑）：
 * 1. 供电时长规整为分钟数（占位文本按 0 处理）；
 * 2. 「结束供电点过但状态没回、时长没累计」的遗留设备，按接机航班时间回填：
 *    时长 = 结束时刻 - 接机航班时间，状态回到待命并标记已结算。
 */
export function migrateGpuRows(rows: EntryRow[], now: number = Date.now()): EntryRow[] {
  return rows.map((raw) => {
    const row: EntryRow = { ...raw }
    row[FIELD_DURATION] = durationMinutes(row[FIELD_DURATION])
    if (typeof row[START_KEY] !== 'string') row[START_KEY] = ''
    if (typeof row[END_KEY] !== 'string') row[END_KEY] = ''
    if (typeof row[SETTLED_KEY] !== 'boolean') row[SETTLED_KEY] = false

    if (row[LEGACY_STUCK_KEY] === true && String(row.status) === GPU_STATUS_POWERING) {
      const end = parseDateTime(row[END_KEY]) ?? now
      const start = parseDateTime(row[FIELD_ARRIVAL])
      row[FIELD_DURATION] = start === null ? 0 : elapsedMinutes(start, end)
      row.status = GPU_STATUS_IDLE
      row.pending = true
      row.abnormal = false
      row[START_KEY] = typeof raw[FIELD_ARRIVAL] === 'string' ? raw[FIELD_ARRIVAL] : ''
      row[SETTLED_KEY] = true
    }
    delete row[LEGACY_STUCK_KEY]
    return row
  })
}
