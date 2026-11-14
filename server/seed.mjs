import { getDb, initSchema, setSetting, round2 } from './db.mjs';
import { DEFAULT_SETTINGS } from './repo.mjs';
import { docImportKey, paymentImportKey, addDays } from './domain.mjs';

const today = new Date().toISOString().slice(0, 10);

const CUSTOMERS = [
  ['华东精密机械有限公司', 'C-1001', 0],
  ['南方电子科技集团', 'C-1002', 0],
  ['北方重工装备股份公司', 'C-1003', 12],
  ['西部新材料有限公司', 'C-1004', 0],
  ['中原汽车零部件公司', 'C-1005', 25],
  ['海外环球贸易有限公司', 'C-1006', 0],
  ['长江物流服务有限公司', 'C-1007', 5],
];

const SUPPLIERS = [
  ['宝钢原材料供应有限公司', 'S-2001'],
  ['远东电子元件有限公司', 'S-2002'],
  ['恒通包装材料厂', 'S-2003'],
  ['德胜物流有限公司', 'S-2004'],
  ['国网电力能源公司', 'S-2005'],
  ['环球采购服务公司', 'S-2006'],
];

// [kind, doc_no, party, currency, amount, fx, issue, due, expected, note]
const DOCS = [
  // --- 应收 ---
  ['ar', 'AR-2601', '华东精密机械有限公司', 'CNY', 486000, null, -42, -12, 3, '整机设备尾款'],
  ['ar', 'AR-2602', '南方电子科技集团', 'CNY', 218500, null, -35, -5, 6, '电子模组批量订单'],
  ['ar', 'AR-2603', '华东精密机械有限公司', 'CNY', 132000, null, -28, 2, 10, '备件销售'],
  ['ar', 'AR-2604', '北方重工装备股份公司', 'CNY', 940000, null, -55, -22, -15, '大型设备验收款'],
  ['ar', 'AR-2605', '西部新材料有限公司', 'CNY', 379200, null, -20, 14, 20, '新材料试制'],
  ['ar', 'AR-2606', '中原汽车零部件公司', 'CNY', 562000, null, -48, -8, 9, '汽车件年度框架'],
  ['ar', 'AR-2607', '海外环球贸易有限公司', 'USD', 86000, 7.15, -30, 8, 15, '出口订单 US-771'],
  ['ar', 'AR-2608', '海外环球贸易有限公司', 'USD', 42500, null, -18, 25, 30, '出口备件'],
  ['ar', 'AR-2609', '南方电子科技集团', 'CNY', 167800, null, -10, 22, 28, '定制模组'],
  ['ar', 'AR-2610', '华东精密机械有限公司', 'CNY', 298000, null, -5, 35, 42, '四季度框架预收'],
  ['ar', 'AR-2611', '北方重工装备股份公司', 'CNY', 615000, null, -60, -30, 1, '逾期重点跟催'],
  ['ar', 'AR-2612', '西部新材料有限公司', 'EUR', 27400, 7.78, -25, 12, 18, '欧洲转口订单'],
  ['ar', 'AR-2613', '海外环球贸易有限公司', 'JPY', 3200000, null, -12, 40, 46, '日元结算样品单'],
  ['ar', 'AR-2614', '中原汽车零部件公司', 'CNY', 88000, null, -8, 55, 61, '小批量试产'],
  ['ar', 'AR-2615', '长江物流服务有限公司', 'CNY', 46500, null, -16, 18, 24, '物流服务分成'],
  // --- 应付 ---
  ['ap', 'AP-3601', '宝钢原材料供应有限公司', 'CNY', 720000, null, -38, -6, 2, '钢材月度采购'],
  ['ap', 'AP-3602', '远东电子元件有限公司', 'CNY', 385000, null, -30, 4, 8, '电子元件'],
  ['ap', 'AP-3603', '恒通包装材料厂', 'CNY', 96500, null, -25, 12, 16, '包装耗材'],
  ['ap', 'AP-3604', '德胜物流有限公司', 'CNY', 142000, null, -20, 26, 30, '干线运输'],
  ['ap', 'AP-3605', '国网电力能源公司', 'CNY', 268000, null, -14, 38, 44, '四季度电费'],
  ['ap', 'AP-3606', '宝钢原材料供应有限公司', 'CNY', 540000, null, -45, -18, -10, '上月钢材（已议付延期）'],
  ['ap', 'AP-3607', '环球采购服务公司', 'USD', 52000, 7.15, -22, 5, 9, '进口零部件 US-P-220'],
  ['ap', 'AP-3608', '环球采购服务公司', 'USD', 23800, null, -8, 48, 55, '进口检测设备'],
  ['ap', 'AP-3609', '远东电子元件有限公司', 'CNY', 196000, null, -6, 62, 68, '季度备货'],
  ['ap', 'AP-3610', '德胜物流有限公司', 'EUR', 15600, null, -18, 20, 27, '欧洲专线运费'],
  ['ap', 'AP-3611', '恒通包装材料厂', 'CNY', 63400, null, -10, 70, 76, '定制包装模具'],
  ['ap', 'AP-3612', '国网电力能源公司', 'CNY', 145000, null, -4, 82, 88, '预缴能源款'],
  ['ap', 'AP-3613', '宝钢原材料供应有限公司', 'CNY', 310000, null, -3, 88, 90, '年度框架补货'],
  ['ap', 'AP-3614', '远东电子元件有限公司', 'CNY', 88000, null, -2, 84, 91, '急件采购'],
  ['ap', 'AP-3615', '税务局（增值税及附加）', 'CNY', 2180000, null, -5, 16, 19, '季度增值税及附加'],
  ['ap', 'AP-3616', '工资社保代发户', 'CNY', 1260000, null, -2, 9, 12, '11 月工资与社保'],
  ['ap', 'AP-3617', '工资社保代发户', 'CNY', 1260000, null, -32, 39, 42, '12 月工资与社保'],
  ['ap', 'AP-3618', '税务局（增值税及附加）', 'CNY', 940000, null, -1, 72, 75, '年度所得税预缴'],
];

// [kind, ref_no, party, currency, amount, fx, date, note]
const PAYMENTS = [
  ['receipt', 'RC-9001', '华东精密机械有限公司', 'CNY', 300000, null, -8, 'AR-2601 首付'],
  ['receipt', 'RC-9002', '南方电子科技集团', 'CNY', 218500, null, -3, 'AR-2602 全额'],
  ['receipt', 'RC-9003', '北方重工装备股份公司', 'CNY', 400000, null, -12, 'AR-2604 部分'],
  ['receipt', 'RC-9004', '中原汽车零部件公司', 'CNY', 250000, null, -6, 'AR-2606 部分'],
  ['receipt', 'RC-9005', '海外环球贸易有限公司', 'USD', 40000, 7.15, -2, 'AR-2607 部分'],
  ['receipt', 'RC-9006', '西部新材料有限公司', 'CNY', 120000, null, -1, '预收，未分配'],
  ['receipt', 'RC-9007', '长江物流服务有限公司', 'CNY', 46500, null, -14, 'AR-2615 全额'],
  ['receipt', 'RC-9008', '华东精密机械有限公司', 'CNY', 68000, null, 1, '计划内回款'],
  ['payment', 'PM-8001', '宝钢原材料供应有限公司', 'CNY', 400000, null, -10, 'AP-3601 部分'],
  ['payment', 'PM-8002', '远东电子元件有限公司', 'CNY', 385000, null, -4, 'AP-3602 全额'],
  ['payment', 'PM-8003', '宝钢原材料供应有限公司', 'CNY', 200000, null, -20, 'AP-3606 部分'],
  ['payment', 'PM-8004', '环球采购服务公司', 'USD', 26000, 7.15, -5, 'AP-3607 部分'],
  ['payment', 'PM-8005', '德胜物流有限公司', 'CNY', 90000, null, 0, '未分配付款'],
  ['payment', 'PM-8006', '恒通包装材料厂', 'CNY', 96500, null, -9, 'AP-3603 全额'],
  ['payment', 'PM-8007', '宝钢原材料供应有限公司', 'CNY', 150000, null, 2, '计划付款'],
];

// [payment ref, document no, amount, date, voided]
const ALLOCS = [
  ['RC-9001', 'AR-2601', 300000, -8, 0],
  ['RC-9002', 'AR-2602', 218500, -3, 0],
  ['RC-9003', 'AR-2604', 400000, -12, 0],
  ['RC-9004', 'AR-2606', 250000, -6, 0],
  ['RC-9005', 'AR-2607', 40000, -2, 0],
  ['RC-9007', 'AR-2615', 46500, -14, 0],
  ['PM-8001', 'AP-3601', 400000, -10, 0],
  ['PM-8002', 'AP-3602', 385000, -4, 0],
  ['PM-8003', 'AP-3606', 200000, -20, 0],
  ['PM-8004', 'AP-3607', 26000, -5, 0],
  ['PM-8006', 'AP-3603', 96500, -9, 0],
  // a second partial receipt on the same document — demonstrates 多次部分核销
  ['RC-9008', 'AR-2605', 68000, 1, 0],
  // an allocation that was voided, to demonstrate 撤销恢复未结金额
  ['RC-9001', 'AR-2603', 50000, -7, 1],
];

const HOLIDAYS = [
  addDays(today, 7), addDays(today, 8), addDays(today, 9), // 一段导入的连续假日
  '2026-12-25', '2026-12-26',
];

export function isSeeded() {
  const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get();
  if (!row) return false;
  return getDb().prepare('SELECT COUNT(*) AS n FROM documents').get().n > 0;
}

export function seedIfEmpty({ force = false } = {}) {
  initSchema();
  const db = getDb();
  if (isSeeded() && !force) return false;
  if (force) {
    db.exec(`DELETE FROM allocations; DELETE FROM scenario_overrides; DELETE FROM scenario_customer_delays;
             DELETE FROM scenarios; DELETE FROM documents; DELETE FROM payments; DELETE FROM customers;
             DELETE FROM opening_balances; DELETE FROM import_batches; DELETE FROM settings; DELETE FROM calendars;
             DELETE FROM sqlite_sequence;`);
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    plan_start: today,
    plan_weeks: 13,
    safety_threshold: 500000,
  };
  for (const [k, v] of Object.entries(settings)) setSetting(k, v);

  db.prepare('INSERT INTO calendars(name, holidays, weekend_rule, weekend_enabled, is_default) VALUES(?,?,?,?,1)')
    .run('公司工作日历（含导入节假日）', JSON.stringify(HOLIDAYS), 'next', 0);
  db.prepare('INSERT INTO calendars(name, holidays, weekend_rule, weekend_enabled, is_default) VALUES(?,?,?,?,0)')
    .run('自然日（不顺延）', '[]', 'none', 1);

  const insCust = db.prepare('INSERT INTO customers(name, code, delay_days) VALUES(?,?,?)');
  const custIds = {};
  for (const [name, code, delay] of CUSTOMERS) {
    custIds[name] = Number(insCust.run(name, code, delay).lastInsertRowid);
  }
  for (const [name, code] of SUPPLIERS) {
    custIds[name] = Number(insCust.run(name, code, 0).lastInsertRowid);
  }
  for (const name of ['税务局（增值税及附加）', '工资社保代发户']) {
    custIds[name] = Number(insCust.run(name, name.startsWith('税') ? 'T-3001' : 'P-3002', 0).lastInsertRowid);
  }

  const insDoc = db.prepare(`INSERT INTO documents(kind, doc_no, party, customer_id, currency, amount_original, fx_rate,
      issue_date, due_date, expected_date, note, import_batch, import_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const docIds = {};
  for (const [kind, no, party, ccy, amount, fx, issueOff, dueOff, expOff, note] of DOCS) {
    const issue = addDays(today, issueOff);
    const due = addDays(today, dueOff);
    const exp = addDays(today, expOff);
    const key = docImportKey({ kind, doc_no: no, party, currency: ccy, amount, due_date: due });
    docIds[no] = Number(insDoc.run(kind, no, party, custIds[party] ?? null, ccy, round2(amount), fx, issue, due, exp, note, 'SEED', key).lastInsertRowid);
  }

  const insPay = db.prepare(`INSERT INTO payments(kind, ref_no, party, currency, amount_original, fx_rate, received_date, note, import_batch, import_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const payIds = {};
  for (const [kind, ref, party, ccy, amount, fx, dateOff, note] of PAYMENTS) {
    const date = addDays(today, dateOff);
    const key = paymentImportKey({ kind, ref_no: ref, party, currency: ccy, amount, received_date: date });
    payIds[ref] = Number(insPay.run(kind, ref, party, ccy, round2(amount), fx, date, note, 'SEED', key).lastInsertRowid);
  }

  const insAlloc = db.prepare('INSERT INTO allocations(payment_id, document_id, amount, allocated_date, voided, voided_at) VALUES(?,?,?,?,?,?)');
  for (const [ref, docNo, amount, dateOff, voided] of ALLOCS) {
    const date = addDays(today, dateOff);
    insAlloc.run(payIds[ref], docIds[docNo], round2(amount), date, voided, voided ? new Date().toISOString() : null);
  }

  const opening = [
    // fx_rate stays NULL so each row always resolves against the current plan;
    // a hard-coded 1 would misread as "1 CNY = 1 USD" after a base-currency switch
    ['CNY', 3200000, null],
    ['USD', 120000, 7.15],
    ['EUR', 18000, 7.78],
    ['GBP', 24000, null], // 缺汇率 → 单列
  ];
  const insOpen = db.prepare('INSERT INTO opening_balances(currency, amount, as_of, fx_rate) VALUES(?,?,?,?)');
  for (const [ccy, amount, fx] of opening) insOpen.run(ccy, amount, today, fx);

  const insScenario = db.prepare('INSERT INTO scenarios(name, description, base) VALUES(?,?,?)');
  const baseId = Number(insScenario.run('基准方案', '按当前预计结算日与合同到期日', 1).lastInsertRowid);
  const scenB = Number(insScenario.run('客户回款延迟 30 天', '重点客户回款整体顺延 30 天，观察现金缺口', 0).lastInsertRowid);
  insScenario.run('大额逾期情景', '北方重工与中原汽车逾期部分继续延迟 45 天', 0);

  const insDelay = db.prepare('INSERT INTO scenario_customer_delays(scenario_id, customer_id, delay_days, reason) VALUES(?,?,?,?)');
  insDelay.run(scenB, custIds['华东精密机械有限公司'], 30, '客户内部审批延长');
  insDelay.run(scenB, custIds['北方重工装备股份公司'], 30, '回款流程顺延');
  insDelay.run(scenB, custIds['中原汽车零部件公司'], 30, '季度结算周期调整');

  const scenC = db.prepare('SELECT id FROM scenarios WHERE base = 0 ORDER BY id DESC LIMIT 1').get().id;
  insDelay.run(scenC, custIds['北方重工装备股份公司'], 45, '重点逾期');
  const insOv = db.prepare('INSERT INTO scenario_overrides(scenario_id, document_id, expected_date, reason) VALUES(?,?,?,?)');
  insOv.run(scenC, docIds['AR-2601'], addDays(today, 75), '设备尾款验收推迟');
  insOv.run(scenC, docIds['AR-2604'], addDays(today, 70), '大型设备验收推迟');
  insOv.run(scenC, docIds['AR-2611'], addDays(today, 80), '诉讼流程中');

  db.prepare('UPDATE scenarios SET id = ? WHERE id = ?').run(baseId, baseId); // no-op keeps id stable

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedIfEmpty({ force: process.argv.includes('--force') });
  console.log('Seeded database at', new Date().toISOString());
}
