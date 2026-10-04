import type { EntryRow } from './types'
import { gpuAvailableCount, isGpuAvailableStatus } from './gpu-domain'

// 资源调度领域：本模块不维护第二份「可用台数」。
// 可用台数统一向 gpu-domain 取（即设备状态 === 待命），
// 资源缺口、派发名单是否有效都是在读取时从设备状态实时派生，不再落第二份数据。
export const RESPLAN_KEY = 'resplan'

const FIELD_GPU_DEMAND = '电源车需求'
const FIELD_GAP = '资源缺口'
const GPU_DISPATCH_KEY = '_派发车号'
export const GPU_DISPATCH_FIELD = '派发电源车'
const GPU_STATUS_FIELD = '_派发车状态'

export function parseGpuDemand(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  const matched = String(value ?? '').match(/(\d+)/)
  return matched ? Number.parseInt(matched[1], 10) : 0
}

export function parseDispatchCodes(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，、\s]+/)
    .map((code) => code.trim())
    .filter(Boolean)
}

export type EnrichedPlan = {
  row: EntryRow
  demand: number
  available: number
  gap: number
  dispatchedCodes: string[]
  // 派发名单与设备状态冲突的车号：名单里挂着、但设备已不在待命（供电中/待检修/已停用/查无此车）。
  conflictCodes: string[]
}

export function enrichResplanRow(plan: EntryRow, gpuRows: EntryRow[]): EnrichedPlan {
  // 冲突裁决依据（两处冲突都按这一份算）：
  // 设备状态是现场实时状态，是唯一事实源；派发名单只是计划侧的离线快照，会滞后。
  // 所以名单里的车若状态已不是待命，以设备状态为准判为不可派，并计入冲突提示。
  const gpuByCode = new Map<string, EntryRow>()
  for (const gpu of gpuRows) {
    gpuByCode.set(String(gpu['设备编号'] ?? ''), gpu)
  }
  const dispatchedCodes = parseDispatchCodes(plan[GPU_DISPATCH_KEY])
  const conflictCodes = dispatchedCodes.filter((code) => {
    const gpu = gpuByCode.get(code)
    return !gpu || !isGpuAvailableStatus(gpu.status)
  })
  // 缺口只看实时待命车总数：派发名单只是快照，不再折减运力——名单里失效的车
  // 已在 conflictCodes 单列，调度据此改派即可，避免把同一份不可用算两遍。
  const available = gpuAvailableCount(gpuRows)
  const demand = parseGpuDemand(plan[FIELD_GPU_DEMAND])
  const gap = String(plan.status) === '已作废' ? 0 : Math.max(0, demand - available)
  return { row: plan, demand, available, gap, dispatchedCodes, conflictCodes }
}

export function decorateResplanRow(plan: EntryRow, gpuRows: EntryRow[]): EntryRow {
  const info = enrichResplanRow(plan, gpuRows)
  const statusText = info.dispatchedCodes
    .map((code) => {
      const gpu = gpuRows.find((item) => String(item['设备编号'] ?? '') === code)
      return `${code}:${gpu ? gpu.status : '查无此车'}`
    })
    .join('，')
  const gapText = info.gap > 0 ? `电源车缺口 ${info.gap} 台` : info.demand > 0 ? '电源车可满足' : '—'
  return {
    ...plan,
    [FIELD_GAP]: gapText,
    [GPU_DISPATCH_FIELD]: info.dispatchedCodes.join('，') || '—',
    [GPU_STATUS_FIELD]: statusText || '—',
  }
}

export function gpuGapCount(plans: EntryRow[], gpuRows: EntryRow[]): number {
  return plans.reduce(
    (sum, plan) => sum + (String(plan.status) === '已作废' ? 0 : (enrichResplanRow(plan, gpuRows).gap > 0 ? 1 : 0)),
    0,
  )
}

export function dispatchedPlanCount(plans: EntryRow[]): number {
  return plans.filter((plan) => String(plan.status) === '已下发').length
}
