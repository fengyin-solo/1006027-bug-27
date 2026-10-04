import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  GPU_KEY,
  applyGpuAction,
  gpuSummary,
} from '@/data/gpu-domain'
import {
  RESPLAN_KEY,
  decorateResplanRow,
  dispatchedPlanCount,
  enrichResplanRow,
  gpuGapCount,
} from '@/data/resource-domain'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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
  const matched = filterRows(listRows(key), filters)
  // 资源调度页：资源缺口、派发名单状态一律读取时从电源车实时状态派生，页面拿到的就是同源结果。
  const decorated = key === RESPLAN_KEY ? matched.map((row) => decorateResplanRow(row, listRows(GPU_KEY))) : matched
  return { items: decorated, total: decorated.length, page: 1, size: decorated.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 电源车：状态流转、跳级拦截、时长累计幂等全部走 gpu-domain，页面层不做业务判断。
  if (key === GPU_KEY) {
    const outcome = applyGpuAction(rows[index], action)
    if (!outcome.ok) {
      return { ok: false, message: outcome.message }
    }
    if (outcome.row) {
      const next = [...rows]
      next[index] = outcome.row
      saveRows(key, next)
    }
    return { ok: true, message: outcome.message }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 电源车可用台数的唯一查询出口：两个入口（设备列表、资源调度）都从这里取，口径必然对得上。
export function loadGpuAvailability() {
  const rows = listRows(GPU_KEY)
  return gpuSummary(rows)
}

// 资源调度汇总：可用台数同源取数，缺口清单与派发冲突随设备状态实时联动。
export function loadResplanSummary() {
  const gpuRows = listRows(GPU_KEY)
  const plans = listRows(RESPLAN_KEY)
  const enriched = plans.map((row) => enrichResplanRow(row, gpuRows))
  return {
    availability: gpuSummary(gpuRows),
    gapCount: gpuGapCount(plans, gpuRows),
    dispatchedCount: dispatchedPlanCount(plans),
    plans: enriched,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 走 listEntries：调度模块导出的资源缺口与页面一致，都是从设备状态实时派生的值。
  for (const row of listEntries(key).items) {
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
