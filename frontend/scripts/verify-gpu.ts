import { strict as assert } from 'node:assert'
import { SEED_ROWS } from '../src/data/seed'
import { migrateGpuRows, applyGpuAction, gpuSummary } from '../src/data/gpu-domain'
import { enrichResplanRow, gpuGapCount } from '../src/data/resource-domain'
import type { EntryRow } from '../src/data/types'

const fixedNow = new Date('2026-10-04T09:00:00').getTime()
const gpu = migrateGpuRows(SEED_ROWS.gpu as EntryRow[], fixedNow)

// 1. 存量回填：GPU-0005 结束供电没回状态、没累计时长 → 回待命，时长按接机航班时间补 100 分钟
const gpu5 = gpu.find((r) => r['设备编号'] === 'GPU-0005')!
assert.equal(gpu5.status, '待命', '遗留设备应回填为待命')
assert.equal(gpu5['供电时长'], 100, '遗留设备时长应按 18:30→20:10 回填为 100 分钟')
assert.equal(gpu5['_已结算'], true, '遗留设备应标记已结算')

// 2. 可用台数同源：待命 3 台（0001/0004/0005），供电中 1（0002），待检修 1（0003）
const summary = gpuSummary(gpu)
assert.deepEqual(
  { total: summary.total, available: summary.available, powering: summary.powering, repairing: summary.repairing },
  { total: 5, available: 3, powering: 1, repairing: 1 },
)

// 3. 结束供电幂等：GPU-0002 首次结束累计时长，重复点不再累计
const gpu2 = gpu.find((r) => r['设备编号'] === 'GPU-0002')!
const first = applyGpuAction(gpu2, '结束供电', new Date('2026-10-04T09:00:00').getTime())
assert.equal(first.ok, true)
assert.equal(first.row!.status, '待命')
// 07:40 → 09:00 = 80 分钟，叠加原有 60
assert.equal(first.row!['供电时长'], 140)
const second = applyGpuAction(first.row!, '结束供电', new Date('2026-10-04T10:00:00').getTime())
assert.equal(second.ok, true)
assert.equal(second.row, undefined, '幂等返回不应再改记录')
assert.equal(first.row!['供电时长'], 140, '重复点击不重复累计时长')

// 4. 跳级拦截：供电中不许直接申请检修
const jump = applyGpuAction(gpu2, '申请检修')
assert.equal(jump.ok, false)
assert.match(jump.message, /跳级已拦截/)

// 5. 待检修不算可用：以 GPU-0003 派车的 RESP-0004 必须报冲突，且调度侧可用数与设备侧一致
const plans = SEED_ROWS.resplan as EntryRow[]
const info4 = enrichResplanRow(plans.find((p) => p['计划编号'] === 'RESP-0004')!, gpu)
assert.equal(info4.available, 3, '调度侧可用台数必须与设备状态同源（3 台）')
assert.deepEqual(info4.conflictCodes, ['GPU-0003'], '在修设备应判冲突并提示改派')

// 6. 缺口联动：需求 4 台、可用 3 台 → RESP-0001 缺口 1
const info1 = enrichResplanRow(plans.find((p) => p['计划编号'] === 'RESP-0001')!, gpu)
assert.equal(info1.demand, 4)
assert.equal(info1.gap, 1)
assert.equal(gpuGapCount(plans, gpu), 1, '缺口清单只列出 RESP-0001')

// 7. 设备回到待命后缺口消失：给 GPU-0002 结束供电（上面已做），重算则无缺口
const afterEnd = gpu.map((r) => (r['设备编号'] === 'GPU-0002' ? first.row! : r))
assert.equal(gpuSummary(afterEnd).available, 4)
assert.equal(gpuGapCount(plans, afterEnd), 0, '供电中设备回待命后缺口清单应清零')
assert.equal(enrichResplanRow(plans.find((p) => p['计划编号'] === 'RESP-0004')!, afterEnd).conflictCodes.length, 1, '冲突名单仍只挂在修的 0003')

// 8. 待检修检修完成回待命
const repaired = applyGpuAction(gpu.find((r) => r['设备编号'] === 'GPU-0003')!, '检修完成')
assert.equal(repaired.row!.status, '待命')

// 9. 迁移幂等：再跑一次，回填记录不被二次处理
const again = migrateGpuRows(gpu, fixedNow)
assert.equal(again.find((r) => r['设备编号'] === 'GPU-0005')!['供电时长'], 100)

console.log('全部业务规则校验通过 ✔')
