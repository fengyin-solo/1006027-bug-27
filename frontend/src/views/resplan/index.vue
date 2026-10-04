<template>
  <section class="page" data-module="resplan">
    <header class="page-head">
      <div>
        <h2>保障资源调度管理</h2>
        <p class="page-desc">电源车可用台数统一取设备状态（待命）这一份，与地面电源页完全同源；派发名单与设备状态冲突时以设备状态为准。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记资源计划</button>
        <button class="btn" type="button" @click="exportRows">导出保障资源调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="source-note">
      电源车可用台数：<strong>{{ availability.available }}</strong> 台
      （在册 {{ availability.total }} / 供电中 {{ availability.powering }} / 待检修 {{ availability.repairing }} / 已停用 {{ availability.disabled }}），
      与「地面电源」页读到的是同一份设备状态。
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>按电源车可用台数检索（需求 ≤ 可用）</span>
        <select v-model="availableOnly">
          <option value="all">全部计划</option>
          <option value="satisfiable">仅看可用台数能满足的</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '资源缺口'">
              <span :class="{ 'gap-text': gapInfo(row.id) > 0 }">{{ row[column] ?? '—' }}</span>
            </template>
            <template v-else-if="column === GPU_DISPATCH_FIELD">
              <span>{{ row[column] ?? '—' }}</span>
              <span v-if="conflictInfo(row.id).length" class="conflict-text">
                （冲突：{{ conflictInfo(row.id).join('、') }} 已不在待命，以设备状态为准，请改派）
              </span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无保障资源调度数据，可先登记资源计划</td>
        </tr>
      </tbody>
    </table>

    <h3 class="gap-head">资源缺口清单（电源车）</h3>
    <table class="data-table">
      <thead>
        <tr><th>计划编号</th><th>保障时段</th><th>电源车需求</th><th>当前可用</th><th>缺口</th><th>状态</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in gapList" :key="item.id">
          <td>{{ item.code }}</td>
          <td>{{ item.period }}</td>
          <td>{{ item.demand }} 台</td>
          <td>{{ item.available }} 台</td>
          <td class="gap-text">{{ item.gap }} 台</td>
          <td>{{ item.status }}</td>
        </tr>
        <tr v-if="!gapList.length">
          <td colspan="6" class="empty-state">当前无电源车缺口</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条保障资源调度记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  loadResplanSummary,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { GPU_DISPATCH_FIELD, parseGpuDemand } from '@/data/resource-domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('resplan')
const columns = ["计划编号", "保障时段", "车辆需求", "人员需求", GPU_DISPATCH_FIELD, "资源缺口", "调度人员", "计划状态"]
const actions = ["提交审核", "下发计划", "作废计划"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const availableOnly = ref<'all' | 'satisfiable'>('all')
const filterFields = ["计划编号", "保障时段"]

// 统一的响应式汇总：可用台数、缺口清单、冲突都挂在这一份上，reload 时整体刷新。
const summary = ref(loadResplanSummary())
const availability = computed(() => summary.value.availability)

const stats = computed(() => [
  { label: '电源车可用台数（同源）', value: availability.value.available },
  { label: '已下发计划', value: summary.value.dispatchedCount },
  { label: '存在缺口的计划', value: summary.value.gapCount },
])

// 缺口清单：随设备状态实时联动，设备在地面电源页结束供电回待命后，这里立即减少缺口。
const gapList = computed(() =>
  summary.value.plans
    .filter((item) => item.gap > 0)
    .map((item) => ({
      id: item.row.id,
      code: String(item.row['计划编号'] ?? ''),
      period: String(item.row['保障时段'] ?? ''),
      demand: item.demand,
      available: item.available,
      gap: item.gap,
      status: item.row.status,
    })),
)

function gapInfo(id: number | string): number {
  const item = summary.value.plans.find((plan) => Number(plan.row.id) === Number(id))
  return item ? item.gap : 0
}

function conflictInfo(id: number | string): string[] {
  const item = summary.value.plans.find((plan) => Number(plan.row.id) === Number(id))
  return item ? item.conflictCodes : []
}

function resetFilters() {
  filters.value = {}
  availableOnly.value = 'all'
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '资源计划登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 先按文本条件过滤；「按可用台数检索」在同源可用数上过滤，待检修/供电中/已停用都不算可用。
    let payload = listEntries(meta.key, filters.value)
    if (availableOnly.value === 'satisfiable') {
      const items = payload.items.filter((row) => parseGpuDemand(row['电源车需求']) <= availability.value.available)
      payload = { ...payload, items, total: items.length }
    }
    rows.value = payload.items
    total.value = payload.total
    summary.value = loadResplanSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保障资源调度列表读取失败'
  }
}

onMounted(reload)
</script>
