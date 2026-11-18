import type { Page } from '../ui/dom';
import { el, clearNode, toast } from '../ui/dom';
import { store } from '../lib/store';
import { fmt } from '../lib/math';
import { downloadText, downloadBlob } from '../lib/files';
import { runFullSimulation, summarizeCharge } from '../lib/simulation';
import { guardRadiusM } from './fireworks';
import type { SimulationReport } from '../domain/types';

export class PermitPage implements Page {
  private host!: HTMLElement;
  private report: SimulationReport | null = null;

  async render(container: HTMLElement) {
    this.host = container;
    this.host.classList.add('page');
    if (!store.state.meta || !store.state.site || !store.state.choreo) {
      this.host.append(el('div', { class: 'panel' },
        el('h3', {}, '报批材料'), el('p', { class: 'warn' }, '请先在工程设置中建立场次，并完成场地与编排。')));
      return;
    }
    this.report = runFullSimulation({
      site: store.state.site,
      types: store.state.types,
      choreo: store.state.choreo,
      params: store.state.simParams,
      licenseLevel: store.state.meta.licenseLevel,
      showStart: store.state.meta.showStart,
    });
    this.draw();
  }

  private async regenerate() {
    this.report = runFullSimulation({
      site: store.state.site!,
      types: store.state.types,
      choreo: store.state.choreo!,
      params: store.state.simParams,
      licenseLevel: store.state.meta!.licenseLevel,
      showStart: store.state.meta!.showStart,
    });
    this.draw();
    toast('全套报批材料已按最新方案重新生成', 'ok');
  }

  private draw() {
    clearNode(this.host);
    const meta = store.state.meta!;
    this.host.append(
      el('div', { class: 'panel' },
        el('h3', {}, '报批材料自动生成', el('span', { class: 'tag' }, '方案修改后点击重新生成即全套刷新')),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', onclick: () => this.regenerate() }, '🔄 一键重新生成全套'),
          el('button', { class: 'btn', onclick: () => this.exportPlanHtml() }, '导出燃放作业方案 HTML'),
          el('button', { class: 'btn', onclick: () => this.exportGuardMapPng() }, '导出警戒部署图 PNG'),
          el('button', { class: 'btn', onclick: () => this.exportEmergencyTxt() }, '导出应急预案 TXT'),
          el('button', { class: 'btn', onclick: () => this.exportStaffCsv() }, '导出人员分工表 CSV'),
        ),
        this.report!.passed
          ? el('div', { class: 'pass-banner ok', style: 'margin-top:12px' }, '✓ 仿真硬性项通过，材料可提交公安报批')
          : el('div', { class: 'pass-banner fail', style: 'margin-top:12px' }, '✗ 仿真存在拦截项，报批材料已附整改提示，禁止带隐患提交'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '文档预览（打印样式）'),
        el('div', { class: 'doc-preview', id: 'doc' }, this.planDom()),
      ),
    );
    void meta;
  }

  private planDom(): HTMLElement {
    const meta = store.state.meta!;
    const site = store.state.site!;
    const types = store.state.types;
    const choreo = store.state.choreo!;
    const charge = summarizeCharge(choreo, types);
    const r = this.report!;
    const typeCount = new Map<string, number>();
    choreo.firings.forEach((f) => typeCount.set(f.typeId, (typeCount.get(f.typeId) ?? 0) + 1));

    const box = document.createElement('div');
    box.innerHTML = `
      <h1>焰火燃放作业方案</h1>
      <p style="text-align:center">（${meta.licenseLevel}级燃放作业）</p>
      <h2>一、场次基本信息</h2>
      <table>
        <tr><th>项目名称</th><td>${meta.name}</td><th>作业地点</th><td>${meta.location}</td></tr>
        <tr><th>主办单位</th><td>${meta.organizer}</td><th>燃放日期</th><td>${meta.showDate} ${meta.showStart}</td></tr>
        <tr><th>公司资质</th><td>${meta.companyQualLevel}级（营业性燃放资质）</td><th>公安许可级别</th><td>${meta.licenseLevel}级</td></tr>
        <tr><th>发次总数</th><td>${choreo.firings.length} 发</td><th>整场总药量</th><td>${fmt(charge.totalKg, 2)} kg</td></tr>
        <tr><th>气象条件</th><td colspan="3">风速 ${site.wind.speed}m/s，风向 ${site.wind.direction}°，稳定度 ${site.wind.stability}，气温 ${site.wind.tempC}℃，湿度 ${site.wind.humidity}%</td></tr>
      </table>
      <h2>二、场地参数</h2>
      <table>
        <tr><th>燃放点位数</th><td>${site.launchPoints.length} 个</td><th>观众席</th><td>${site.audience.length} 处</td></tr>
        <tr><th>周边建筑</th><td>${site.buildings.length} 栋</td><th>敏感目标</th><td>${site.sensitive.length} 处</td></tr>
        <tr><th>高压线/塔吊等</th><td>${site.obstacles.length} 处</td><th>消防水源</th><td>${site.waterSources.length} 处</td></tr>
        <tr><th>导线闭合差</th><td colspan="3">${site.traverseResult
          ? `全长 ${fmt(site.traverseResult.linearMisclosure, 4)}m（容许 ${fmt(site.traverseResult.allowableLinear, 4)}m），高程 ${fmt(site.traverseResult.heightMisclosure, 4)}m，${site.traverseResult.overTolerance || site.traverseResult.overToleranceHeight ? '超差！' : '合格'}`
          : '未核算'}</td></tr>
      </table>
      <h2>三、弹种清单与药量核算表</h2>
      <table>
        <tr><th>弹种</th><th>级别</th><th>口径mm</th><th>数量(发)</th><th>单发药量g</th><th>小计kg</th><th>警戒半径m</th></tr>
        ${[...typeCount.entries()].map(([tid, n]) => {
          const t = types.find((x) => x.id === tid);
          if (!t) return '';
          return `<tr><td>${t.name}</td><td>${t.level}</td><td>${t.caliber}</td><td>${n}</td><td>${t.singleChargeG}</td><td>${fmt(n * t.singleChargeG / 1000, 2)}</td><td>${fmt(guardRadiusM(t), 1)}</td></tr>`;
        }).join('')}
        <tr><th colspan="5">整场总药量</th><th colspan="2">${fmt(charge.totalKg, 2)} kg</th></tr>
      </table>
      <h2>四、安全距离表</h2>
      <table>
        <tr><th>核算项</th><th>结果</th><th>判定</th></tr>
        <tr><td>冲击波超压（观众席限值 ${store.state.simParams.overpressureAudienceKPa}kPa）</td><td>超标 ${r.overpressure.filter((o) => o.exceeded).length} 项</td><td>${r.overpressure.some((o) => o.exceeded) ? '不通过' : '通过'}</td></tr>
        <tr><td>殉爆安全距离 R=K√Q</td><td>不足 ${r.symDetonation.filter((s) => s.violated).length} 对</td><td>${r.symDetonation.some((s) => s.violated) ? '不通过' : '通过'}</td></tr>
        <tr><td>敏感目标缓冲距离</td><td>不足 ${r.sensitiveBuffer.filter((s) => s.bufferViolated).length} 处</td><td>${r.sensitiveBuffer.some((s) => s.bufferViolated) ? '不通过' : '通过'}</td></tr>
        <tr><td>净空障碍物</td><td>${r.clearance.length} 处冲突</td><td>${r.clearance.length ? '不通过' : '通过'}</td></tr>
        <tr><td>残骸越界</td><td>${r.fragmentOuts.filter((f) => f.crossedBoundary).length} 发</td><td>${r.fragmentOuts.some((f) => f.crossedBoundary) ? '不通过' : '通过'}</td></tr>
        <tr><td>噪声（夜间限值 ${store.state.simParams.nightLimitDb}dB）</td><td>超标 ${r.noise.filter((n) => n.exceeded).length} 项</td><td>${r.noise.some((n) => n.exceeded) ? '需采取降噪措施' : '通过'}</td></tr>
      </table>
      <h2>五、哑弹/未爆弹应急处置</h2>
      <p>本场理论哑弹预警点 ${r.duds.length} 个（按各弹种哑弹率与风偏蒙特卡洛散布计算），处置流程：断电断讯→警戒围挡→双人专业组沿预定进场路线抵近→水浸降温→现场引爆或防爆罐转移→录像建档→解除警戒。</p>
      <h2>六、人员分工（摘要，详见人员分工表）</h2>
      <p>总指挥 1 名、技术负责人 1 名、点火操作组、警戒安保组、消防应急组、医疗救护组、哑弹处置组（持证专业人员）。</p>
      <p style="margin-top:30px;text-align:right">编制日期：${new Date().toLocaleDateString()}　　编制单位（盖章）：__________</p>
    `;
    return box;
  }

  private exportPlanHtml() {
    const doc = document.getElementById('doc')!;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>燃放作业方案</title>
      <style>body{font-family:"SimSun",serif;max-width:900px;margin:30px auto;line-height:1.9;padding:0 20px}
      h1,h2{text-align:center;font-family:"SimHei"}h2{text-align:left}
      table{width:100%;border-collapse:collapse;font-size:13px}td,th{border:1px solid #555;padding:5px 8px}
      th{background:#e8ebf2}</style></head><body>${doc.innerHTML}</body></html>`;
    downloadText(`${store.state.meta!.name}_燃放作业方案.html`, html, 'text/html');
    toast('作业方案已导出，可直接浏览器打印为 PDF', 'ok');
  }

  /** 警戒部署图：Canvas 2D 俯视图（警戒线/疏散通道/点位/敏感目标/哑弹区） */
  private exportGuardMapPng() {
    const site = store.state.site!;
    const all = [
      ...site.launchPoints.map((p) => p.position),
      ...site.buildings.flatMap((b) => b.footprint),
      ...site.sensitive.map((s) => s.position),
      ...site.audience.flatMap((a) => a.polygon),
    ];
    const minE = Math.min(...all.map((p) => p[0])) - 40;
    const maxE = Math.max(...all.map((p) => p[0])) + 40;
    const minN = Math.min(...all.map((p) => p[1])) - 40;
    const maxN = Math.max(...all.map((p) => p[1])) + 40;
    const W = 1600, H = 1200;
    const sx = W / (maxE - minE), sy = H / (maxN - minN);
    const sc = Math.min(sx, sy);
    const X = (e: number) => (e - minE) * sc + 30;
    const Y = (n: number) => H - ((n - minN) * sc + 30);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#f4f6fa';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 28px Microsoft YaHei';
    ctx.fillText(`${store.state.meta!.name} 警戒部署图`, 40, 48);
    ctx.font = '16px Microsoft YaHei';

    // 建筑
    ctx.fillStyle = '#b9c2d0';
    for (const b of site.buildings) {
      ctx.beginPath();
      b.footprint.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
      ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#667'; ctx.stroke();
    }
    // 观众席
    ctx.fillStyle = 'rgba(59,130,246,.35)';
    for (const a of site.audience) {
      ctx.beginPath();
      a.polygon.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1d4ed8'; ctx.fillText(a.name, X(a.polygon[0][0]), Y(a.polygon[0][1]));
      ctx.fillStyle = 'rgba(59,130,246,.35)';
    }
    // 疏散通道
    ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 4;
    for (const r of site.evacRoutes) {
      ctx.beginPath();
      r.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
      ctx.stroke();
    }
    // 点位 + 警戒圆
    ctx.lineWidth = 2;
    for (const p of site.launchPoints) {
      const maxGuard = Math.max(...store.state.types.map((t) => guardRadiusM(t)), 30);
      ctx.beginPath();
      ctx.arc(X(p.position[0]), Y(p.position[1]), maxGuard * sc, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239,68,68,.8)';
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(X(p.position[0]), Y(p.position[1]), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7f1d1d';
      ctx.fillText(p.code, X(p.position[0]) + 8, Y(p.position[1]) - 8);
    }
    // 敏感目标
    for (const s of site.sensitive) {
      ctx.fillStyle = s.bufferViolated ? '#dc2626' : '#d97706';
      ctx.fillRect(X(s.position[0]) - 6, Y(s.position[1]) - 6, 12, 12);
      ctx.fillStyle = '#111';
      ctx.fillText(`${s.name}(${s.category})`, X(s.position[0]) + 10, Y(s.position[1]));
    }
    // 哑弹警戒区
    if (this.report) {
      ctx.strokeStyle = '#ea580c';
      for (const d of this.report.duds) {
        ctx.beginPath();
        d.exclusionZone.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
        ctx.closePath(); ctx.stroke();
      }
    }
    // 图例
    ctx.font = '15px Microsoft YaHei';
    const legend = ['红虚线圆：警戒半径', '红点：燃放点位', '蓝色块：观众席', '绿线：疏散通道', '橙多边形：哑弹处置警戒区'];
    legend.forEach((t, i) => ctx.fillText(t, 40, H - 120 + i * 22));
    cv.toBlob((blob) => {
      if (blob) {
        downloadBlob('警戒部署图.png', blob);
        toast('警戒部署图 PNG 已导出', 'ok');
      }
    }, 'image/png');
  }

  private exportEmergencyTxt() {
    const site = store.state.site!;
    const r = this.report!;
    const text = [
      `《${store.state.meta!.name}》焰火燃放应急预案`,
      `一、概况：${store.state.meta!.showDate} ${store.state.meta!.showStart}，${site.launchPoints.length} 个点位，${store.state.choreo?.firings.length} 发。`,
      '二、组织机构：总指挥、技术组、点火组、警戒组、消防组、医疗组、哑弹处置组。',
      `三、哑弹/未爆弹：理论预警点 ${r.duds.length} 个，按“断电—警戒—抵近—水浸—引爆/转移—解除”流程处置，专业人员持证上岗，双人作业。`,
      `四、火灾防控：高风险建筑 ${r.fireLoad.filter((f) => f.risk === '高').length} 栋（易燃外墙保温），按仿真清单配置灭火器材 ${r.fireLoad.reduce((s, f) => s + f.extinguisherCount, 0)} 具；最近消防水源距离见清单。`,
      `五、超压/残骸：仿真超标 ${r.overpressure.filter((o) => o.exceeded).length} 项、越界 ${r.fragmentOuts.filter((f) => f.crossedBoundary).length} 发；若仍有未整改项禁止燃放。`,
      `六、疏散：${site.evacRoutes.length} 条疏散通道，安保组按警戒部署图定岗，广播分区引导，医疗点设于观众席上风向。`,
      '七、气象应急：风速超过 8m/s 或风向变化超出方案包络时立即停演，按点火时序切断后续发次。',
    ].join('\n');
    downloadText('应急预案.txt', text, 'text/plain');
    toast('应急预案已导出', 'ok');
  }

  private exportStaffCsv() {
    const rows: (string | number)[][] = [
      ['岗位', '人数', '职责', '资质要求'],
      ['总指挥', 1, '全场指挥、停演决策权', '燃放作业指挥员证'],
      ['技术负责人', 1, '方案技术交底、仿真参数复核', '工程师/燃放技术人员'],
      ['点火操作组', Math.max(2, Math.ceil((store.state.site?.launchPoints.length ?? 2) / 4)), '按点火时序文件操作主控、通道自检', '燃放作业人员证'],
      ['警戒安保组', Math.max(4, (store.state.site?.launchPoints.length ?? 2) * 2), '警戒线值守、疏散引导', '安保培训合格'],
      ['消防应急组', 4, '灭火器材与水源管控、初起火灾扑救', '消防培训合格'],
      ['医疗救护组', 3, '现场急救与转运对接', '医护资质'],
      ['哑弹处置组', 2, '未爆弹警戒与专业处置', '持证专业人员'],
    ];
    downloadText('人员分工表.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
    toast('人员分工表已导出', 'ok');
  }
}
