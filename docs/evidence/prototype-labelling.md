# Prototype labelling — before / after

Changes to `prototype.html` for the tender review. These are labels only: no new features, and the visual style is unchanged.
New labels reuse the prototype's existing status-pill style (`.st`, `.st.warn`) and its `.note` text.

| # | Change | Before | After |
|---|---|---|---|
| 1 | Label helpers (reuse the existing .st pill style) | `const tag=t=>`<span class="tag ${t}">${t}</span>`;` | `const tag=t=>`<span class="tag ${t}">${t}</span>`; const ASM=`<span class="st warn">Assumption — pending NWS confirmation</span>`; const PEND=q=>`<span class="st warn">Pending NWS clarification (${q})</span>`; const DEMO` |
| 2 | KPI tiles: every tile is labelled Demo data (opt-out for non-metrics) | `const kpis=a=>`<div class="kpis">${a.map(([v,l])=>`<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;` | `const kpis=a=>`<div class="kpis">${a.map(([v,l,demo=true])=>`<div class="kpi"><b>${v}</b><span>${l}${demo?' · Demo data':''}</span></div>`).join('')}</div>`;` |
| 3 | Bar charts: Demo data note under every chart (opt-out for tender figures) | `function bars(rows,max,fmt=v=>v.toLocaleString(),col){return`<div class="bars">${rows.map(([l,v,c])=>`<div class="bar"><span>${l}</span><div class="track"><div class="fill" style="width:${Math.min(100,v/max*100).toFixed(` | `function bars(rows,max,fmt=v=>v.toLocaleString(),col,demo=true){return`<div class="bars">${rows.map(([l,v,c])=>`<div class="bar"><span>${l}</span><div class="track"><div class="fill" style="width:${v==null?0:Math.min(100` |
| 4 | Annual trips: drinking water 9,600,000 → TBC (wastewater and treated effluent stay as tender figures) | `${bars([['Drinking water',9600000,'var(--dw)'],['Wastewater',718745,'var(--ww)'],['Treated effluent',77668,'var(--te)']],9600000,v=>v>=1e6?(v/1e6).toFixed(1)+' M':(v/1e3).toFixed(0)+' k')}<p class="note">Drinking water e` | `${bars([['Drinking water',null,'var(--dw)'],['Wastewater',718745,'var(--ww)'],['Treated effluent',77668,'var(--te)']],718745,v=>v>=1e6?(v/1e6).toFixed(1)+' M':(v/1e3).toFixed(0)+' k',undefined,false)}<p class="note">Drin` |
| 5 | Operations KPIs: fleet total 3,123 → WW 2,825 + TE 298 + DW TBC; other tiles Demo data | `[['Tankers active','2,184','of 3,123 registered',''],['Trips today','28,610','+4.2% vs last Tuesday','ok'],['Delivered on time','94.2%','Target 92%','ok'],['Open alerts',`<em id="kOpen">${open}</em>`,`${high} high severi` | `[['Tankers active','2,184','registered: WW 2,825 + TE 298 + DW TBC',''],['Trips today','28,610','+4.2% vs last Tuesday','ok'],['Delivered on time','94.2%','Target 92%','ok'],['Open alerts',`<em id="kOpen">${open}</em>`,`` |
| 6 | IVMS devices KPI: 3,121 / 3,123 → 2,825 + 298 + TBC | `['3,121 / 3,123','Devices reporting']` | `['2,825 + 298 + TBC','IVMS devices: wastewater + treated effluent + drinking water (TBC)',false]` |
| 7 | IVMS interface row: 'Telematics on 3,123 tankers' → split by service | `'Telematics on 3,123 tankers'` | `'Telematics on WW 2,825 + TE 298 + DW TBC tankers'` |
| 8 | Live map overlay: 'Live · IVMS every 10 s' → simulated | `<div class="ov ov-tr live"><i></i>Live · IVMS every 10 s</div>` | `<div class="ov ov-tr live"><i></i>Simulated · IVMS interface spec pending</div>` |
| 9 | Uptime KPI: '99.97% / target 99.5%' → formula and target per contract — TBC | `['99.97%','Uptime this month (target 99.5%)']` | `['TBC','Uptime = (Total − Lost) / 720 h · target per contract — TBC',false]` |
| 10 | Interfaces table: status 'Healthy/Slow' + time → 'Simulated — interface spec pending' + Demo data | `<td>${stt(r[3]==='ok'?'Healthy':'Slow',r[3])}<br><small>${r[4]}</small></td><td class="num">${r[5]}</td>` | `<td>${SIM}<br><small>Demo data</small></td><td class="num">${r[5]} <small>Demo data</small></td>` |
| 11 | Interface 'Test' button: fake response time → says it is simulated | `toast(`${r[0]} responded in ${RI(90,420)} ms`)` | `toast(`${r[0]}: simulated — interface spec pending, no real connection`)` |
| 12 | Pricing settings: Base fee — drinking water → Assumption tag | `<td>Base fee — drinking water (OMR)</td>` | `<td>Base fee — drinking water (OMR) ${ASM}</td>` |
| 13 | Pricing settings: Base fee — wastewater → Assumption tag | `<td>Base fee — wastewater (OMR)</td>` | `<td>Base fee — wastewater (OMR) ${ASM}</td>` |
| 14 | Pricing settings: Base fee — treated effluent → Assumption tag | `<td>Base fee — treated effluent (OMR)</td>` | `<td>Base fee — treated effluent (OMR) ${ASM}</td>` |
| 15 | Pricing settings: Peak multiplier 1.2 → Assumption tag | `<td>Evening peak multiplier (6–8 pm)</td>` | `<td>Evening peak multiplier (6–8 pm) ${ASM}</td>` |
| 16 | Pricing settings: Priority multiplier 1.5 → Assumption tag | `<td>Priority / emergency multiplier</td>` | `<td>Priority / emergency multiplier ${ASM}</td>` |
| 17 | Pricing settings: Monthly plan discount 10% → Assumption tag | `<td>Monthly plan discount on fee</td>` | `<td>Monthly plan discount on fee ${ASM}</td>` |
| 18 | Pricing settings: Yearly plan discount 15% → Assumption tag | `<td>Yearly plan discount on fee</td>` | `<td>Yearly plan discount on fee ${ASM}</td>` |
| 19 | Pricing settings: Driver share 85% → Assumption tag | `<td>Driver share of fee</td>` | `<td>Driver share of fee ${ASM}</td>` |
| 20 | Pricing settings: VAT → Pending NWS clarification (Q07) | `<td>VAT</td>` | `<td>VAT ${PEND('Q07')}</td>` |
| 21 | Water tariff: drinking water above 650 gal → Pending NWS clarification (Q05) | `<td>${tag('DW')} above 650 gal</td>` | `<td>${tag('DW')} above 650 gal<br>${PEND('Q05')}</td>` |
| 22 | Loyalty: points per OMR → Assumption tag | `<td>Points earned per 1 OMR spent</td>` | `<td>Points earned per 1 OMR spent ${ASM}</td>` |
| 23 | Loyalty: points per 1.000 OMR credit → Assumption tag | `<td>Points for 1.000 OMR wallet credit</td>` | `<td>Points for 1.000 OMR wallet credit ${ASM}</td>` |
| 24 | Customer cancel sheet: cancellation fee → Assumption tag | `<p style="font-size:14px">${fee?t('cancelFee',{fee:omr(fee)}):t('cancelFree')}</p>` | `<p style="font-size:14px">${fee?t('cancelFee',{fee:omr(fee)})+' '+ASM:t('cancelFree')}</p>` |
| 25 | Penalty framework: customer cancellation fee row → Assumption tag | `${S.penalties.map(p=>`<tr><td>${p.trig}</td>` | `${S.penalties.map(p=>`<tr><td>${p.trig}${p.id==='p6'?' '+ASM:''}</td>` |
