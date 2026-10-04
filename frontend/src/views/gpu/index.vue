<template>
  <section class="page" data-module="gpu">
    <header class="page-head">
      <div>
        <h2>地面电源管理</h2>
        <p class="page-desc">维护电源车，围绕设备编号、设备类型、功率等级、接机航班做登记、筛选与状态流转。可用台数以设备状态（待命）为唯一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记电源车</button>
        <button class="btn" type="button" @click="exportRows">导出地面电源清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(action, String(row.status))"
              :title="actionTip(action, String(row.status))"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无地面电源数据，可先登记电源车</td>
        </tr>
      </tbody>
    </table>

    <p class="rule-hint">
      流转规则：待命 ⇄ 供电中，待命 → 待检修 → 待命；供电中只能先「结束供电」回待命，不许直接跳「申请检修」。
      「结束供电」幂等，重复点击只累计一次时长。
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条地面电源记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  loadGpuAvailability,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('gpu')
const columns = ["设备编号", "设备类型", "功率等级", "接机航班", "到达时间", "供电时长", "操作人员", "电缆检查", "设备状态"]
const actions = ["接机供电", "结束供电", "申请检修", "检修完成"]
const statuses = ["待命", "供电中", "待检修", "已停用"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计卡取全局同源数据（不随筛选变化），可用台数即待命设备数。
const stats = computed(() => {
  const summary = loadGpuAvailability()
  return [
    { label: '在册电源车', value: summary.total },
    { label: '可用电源车（待命）', value: summary.available },
    { label: '供电中设备', value: summary.powering },
    { label: '待检修设备', value: summary.repairing },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function cellText(row: EntryRow, column: string): string {
  if (column === '供电时长') {
    const minutes = Number(row[column])
    return Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : '—'
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

// 页面只做按钮置灰，真正的状态机校验在数据层 gpu-domain；两层一致。
function canRun(action: string, status: string): boolean {
  if (action === '接机供电') return status === '待命'
  if (action === '结束供电') return status === '供电中'
  if (action === '申请检修') return status === '待命'
  if (action === '检修完成') return status === '待检修'
  return false
}

function actionTip(action: string, status: string): string {
  return canRun(action, status) ? action : `当前「${status}」状态不可执行「${action}」`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '电源车登记入口尚未接入审批流'
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '地面电源列表读取失败'
  }
}

onMounted(reload)
</script>
