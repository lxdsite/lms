/* ============================================================================
   Moodle Time-on-Course Reference Dashboard — client logic.
   Ingests an uploaded Moodle Logs JSON (via ingest.js) and estimates how much
   TIME each student spent on the course and on each activity, by sessionizing
   their click timestamps (a gap > the session timeout ends a session). For
   reference only — the teacher grades manually in Moodle.
   ========================================================================== */
(function () {
"use strict";

/* ---- module state (set when a course is loaded) ------------------------- */
let DATA, M, N, CATS, ENG, AUTOSAVE, F, CONTENT_CAT;
let studentIdx, isStudent, actType, dataMin, dataMax, lastDayAll;
let range, MODEL = null;
let rawText = null, fileName = "", CKEY = "";
let timeView = "student";  // "student" | "activity"

const ACTIVITY_TYPES = new Set(["Quiz","Forum","Book","Assignment","Page","Glossary","Checklist","Questionnaire","Folder","File"]);
const CONFIG = { inactiveDays: 14, ignoreEngagedPct: 0.25 };
const GAP_OPTIONS = [15,30,60,120];
let settings = { timeoutMin: 60 };
let roleOverrides = {};

/* ---- helpers ------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const fmt = n => (n==null?"–":Number(n).toLocaleString());
const pct = x => Math.round(x*100)+"%";
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const WD = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const catLabel = {content:"Content views",quiz:"Quiz activity",quiz_autosave:"Quiz autosave",
  assignment:"Assignment work",forum:"Forum participation",questionnaire:"Questionnaires",
  checklist:"Checklists",grade_check:"Grade checks",other:"Other"};
function dayLabel(d){ const dt=new Date(DATA.days[d].d+"T00:00:00");
  return dt.toLocaleDateString(undefined,{day:"numeric",month:"short"}); }
function fmtDur(sec){ if(!sec||sec<1) return "0"; if(sec<60) return "<1m";
  const m=Math.round(sec/60); if(m<60) return m+"m"; const h=Math.floor(m/60), mm=m%60; return h+"h "+(mm<10?"0":"")+mm+"m"; }

/* ---- (re)bind a freshly ingested DATA ----------------------------------- */
function loadData(d){
  DATA=d;
  M=DATA.ev.d.length; N=DATA.days.length; CATS=DATA.categories;
  ENG=new Set(DATA.engagementCats); AUTOSAVE=DATA.autosaveCat; F=DATA.flags;
  CONTENT_CAT=CATS.indexOf("content");
  studentIdx=DATA.users.map((u,i)=>({u,i})).filter(o=>o.u.role==="student").map(o=>o.i);
  isStudent=DATA.users.map(u=>u.role==="student");
  actType=DATA.activities.map(a=>a.type);
  dataMin=0; dataMax=N-1;
  if(M>0){ dataMin=Infinity; dataMax=-Infinity;
    for(let i=0;i<M;i++){ const x=DATA.ev.d[i]; if(x<dataMin)dataMin=x; if(x>dataMax)dataMax=x; } }
  lastDayAll=dataMax; range={s:dataMin,e:dataMax};
}
function applyPreset(v){
  if(v==="all") range={s:dataMin,e:dataMax};
  else { const d=parseInt(v,10); range={s:Math.max(dataMin,dataMax-d+1),e:dataMax}; }
}

/* ============================================================================
   MODEL — engagement metrics + sessionized time-on-task for the active window.
   ========================================================================== */
function computeModel(){
  const {s,e}=range;
  const TIMEOUT=(settings.timeoutMin||60)*60;   // seconds
  const per=new Map();
  for(const ui of studentIdx) per.set(ui, blankStudent(ui));
  const daily=Array.from({length:N},(_,d)=>({d,count:0,active:new Set()}));
  const heat=Array.from({length:7},()=>new Array(24).fill(0));
  const catTotals=new Array(CATS.length).fill(0);
  const act=new Map();
  const mid=Math.floor((s+e)/2);

  const ev=DATA.ev;
  for(let i=0;i<M;i++){
    const d=ev.d[i]; if(d<s||d>e) continue;
    const ui=ev.u[i]; if(!isStudent[ui]) continue;
    const ci=ev.c[i], ai=ev.a[i], hi=ev.h[i];
    const p=per.get(ui); if(!p) continue;
    const eng=ENG.has(ci);
    p.activeSet.add(d);
    if(p.lastDay<d) p.lastDay=d;
    if(p.firstDay<0||d<p.firstDay) p.firstDay=d;
    p.evt.push({t:ev.t[i], ai});           // for time sessionization
    p.actSet.add(ai);
    if(eng){ p.total++; p.byCat[ci]=(p.byCat[ci]||0)+1; catTotals[ci]++; daily[d].count++; daily[d].active.add(ui);
      if(d<=mid) p.firstHalf++; else p.secondHalf++; }
    heat[DATA.days[d].wd][hi]++;
    let a=act.get(ai);
    if(!a){ a={students:new Set(),views:0,type:actType[ai],name:DATA.activities[ai].name,comp:DATA.activities[ai].comp,idx:ai}; act.set(ai,a); }
    a.students.add(ui); a.views++;
    const t=actType[ai];
    if(t==="Assignment"){ if(ev.sub[i]===F.SUB_VIEW)p.aView.add(ai); if(ev.sub[i]===F.SUB_CREATE)p.aCreate.add(ai); if(ev.sub[i]===F.SUB_DONE)p.aDone.add(ai); }
    else if(t==="Quiz"){ if(ev.qz[i]>=F.QZ_START)p.qStart.add(ai); if(ev.qz[i]===F.QZ_SUBMIT)p.qSubmit.add(ai); }
    else if(t==="Forum"){ p.fTouch=true; if(ev.fp[i]===F.FORUM_POST)p.fPosts++; }
    if(ci===CONTENT_CAT){ p.content++; }
  }

  const students=[];
  for(const p of per.values()){
    p.activeDays=p.activeSet.size;
    p.activeWeeks=new Set([...p.activeSet].map(d=>Math.floor((d-s)/7))).size;
    p.recency=p.lastDay>=0?(e-p.lastDay):(e-s+1);
    p.quizStarted=p.qStart.size; p.quizSubmitted=p.qSubmit.size;
    const sub=new Set(p.aCreate); for(const x of p.aDone) sub.add(x);
    p.assignSubmitted=sub.size;
    p.activitiesOpened=p.actSet.size;
    // ---- sessionize: estimate time on task + per-activity / per-type time ----
    p.evt.sort((a,b)=>a.t-b.t);
    p.timeTotal=0; p.sessions=0; p.timeByAct=new Map(); p.timeByType=new Map();
    for(let i=0;i<p.evt.length;i++){
      const gap = i>0 ? (p.evt[i].t - p.evt[i-1].t) : Infinity;
      if(gap>TIMEOUT){ p.sessions++; }
      else { p.timeTotal+=gap; const ai=p.evt[i-1].ai, tp=actType[ai];
        p.timeByAct.set(ai,(p.timeByAct.get(ai)||0)+gap);
        p.timeByType.set(tp,(p.timeByType.get(tp)||0)+gap); }
    }
    students.push(p);
  }

  // cohort baselines for at-risk
  const totals=students.map(p=>p.total).sort((a,b)=>a-b);
  const adays=students.map(p=>p.activeDays).sort((a,b)=>a-b);
  const firstH=students.map(p=>p.firstHalf).sort((a,b)=>a-b);
  const secondH=students.map(p=>p.secondHalf).sort((a,b)=>a-b);
  const q25=quantile(totals,0.25), medActive=quantile(adays,0.5);
  const medFirst=quantile(firstH,0.5), q25Second=quantile(secondH,0.25);
  const totalAssignments=DATA.activities.filter(a=>a.type==="Assignment").length;
  for(const p of students) scoreRisk(p,{q25,medActive,medFirst,q25Second,totalAssignments});

  // class-level time aggregation
  const actTime=new Map(), actStu=new Map(), typeTime=new Map();
  let classTime=0;
  for(const p of students){ classTime+=p.timeTotal;
    for(const [ai,sec] of p.timeByAct){ actTime.set(ai,(actTime.get(ai)||0)+sec); if(sec>0) actStu.set(ai,(actStu.get(ai)||0)+1); }
    for(const [tp,sec] of p.timeByType){ typeTime.set(tp,(typeTime.get(tp)||0)+sec); } }
  const activityTime=[...actTime.entries()].map(([ai,sec])=>({idx:ai,type:actType[ai],name:DATA.activities[ai].name,
    sec,students:actStu.get(ai)||0,avg:(actStu.get(ai)||0)?sec/(actStu.get(ai)):0})).filter(a=>a.sec>0).sort((x,y)=>y.sec-x.sec);
  const typeTimeArr=[...typeTime.entries()].map(([type,sec])=>({type,sec})).filter(t=>t.sec>0).sort((x,y)=>y.sec-x.sec);
  const timesSorted=students.map(p=>p.timeTotal).sort((a,b)=>a-b);

  // series / activity reach / assessment / forum (context tabs)
  const series=[]; for(let d=s;d<=e;d++) series.push({d,label:dayLabel(d),count:daily[d].count,active:daily[d].active.size});
  const sc=studentIdx.length||1;
  const activities=[...act.values()].map(a=>({...a,students:a.students.size,pct:a.students.size/sc})).sort((x,y)=>y.views-x.views);
  const assignments=DATA.activities.map((a,idx)=>({a,idx})).filter(o=>o.a.type==="Assignment").map(o=>{
    let v=0,c=0,d=0; for(const p of students){ if(p.aView.has(o.idx))v++; if(p.aCreate.has(o.idx))c++; if(p.aDone.has(o.idx))d++; }
    return {name:o.a.name,viewed:v,created:c,submitted:d}; }).sort((x,y)=>y.submitted-x.submitted);
  const quizzes=DATA.activities.map((a,idx)=>({a,idx})).filter(o=>o.a.type==="Quiz").map(o=>{
    let st=0,su=0; for(const p of students){ if(p.qStart.has(o.idx))st++; if(p.qSubmit.has(o.idx))su++; }
    return {name:o.a.name,started:st,submitted:su}; }).sort((x,y)=>y.started-x.started);
  const posters=students.filter(p=>p.fPosts>0).length, touched=students.filter(p=>p.fTouch).length;
  const forum={posters,lurkers:touched-posters,none:students.length-touched,totalPosts:students.reduce((a,p)=>a+p.fPosts,0)};
  const engEvents=catTotals.reduce((a,n,i)=>ENG.has(i)?a+n:a,0);

  return {students,series,heat,catTotals,activities,assignments,quizzes,forum,
    totalAssignments, activityTime, typeTime:typeTimeArr,
    time:{classTime, median:quantile(timesSorted,0.5), avg:students.length?classTime/students.length:0,
      max:students.length?Math.max.apply(null,students.map(p=>p.timeTotal)):0},
    totals:{engEvents,cohort:studentIdx.length,
      active7:students.filter(p=>p.lastDay>=0&&(e-p.lastDay)<7).length,
      active14:students.filter(p=>p.lastDay>=0&&(e-p.lastDay)<14).length},
    range:{s,e,days:e-s+1}};
}

function blankStudent(ui){ const u=DATA.users[ui];
  return {uIdx:ui,id:u.id,name:u.name,total:0,byCat:{},content:0,
    activeSet:new Set(),activeDays:0,activeWeeks:0,lastDay:-1,firstDay:-1,recency:0,
    firstHalf:0,secondHalf:0,fPosts:0,fTouch:false,
    qStart:new Set(),qSubmit:new Set(),aView:new Set(),aCreate:new Set(),aDone:new Set(),actSet:new Set(),
    evt:[],timeTotal:0,sessions:0,timeByAct:null,timeByType:null,
    quizStarted:0,quizSubmitted:0,assignSubmitted:0,activitiesOpened:0,risk:null}; }

function quantile(sorted,q){ if(!sorted.length) return 0; const pos=(sorted.length-1)*q,b=Math.floor(pos),r=pos-b;
  return sorted[b+1]!==undefined? sorted[b]+r*(sorted[b+1]-sorted[b]) : sorted[b]; }

function scoreRisk(p,base){
  const reasons=[];
  if(p.total===0){ reasons.push("No activity in the selected period"); }
  else {
    if(p.recency>CONFIG.inactiveDays) reasons.push(`No access in ${p.recency} days`);
    if(p.total<=base.q25) reasons.push("Low overall activity (bottom 25% of class)");
    if(p.activeDays<Math.max(2,base.medActive*0.4)) reasons.push(`Few active days (${p.activeDays})`);
    if(base.medFirst>0 && p.firstHalf>=base.medFirst && p.secondHalf<=base.q25Second) reasons.push("Was active early, now gone quiet");
  }
  if(base.totalAssignments>0 && p.assignSubmitted<base.totalAssignments){ const miss=base.totalAssignments-p.assignSubmitted;
    reasons.push(`No submission for ${miss} of ${base.totalAssignments} assignment${miss>1?"s":""}`); }
  let level="none";
  const noRecent=p.total===0||p.recency>CONFIG.inactiveDays;
  const missing=base.totalAssignments>0 && p.assignSubmitted<base.totalAssignments;
  if(p.total===0||reasons.length>=3||(noRecent&&missing)) level="high";
  else if(reasons.length===2||noRecent) level="med";
  else if(reasons.length===1) level="low";
  p.risk={level,reasons};
}

/* ============================================================================
   CHART HELPERS
   ========================================================================== */
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 12;
Chart.defaults.color = "#66708a";
Chart.defaults.animation = false;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 12;
Chart.defaults.maintainAspectRatio = false;
const ACCENT="#4f46e5", GOOD="#1f9d6b", WARN="#c47d12", RISK="#d23f3f";
const PALETTE=[ACCENT,"#0ea5a3",WARN,"#7c5cff",GOOD,"#e0658a","#3b82f6","#94a3b8","#d23f3f","#a16207"];
const charts={};
function mkChart(id,cfg){ const el=$(id); if(!el) return; if(charts[id]) charts[id].destroy(); charts[id]=new Chart(el.getContext("2d"),cfg); }
function destroyCharts(){ for(const k in charts){ charts[k].destroy(); delete charts[k]; } }
const gridLine={grid:{color:"#eef1f6"},border:{display:false}};

/* ============================================================================
   TIME (primary tab) — by student / by activity
   ========================================================================== */
function renderTime(m){
  $("tab-time").innerHTML = `
    <div class="print-only print-head"><h1>${esc(DATA.meta.course)} — Time on Course</h1>
      <div class="muted">${esc(DATA.meta.firstDate)} to ${esc(DATA.meta.lastDate)} · generated ${esc(DATA.meta.generated)} · ${settings.timeoutMin}-min session gap</div></div>
    <div class="section-head"><h2>Time on course</h2><p>Estimated time each student spent, and where. ${rangeText(m)}.
      <span class="muted">Time is estimated from click timestamps (a session ends after a ${settings.timeoutMin}-min gap) — a reference, not exact minutes.</span></p></div>
    <div class="grid cards" style="margin-bottom:16px">
      ${kpi("Students", fmt(m.totals.cohort), "in this course")}
      ${kpi("Total time", fmtDur(m.time.classTime), "class, estimated")}
      ${kpi("Median / student", fmtDur(m.time.median), "typical student")}
      ${kpi("Avg / student", fmtDur(m.time.avg), "mean")}
      ${kpi("Active last 14d", fmt(m.totals.active14), pct(m.totals.active14/(m.totals.cohort||1))+" of class")}
    </div>
    <div class="controls no-print" style="margin-bottom:14px">
      <div class="seg">
        <button data-tv="student"${timeView==="student"?' class="on"':''}>By student</button>
        <button data-tv="activity"${timeView==="activity"?' class="on"':''}>By activity</button>
      </div>
      <label class="control">Session gap
        <select id="gap-select">${GAP_OPTIONS.map(g=>`<option value="${g}"${settings.timeoutMin===g?" selected":""}>${g} min</option>`).join("")}</select></label>
      <span class="spacer"></span>
      <button class="btn primary" id="time-csv">⬇ Download time (CSV)</button>
    </div>
    <div id="time-body"></div>`;
  $("tab-time").querySelectorAll(".seg button").forEach(b=>b.addEventListener("click",()=>{ timeView=b.dataset.tv; renderTime(m); setTab("time"); }));
  $("gap-select").addEventListener("change",e=>{ settings.timeoutMin=+e.target.value; persist(); recompute(); renderAll(); setTab("time"); });
  $("time-csv").addEventListener("click",()=>exportTime(m));
  if(timeView==="activity") renderTimeByActivity(m); else renderTimeByStudent(m);
}

function renderTimeByStudent(m){
  const rows=m.students.slice().sort((a,b)=>b.timeTotal-a.timeTotal);
  const maxT=Math.max(1,...rows.map(p=>p.timeTotal));
  $("time-body").innerHTML=`
    <div class="table-tools no-print"><input type="search" id="t-search" placeholder="Search student…"><span class="muted" id="t-count"></span></div>
    <div class="table-scroll" id="time-table"></div>`;
  const draw=q=>{ const rs=q?rows.filter(p=>p.name.toLowerCase().includes(q.toLowerCase())):rows;
    sortableTable("time-table", rs, [
      {k:"name",t:"Student",fmt:v=>esc(v)},
      {k:"timeTotal",t:"Time on course",num:true,fmt:v=>barCell(v/maxT,"good",fmtDur(v))},
      {k:"sessions",t:"Sessions",num:true},
      {k:"activeDays",t:"Active days",num:true},
      {k:"activitiesOpened",t:"Activities",num:true},
      {k:"total",t:"Clicks",num:true},
      {k:"recency",t:"Last seen",num:true,fmt:(v,p)=>p.lastDay<0?'<span class="muted">never</span>':(v===0?"today":v+"d ago")},
    ], "timeTotal", p=>openStudent(p,m));
    $("t-count").textContent=`${rs.length} students`; };
  draw(""); $("t-search").addEventListener("input",e=>draw(e.target.value));
}

function renderTimeByActivity(m){
  const top=m.typeTime.slice(0,10);
  $("time-body").innerHTML=`
    <div class="grid wide">
      <div class="card"><h3>Time by activity type</h3><div class="chart-wrap"><canvas id="c-type-time"></canvas></div></div>
      <div class="card"><h3>Where the time goes</h3>
        <p class="muted" style="font-size:12.5px;line-height:1.6">Total estimated student time per activity. "Avg / student" divides by the students who spent any time there.
        Time after a student's last click in a session isn't captured, so quick-glance pages can read low.</p></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>All activities (${m.activityTime.length})</h3><div class="table-scroll" id="acttime-table"></div></div>`;
  mkChart("c-type-time",{type:"bar",data:{labels:top.map(t=>t.type),datasets:[{label:"Total time (min)",data:top.map(t=>Math.round(t.sec/60)),backgroundColor:ACCENT,borderRadius:4}]},
    options:{indexAxis:"y",plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtDur(top[c.dataIndex].sec)+" total"}}},scales:{x:{...gridLine,beginAtZero:true,title:{display:true,text:"minutes"}},y:gridLine}}});
  sortableTable("acttime-table", m.activityTime, [
    {k:"type",t:"Type",fmt:v=>`<span class="pill">${esc(v)}</span>`},
    {k:"name",t:"Activity",fmt:v=>esc(v)},
    {k:"sec",t:"Total time",num:true,fmt:v=>fmtDur(v)},
    {k:"avg",t:"Avg / student",num:true,fmt:v=>fmtDur(v)},
    {k:"students",t:"Students",num:true},
  ], "sec");
}

function exportTime(m){
  const types=m.typeTime.map(t=>t.type);
  const head=["Student","UserID","Total time (min)","Sessions","Active days","Last seen (days)",...types.map(t=>t+" (min)")];
  const lines=[head.join(",")];
  m.students.slice().sort((a,b)=>b.timeTotal-a.timeTotal).forEach(p=>{
    const row=[p.name,p.id,Math.round(p.timeTotal/60),p.sessions,p.activeDays,p.lastDay<0?"never":p.recency,
      ...types.map(t=>Math.round((p.timeByType.get(t)||0)/60))];
    lines.push(row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(","));
  });
  download(lines.join("\n"), `${DATA.meta.courseCode||"course"}_time_${(DATA.meta.lastDate||"").slice(0,10)}.csv`);
}

/* ============================================================================
   SECONDARY TABS (context)
   ========================================================================== */
function renderEngagement(m){
  const weeks=new Map();
  for(const pt of m.series){ const wk=Math.floor((pt.d-m.range.s)/7); const w=weeks.get(wk)||{events:0,label:pt.label}; w.events+=pt.count; weeks.set(wk,w); }
  const wkActive=new Map();
  for(const p of m.students){ if(p.lastDay<0)continue; for(const d of p.activeSet){ if(d<m.range.s)continue; const wk=Math.floor((d-m.range.s)/7); (wkActive.get(wk)||wkActive.set(wk,new Set()).get(wk)).add(p.uIdx);} }
  const wkKeys=[...weeks.keys()].sort((a,b)=>a-b);
  $("tab-engagement").innerHTML=`
    <div class="section-head"><h2>Engagement over time</h2><p>When the class is active, and whether engagement is holding up or dropping off.</p></div>
    <div class="grid two">
      <div class="card"><h3>Daily engagement events</h3><div class="chart-wrap"><canvas id="c-eng-daily"></canvas></div></div>
      <div class="card"><h3>Active students per week</h3><div class="chart-wrap"><canvas id="c-eng-week"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>When students study (day × hour)</h3><div id="heatmap"></div>
      <div class="heat-legend">Less <span class="swatch" style="opacity:.15"></span><span class="swatch" style="opacity:.4"></span><span class="swatch" style="opacity:.7"></span><span class="swatch"></span> More</div></div>
    <div class="card" style="margin-top:16px"><h3>Cumulative engagement</h3><div class="chart-wrap short"><canvas id="c-eng-cum"></canvas></div></div>`;
  lineDaily("c-eng-daily",m);
  mkChart("c-eng-week",{type:"bar",data:{labels:wkKeys.map(k=>"Wk "+(k+1)),datasets:[{label:"Active students",data:wkKeys.map(k=>(wkActive.get(k)||new Set()).size),backgroundColor:ACCENT,borderRadius:4}]},
    options:{plugins:{legend:{display:false}},scales:{x:gridLine,y:{...gridLine,beginAtZero:true,ticks:{precision:0}}}}});
  let run=0; const cum=m.series.map(p=>(run+=p.count));
  mkChart("c-eng-cum",{type:"line",data:{labels:m.series.map(p=>p.label),datasets:[{data:cum,borderColor:GOOD,backgroundColor:"rgba(31,157,107,.10)",fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
    options:{plugins:{legend:{display:false}},scales:{x:{...gridLine,ticks:{maxTicksLimit:10}},y:{...gridLine,beginAtZero:true}}}});
  renderHeatmap(m.heat);
}
function renderHeatmap(heat){
  let max=1; for(const r of heat) for(const v of r) max=Math.max(max,v);
  let html='<div class="heat"><div></div>';
  for(let h=0;h<24;h++) html+=`<div class="hcol">${h%3===0?h:""}</div>`;
  for(let wd=0;wd<7;wd++){ html+=`<div class="hlabel">${WD[wd]}</div>`;
    for(let h=0;h<24;h++){ const v=heat[wd][h]; const a=v?(0.12+0.88*v/max):0.04;
      html+=`<div class="cell" style="opacity:${a.toFixed(3)}" title="${WD[wd]} ${h}:00 — ${v} events"></div>`; } }
  $("heatmap").innerHTML=html+"</div>";
}
function renderContent(m){
  const real=m.activities.filter(a=>ACTIVITY_TYPES.has(a.type));
  const top=real.slice(0,12);
  const ignored=real.filter(a=>a.pct<CONFIG.ignoreEngagedPct).sort((a,b)=>a.pct-b.pct).slice(0,12);
  $("tab-content").innerHTML=`
    <div class="section-head"><h2>Content effectiveness</h2><p>Which activities students actually open — and which are skipped. % engaged = share of the ${m.totals.cohort} students who opened it.</p></div>
    <div class="grid wide">
      <div class="card"><h3>Most-used activities</h3><div class="chart-wrap tall"><canvas id="c-content-top"></canvas></div></div>
      <div class="card"><h3>Under-used activities (&lt;${pct(CONFIG.ignoreEngagedPct)} of class)</h3>
        ${ignored.length?`<div class="table-scroll"><table><thead><tr><th>Activity</th><th class="num">% engaged</th></tr></thead><tbody>
        ${ignored.map(a=>`<tr><td><span class="pill">${esc(a.type)}</span> ${esc(a.name)}</td><td class="num">${pct(a.pct)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">No under-used activities — nice.</div>`}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3>All activities (${real.length})</h3><div class="table-scroll" id="content-table"></div></div>`;
  mkChart("c-content-top",{type:"bar",data:{labels:top.map(a=>truncate(a.name,28)),datasets:[{label:"Students reached",data:top.map(a=>a.students),backgroundColor:ACCENT,borderRadius:4}]},
    options:{indexAxis:"y",plugins:{legend:{display:false},tooltip:{callbacks:{afterLabel:c=>fmt(top[c.dataIndex].views)+" total views"}}},scales:{x:{...gridLine,beginAtZero:true,ticks:{precision:0}},y:gridLine}}});
  sortableTable("content-table",real,[
    {k:"type",t:"Type",fmt:v=>`<span class="pill">${esc(v)}</span>`},
    {k:"name",t:"Activity",fmt:v=>esc(v)},
    {k:"students",t:"Students",num:true},
    {k:"views",t:"Total views",num:true},
    {k:"pct",t:"% engaged",num:true,fmt:v=>barCell(v,v<CONFIG.ignoreEngagedPct?"risk":v<.6?"warn":"good",pct(v))}],"views");
}
function renderAssessment(m){
  $("tab-assessment").innerHTML=`
    <div class="section-head"><h2>Assessment &amp; participation</h2><p>Submission progress per assignment, quiz participation, and who is contributing to forums.</p></div>
    <div class="grid two">
      <div class="card"><h3>Assignment submission funnel</h3><div class="chart-wrap tall"><canvas id="c-asg"></canvas></div>
        <p class="muted" style="font-size:11.5px;margin-top:8px">Distinct students who viewed, drafted, or submitted each assignment (of ${m.totals.cohort}).</p></div>
      <div class="card"><h3>Quiz participation</h3><div class="chart-wrap tall"><canvas id="c-quiz"></canvas></div></div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><h3>Forum participation</h3><div class="chart-wrap"><canvas id="c-forum"></canvas></div></div>
      <div class="card"><h3>Forum summary</h3><div class="mini-cards">
        <div class="mini"><div class="num">${fmt(m.forum.totalPosts)}</div><div class="lbl">Posts &amp; discussions</div></div>
        <div class="mini"><div class="num">${fmt(m.forum.posters)}</div><div class="lbl">Students posting</div></div>
        <div class="mini"><div class="num">${fmt(m.forum.lurkers)}</div><div class="lbl">Read only (lurkers)</div></div></div>
        <p class="muted" style="font-size:12px">${fmt(m.forum.none)} students have not opened any forum in this period.</p></div>
    </div>`;
  const asg=m.assignments;
  mkChart("c-asg",{type:"bar",data:{labels:asg.map(a=>truncate(a.name,22)),datasets:[
    {label:"Viewed",data:asg.map(a=>a.viewed),backgroundColor:"#c7cbe9",borderRadius:3},
    {label:"Drafted",data:asg.map(a=>a.created),backgroundColor:"#8b8fe0",borderRadius:3},
    {label:"Submitted",data:asg.map(a=>a.submitted),backgroundColor:ACCENT,borderRadius:3}]},
    options:{indexAxis:"y",scales:{x:{...gridLine,beginAtZero:true,ticks:{precision:0}},y:gridLine}}});
  const qz=m.quizzes;
  mkChart("c-quiz",{type:"bar",data:{labels:qz.map(a=>truncate(a.name,22)),datasets:[
    {label:"Started",data:qz.map(a=>a.started),backgroundColor:"#9bd6c4",borderRadius:3},
    {label:"Submitted",data:qz.map(a=>a.submitted),backgroundColor:GOOD,borderRadius:3}]},
    options:{indexAxis:"y",scales:{x:{...gridLine,beginAtZero:true,ticks:{precision:0}},y:gridLine}}});
  mkChart("c-forum",{type:"doughnut",data:{labels:["Posting","Read only","No forum activity"],datasets:[{data:[m.forum.posters,m.forum.lurkers,m.forum.none],backgroundColor:[ACCENT,WARN,"#e4e8f0"],borderWidth:2,borderColor:"#fff"}]},
    options:{cutout:"62%",plugins:{legend:{position:"bottom"}}}});
}
function renderAtRisk(m){
  const flagged=m.students.filter(p=>p.risk.level!=="none").sort((a,b)=>rankRisk(b.risk.level)-rankRisk(a.risk.level)||a.recency-b.recency||a.total-b.total);
  const hi=flagged.filter(p=>p.risk.level==="high").length, md=flagged.filter(p=>p.risk.level==="med").length;
  $("tab-atrisk").innerHTML=`
    <div class="section-head"><h2>At-risk &amp; early warning</h2><p>Students who may need a nudge, ranked by severity. Signals: no access &gt; ${CONFIG.inactiveDays} days, bottom-quartile activity, missing submissions, few active days, or a strong start gone quiet.</p></div>
    <div class="grid cards" style="margin-bottom:16px">
      ${kpi("High risk",fmt(hi),"need attention now","risk")}
      ${kpi("Medium risk",fmt(md),"worth watching","warn")}
      ${kpi("Flagged total",fmt(flagged.length),"of "+m.totals.cohort+" students")}
      <div class="card"><h3>&nbsp;</h3><button class="btn no-print" id="csv-btn">⬇ Export CSV</button></div>
    </div>
    ${flagged.length?`<div class="table-scroll" id="risk-table"></div>`:`<div class="empty">No students flagged in this period.</div>`}`;
  if(flagged.length){
    sortableTable("risk-table",flagged,[
      {k:"name",t:"Student",fmt:v=>esc(v)},
      {k:"risk",t:"Risk",fmt:v=>riskBadge(v.level)},
      {k:"recency",t:"Last seen",num:true,fmt:(v,p)=>p.lastDay<0?'<span class="muted">never</span>':v+"d ago"},
      {k:"timeTotal",t:"Time",num:true,fmt:v=>fmtDur(v)},
      {k:"total",t:"Clicks",num:true},
      {k:"assignSubmitted",t:"Submitted",num:true,fmt:v=>`${v}/${m.totalAssignments}`},
      {k:"risk",t:"Why flagged",fmt:v=>`<span class="muted" style="font-size:12px">${v.reasons.map(esc).join(" · ")}</span>`}],
      null,p=>openStudent(p,m));
    $("csv-btn").addEventListener("click",()=>exportRisk(flagged,m));
  }
}

/* ============================================================================
   DRILL-DOWN DRAWER — time breakdown + timeline
   ========================================================================== */
function openStudent(p,m){
  const tl=studentTimeline(p.uIdx);
  const acts=[...p.timeByAct.entries()].map(([ai,sec])=>({type:actType[ai],name:DATA.activities[ai].name,sec})).filter(a=>a.sec>0).sort((a,b)=>b.sec-a.sec).slice(0,12);
  const types=[...p.timeByType.entries()].map(([t,sec])=>({t,sec})).filter(a=>a.sec>0).sort((a,b)=>b.sec-a.sec);
  $("drawer-title").innerHTML=`${esc(p.name)} ${riskBadge(p.risk.level)}`;
  $("drawer-body").innerHTML=`
    <div class="mini-cards">
      <div class="mini"><div class="num">${fmtDur(p.timeTotal)}</div><div class="lbl">Time on course</div></div>
      <div class="mini"><div class="num">${p.sessions}</div><div class="lbl">Sessions</div></div>
      <div class="mini"><div class="num">${p.lastDay<0?"–":(p.recency===0?"today":p.recency+"d")}</div><div class="lbl">Since last seen</div></div>
    </div>
    <div class="mini-cards">
      <div class="mini"><div class="num">${fmt(p.activeDays)}</div><div class="lbl">Active days</div></div>
      <div class="mini"><div class="num">${fmt(p.activitiesOpened)}</div><div class="lbl">Activities opened</div></div>
      <div class="mini"><div class="num">${fmt(p.total)}</div><div class="lbl">Clicks</div></div>
    </div>
    <div class="card" style="margin-bottom:14px"><h3>Time by activity type</h3>
      ${types.length?`<table class="break"><tbody>${types.map(t=>`<tr><td><span class="pill">${esc(t.t)}</span></td><td class="num">${fmtDur(t.sec)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No measurable time.</div>'}</div>
    <div class="card" style="margin-bottom:14px"><h3>Top activities by time</h3>
      ${acts.length?`<table class="break"><thead><tr><th>Activity</th><th class="num">Time</th></tr></thead><tbody>${acts.map(a=>`<tr><td><span class="pill">${esc(a.type)}</span> ${esc(a.name)}</td><td class="num">${fmtDur(a.sec)}</td></tr>`).join("")}</tbody></table>`:'<div class="empty">No measurable time.</div>'}
      <p class="muted" style="font-size:11.5px;margin-top:8px">Time after the last click in a session isn't captured, so totals are a reference.</p></div>
    ${p.risk.reasons.length?`<div class="card" style="margin-bottom:14px"><h3>Watch-outs</h3><ul class="reasons">${p.risk.reasons.map(r=>`<li>${esc(r)}</li>`).join("")}</ul></div>`:""}
    <div class="card" style="margin-bottom:14px"><h3>Activity timeline</h3><div class="chart-wrap short"><canvas id="c-drawer-tl"></canvas></div></div>
    <div class="card"><h3>What they did</h3><div class="chart-wrap short"><canvas id="c-drawer-mix"></canvas></div></div>`;
  openDrawer();
  mkChart("c-drawer-tl",{type:"bar",data:{labels:tl.labels,datasets:[{data:tl.counts,backgroundColor:ACCENT,borderRadius:2}]},
    options:{plugins:{legend:{display:false}},scales:{x:{...gridLine,ticks:{maxTicksLimit:10}},y:{...gridLine,beginAtZero:true,ticks:{precision:0}}}}});
  const labels=[],vals=[],cols=[];
  Object.keys(p.byCat).forEach(ci=>{ labels.push(catLabel[CATS[ci]]||CATS[ci]); vals.push(p.byCat[ci]); cols.push(PALETTE[ci%PALETTE.length]); });
  mkChart("c-drawer-mix",{type:"doughnut",data:{labels,datasets:[{data:vals,backgroundColor:cols,borderWidth:2,borderColor:"#f4f6fb"}]},
    options:{cutout:"60%",plugins:{legend:{position:"right",labels:{boxWidth:10}}}}});
}
function studentTimeline(ui){ const {s,e}=range; const counts=new Array(e-s+1).fill(0); const ev=DATA.ev;
  for(let i=0;i<M;i++){ if(ev.u[i]!==ui)continue; const d=ev.d[i]; if(d<s||d>e)continue; if(ENG.has(ev.c[i]))counts[d-s]++; }
  const labels=[]; for(let d=s;d<=e;d++) labels.push(dayLabel(d)); return {labels,counts}; }
function openDrawer(){ $("drawer").classList.add("open"); $("drawer-backdrop").classList.add("open"); }
function closeDrawer(){ $("drawer").classList.remove("open"); $("drawer-backdrop").classList.remove("open");
  ["c-drawer-tl","c-drawer-mix"].forEach(k=>{ if(charts[k]){charts[k].destroy();delete charts[k];} }); }

/* ============================================================================
   SHARED UI
   ========================================================================== */
function kpi(title,num,sub,tone){ return `<div class="card kpi"><h3>${title}</h3><div class="num ${tone||""}">${num}</div><div class="sub">${sub||""}</div></div>`; }
function riskBadge(l){ return `<span class="badge ${l}">${{high:"High",med:"Medium",low:"Low",none:"OK"}[l]}</span>`; }
function rankRisk(l){ return {high:3,med:2,low:1,none:0}[l]; }
function truncate(s,n){ return s.length>n?s.slice(0,n-1)+"…":s; }
function barCell(frac,tone,label){ frac=Math.max(0,Math.min(1,frac));
  return `<div class="bar-cell"><span style="min-width:54px">${label}</span><span class="bar-track"><span class="bar-fill ${tone||""}" style="width:${(frac*100).toFixed(1)}%"></span></span></div>`; }
function lineDaily(id,m){ mkChart(id,{type:"line",data:{labels:m.series.map(p=>p.label),datasets:[
    {label:"Engagement events",data:m.series.map(p=>p.count),borderColor:ACCENT,backgroundColor:"rgba(79,70,229,.10)",fill:true,tension:.3,pointRadius:0,borderWidth:2},
    {label:"Active students",data:m.series.map(p=>p.active),borderColor:GOOD,backgroundColor:"transparent",tension:.3,pointRadius:0,borderWidth:1.5,yAxisID:"y1"}]},
  options:{interaction:{mode:"index",intersect:false},plugins:{legend:{position:"bottom"}},
    scales:{x:{...gridLine,ticks:{maxTicksLimit:12}},y:{...gridLine,beginAtZero:true,title:{display:true,text:"events"}},
      y1:{position:"right",beginAtZero:true,grid:{display:false},border:{display:false},title:{display:true,text:"students"}}}}}); }
function download(text,name){ const blob=new Blob([text],{type:"text/csv"}); const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href); }
function exportRisk(rows,m){
  const head=["Student","Risk","Last seen (days)","Time (min)","Clicks","Active days","Assignments submitted","Total assignments","Reasons"];
  const lines=[head.join(",")];
  rows.forEach(p=>{ lines.push([p.name,p.risk.level,p.lastDay<0?"never":p.recency,Math.round(p.timeTotal/60),p.total,p.activeDays,p.assignSubmitted,m.totalAssignments,p.risk.reasons.join("; ")].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")); });
  download(lines.join("\n"),`${DATA.meta.courseCode||"course"}_at-risk_${(DATA.meta.lastDate||"").slice(0,10)}.csv`);
}
function sortableTable(containerId,rows,cols,sortKey,onRow){
  let dir=-1, key=sortKey||cols[0].k; const cont=$(containerId); if(!cont) return;
  function val(p,k){ const v=p[k]; return k==="risk"?rankRisk(v.level):v; }
  function render(){
    const sorted=key?rows.slice().sort((a,b)=>{ const x=val(a,key),y=val(b,key);
      if(typeof x==="string") return dir*x.localeCompare(y); return dir*((x>y)-(x<y)); }):rows;
    let h='<table><thead><tr>';
    cols.forEach(c=>{ const on=c.k===key; h+=`<th class="${c.num?"num":""} ${on?"sorted":""}" data-k="${c.k}">${c.t} <span class="arrow">${on?(dir<0?"▼":"▲"):"↕"}</span></th>`; });
    h+="</tr></thead><tbody>";
    sorted.forEach((p,ri)=>{ h+=`<tr class="${onRow?"clickable":""}" data-ri="${ri}">`;
      cols.forEach(c=>{ const cell=c.fmt?c.fmt(p[c.k],p):fmt(p[c.k]); h+=`<td class="${c.num?"num":""}">${cell}</td>`; }); h+="</tr>"; });
    cont.innerHTML=h+"</tbody></table>";
    cont.querySelectorAll("th").forEach(th=>th.addEventListener("click",()=>{ const k=th.dataset.k; if(k===key)dir=-dir; else{key=k;dir=-1;} render(); }));
    if(onRow) cont.querySelectorAll("tbody tr").forEach(tr=>tr.addEventListener("click",()=>onRow(sorted[+tr.dataset.ri])));
  }
  render();
}
function rangeText(m){ const a=DATA.days[m.range.s].d,b=DATA.days[m.range.e].d; return `${a} → ${b} · ${m.range.days} days`; }

/* ============================================================================
   APP SHELL
   ========================================================================== */
const TABS=["time","atrisk","engagement","content","assessment"];
let current="time";
function recompute(){ MODEL=computeModel(); }
function renderAll(){
  destroyCharts();
  TABS.forEach(t=>$("tab-"+t).classList.add("active"));
  renderTime(MODEL); renderAtRisk(MODEL); renderEngagement(MODEL); renderContent(MODEL); renderAssessment(MODEL);
  setTab(current);
}
function setTab(t){ current=t;
  TABS.forEach(x=>{ $("tab-"+x).classList.toggle("active",x===t); const b=document.querySelector(`[data-tab="${x}"]`); if(b)b.classList.toggle("active",x===t); });
  for(const k in charts) charts[k].resize();
  if(typeof history!=="undefined"&&history.replaceState) history.replaceState(null,"","#"+t);
  if(typeof window!=="undefined"&&window.scrollTo) window.scrollTo({top:0});
}

/* ---- roles modal -------------------------------------------------------- */
function renderRoles(){
  const rows=DATA.roleInfo.slice().sort((a,b)=>(a.role!=="student"?0:1)-(b.role!=="student"?0:1)||b.n-a.n);
  $("roles-body").innerHTML=`
    <p class="muted" style="font-size:12.5px">Staff are auto-detected from teaching/admin actions and excluded. Override any below; choices are saved for this course.</p>
    <div class="table-scroll"><table><thead><tr><th>User</th><th>Auto</th><th class="num">Signals</th><th class="num">Events</th><th>Treat as</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${esc(r.name)}${r.example?`<div class="muted" style="font-size:11px">${esc(r.example)}</div>`:""}</td>
      <td>${r.detected==="staff"?'<span class="badge role">staff</span>':'<span class="pill">student</span>'}</td>
      <td class="num">${r.signals}</td><td class="num">${fmt(r.n)}</td>
      <td><select class="role-sel" data-id="${esc(r.id)}"><option value="student"${r.role==="student"?" selected":""}>Student</option><option value="staff"${r.role==="staff"?" selected":""}>Staff</option></select></td></tr>`).join("")}
    </tbody></table></div>`;
  $("roles-body").querySelectorAll(".role-sel").forEach(sel=>sel.addEventListener("change",e=>setRole(e.target.dataset.id,e.target.value)));
}
function setRole(id,role){
  const info=DATA.roleInfo.find(r=>r.id===id)||{};
  if(role===info.detected) delete roleOverrides[id]; else roleOverrides[id]=role;
  persist();
  loadData(ingestLogs(rawText,fileName,roleOverrides)); recompute(); renderAll(); fillHeaderFooter(); renderRoles();
}
function openRoles(){ renderRoles(); $("roles-backdrop").classList.add("open"); $("roles-modal").classList.add("open"); }
function closeRoles(){ $("roles-backdrop").classList.remove("open"); $("roles-modal").classList.remove("open"); }

/* ---- persistence -------------------------------------------------------- */
function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(_){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(_){} }
function persist(){ if(CKEY) lsSet(CKEY,{settings,roleOverrides}); }
function mergeSettings(s){ const o={timeoutMin:60}; if(s&&s.timeoutMin&&GAP_OPTIONS.indexOf(s.timeoutMin)>=0) o.timeoutMin=s.timeoutMin; return o; }

/* ---- header / footer ---------------------------------------------------- */
function fillHeaderFooter(){
  $("course-title").textContent=DATA.meta.course;
  $("course-code").textContent=DATA.meta.courseCode||"";
  $("course-meta").textContent=`${DATA.meta.studentCount} students · ${DATA.meta.staffCount} staff · ${fmt(DATA.meta.totalRecords)} log events · ${DATA.meta.firstDate.slice(0,10)} → ${DATA.meta.lastDate.slice(0,10)}`;
  $("staff-note").innerHTML=DATA.staff.length?`<strong>Treated as staff (excluded):</strong> ${DATA.staff.map(s=>esc(s.name)).join(", ")}. <a href="#" id="staff-edit">Manage roles</a>`:"";
  $("gen-note").textContent=`Source: ${DATA.meta.sourceFile} · generated ${DATA.meta.generated}`;
  const se=$("staff-edit"); if(se) se.addEventListener("click",ev=>{ev.preventDefault();openRoles();});
}

/* ---- upload ------------------------------------------------------------- */
function showUpload(){ $("upload-screen").style.display="flex"; $("app").style.display="none"; }
function showApp(){ $("upload-screen").style.display="none"; $("app").style.display="block"; }
function handleFile(file){
  fileName=file.name||"logs.json"; $("upload-status").textContent="Reading "+fileName+" …";
  const fr=new FileReader();
  fr.onload=()=>{ rawText=fr.result; setTimeout(()=>{ try{ ingestAndRender(); showApp(); }
    catch(err){ $("upload-status").innerHTML=`<span class="err">${esc(err.message||"Could not process this file.")}</span>`; } },20); };
  fr.onerror=()=>{ $("upload-status").innerHTML='<span class="err">Could not read the file.</span>'; };
  fr.readAsText(file);
}
function ingestAndRender(){
  let d=ingestLogs(rawText,fileName,{});
  CKEY="moodleTime:"+(d.meta.courseCode||d.meta.course||"course");
  const saved=lsGet(CKEY)||{};
  settings=mergeSettings(saved.settings); roleOverrides=saved.roleOverrides||{};
  if(Object.keys(roleOverrides).length) d=ingestLogs(rawText,fileName,roleOverrides);
  loadData(d); recompute(); renderAll(); fillHeaderFooter();
}

/* ---- init --------------------------------------------------------------- */
function init(){
  const inp=$("file-input"), dz=$("dropzone");
  inp.addEventListener("change",e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); });
  dz.addEventListener("click",()=>inp.click());
  ["dragover","dragenter"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag");}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag");}));
  dz.addEventListener("drop",e=>{ const f=e.dataTransfer.files[0]; if(f) handleFile(f); });

  document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
  if(typeof location!=="undefined"){ const h=(location.hash||"").replace("#",""); if(TABS.includes(h)) current=h; }
  $("range-select").addEventListener("change",e=>{ applyPreset(e.target.value); recompute(); renderAll(); });
  $("load-btn").addEventListener("click",showUpload);
  $("roles-btn").addEventListener("click",openRoles);
  $("print-btn").addEventListener("click",()=>window.print());
  $("drawer-close").addEventListener("click",closeDrawer);
  $("drawer-backdrop").addEventListener("click",closeDrawer);
  $("roles-close").addEventListener("click",closeRoles);
  $("roles-backdrop").addEventListener("click",closeRoles);
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ closeDrawer(); closeRoles(); } });

  if(typeof window!=="undefined" && window.__TEST_RAW){ rawText=window.__TEST_RAW; fileName=window.__TEST_FILE||"test.json"; ingestAndRender(); showApp(); window.__MODEL=MODEL; return; }
  if(typeof window!=="undefined" && window.__TEST_DATA){ CKEY=""; settings=mergeSettings(null); roleOverrides={}; loadData(window.__TEST_DATA); recompute(); renderAll(); fillHeaderFooter(); showApp(); window.__MODEL=MODEL; return; }
  showUpload();
}
if(document.readyState!=="loading") init(); else document.addEventListener("DOMContentLoaded",init);
})();
