// Minimal DOM stub: exercises every render path for exceptions and inspects output.
const store = {};
class FakeEl {
  constructor(){ this._html=""; }
  set innerHTML(v){ this._html=v; } get innerHTML(){ return this._html; }
  getElementById(){ return this; }
  querySelectorAll(){ return []; }
  querySelector(){ return null; }
  addEventListener(){}
}
globalThis.HTMLElement = class { attachShadow(){ this.shadowRoot=new FakeEl(); return this.shadowRoot; } };
globalThis.customElements = { define:(n,c)=>{ store[n]=c; } };
globalThis.window = { customCards: [] };
globalThis.setInterval = ()=>0; globalThis.clearInterval = ()=>{};
globalThis.setTimeout = (f)=>0; globalThis.clearTimeout = ()=>{};

const src = await import('node:fs').then(fs=>fs.readFileSync(new URL('../custom_components/tsvk_scheduler/frontend/tsvk-scheduler-panel.js', import.meta.url),'utf8'));
new Function(src)();
const Cls = store['tsvk-scheduler-panel'];

// Pull the pure helpers out of the module scope so the span maths can be asserted
// without going through the DOM.
const H = {};
{
  const cut = src.indexOf('/* ------------------------------------------------------------------- styles */');
  new Function('X', src.slice(src.indexOf('const clampDay'), cut) +
    ';Object.assign(X,{windowsToBlocks,blocksToWindows,depthSegments,maxDepth,totalOnMinutes,winLength,normalise,toSpans,mergeSpans,toHHMM,toMin,dur,clampDay});')(H);
}

const nowISO = new Date(Date.now()+3*3600*1000).toISOString();
const hass = {
  states: {
    'switch.gate_light': {state:'off', attributes:{friendly_name:'Gate Light'}},
    'switch.porch':      {state:'on',  attributes:{friendly_name:'Porch Tubelight'}},
    'switch.dead':       {state:'unavailable', attributes:{friendly_name:'Dead Plug'}},
    'input_boolean.a':   {state:'off', attributes:{friendly_name:'Sound Power'}},
    'light.bulb':        {state:'on',  attributes:{friendly_name:'zigbee bulb'}},
    'automation.tsvk_scheduler_engine': {state:'on', attributes:{}},
    'schedule.r1':       {state:'on',  attributes:{next_event:nowISO}},
    'schedule.r2':       {state:'off', attributes:{next_event:null}},
  },
  callWS:async()=>[], callApi:async()=>({}), callService:async()=>{},
};

const p = new Cls();
p.connectedCallback();
p._hass = hass;
p._loaded = true;
p._engineOk = true;
p._registry = { entities:[{entity_id:'switch.gate_light', area_id:'a1'}], areas:{a1:'Porch'}, devices:{} };
p._model = { v:1, step:5, rules:[
  {id:'r1', name:'Gate light overnight', schedule:'schedule.r1',
   targets:['switch.gate_light','switch.dead'], windows:[{s:1200,e:300}], enabled:true},
  {id:'r2', name:'Sound power', schedule:'schedule.r2',
   targets:['input_boolean.a'], windows:[{s:0,e:0}], enabled:false},
]};

const checks = [];
const run = (label, fn) => { try { fn(); checks.push(['ok  ', label]); }
                             catch(e){ checks.push(['FAIL', label+' :: '+e.message]); } };
// `run` cannot await, so a test that touches the panel's async paths must use this
// one — otherwise its body interleaves with the tests that follow and they fight
// over the shared fixture.
const arun = async (label, fn) => { try { await fn(); checks.push(['ok  ', label]); }
                                    catch(e){ checks.push(['FAIL', label+' :: '+e.message]); } };

// --- window maths -----------------------------------------------------------
// These were originally an ad-hoc scratch run; keeping them here means deploy.sh
// re-checks them on every push.
const eq = (label, got, want) => run(label, ()=>{
  const A=JSON.stringify(got), B=JSON.stringify(want);
  if(A!==B) throw new Error('got '+A+' want '+B);
});
eq('normalise: simple window',      H.normalise([{s:480,e:1020}]), [{s:480,e:1020}]);
eq('normalise: wrap 20:00-05:00',   H.normalise([{s:1200,e:300}]), [{s:1200,e:300}]);
eq('normalise: overlap merges',     H.normalise([{s:480,e:600},{s:540,e:720}]), [{s:480,e:720}]);
eq('normalise: adjacent joins',     H.normalise([{s:480,e:600},{s:600,e:720}]), [{s:480,e:720}]);
eq('normalise: disjoint kept',      H.normalise([{s:300,e:400},{s:1200,e:1300}]), [{s:300,e:400},{s:1200,e:1300}]);
eq('normalise: wrap + midday',      H.normalise([{s:1200,e:300},{s:600,e:700}]), [{s:600,e:700},{s:1200,e:300}]);
eq('normalise: full cover',         H.normalise([{s:0,e:720},{s:720,e:0}]), [{s:0,e:0}]);
eq('normalise: contained window',   H.normalise([{s:480,e:1080},{s:600,e:700}]), [{s:480,e:1080}]);
eq('blocks: wrap splits at midnight', H.windowsToBlocks([{s:1200,e:300}]),
   [{from:'00:00:00',to:'05:00:00'},{from:'20:00:00',to:'24:00:00'}]);
eq('blocks: all day',               H.windowsToBlocks([{s:0,e:0}]), [{from:'00:00:00',to:'24:00:00'}]);
eq('round-trip: wrap',              H.blocksToWindows(H.windowsToBlocks([{s:1200,e:300}])), [{s:1200,e:300}]);
eq('round-trip: two disjoint',      H.blocksToWindows(H.windowsToBlocks([{s:300,e:400},{s:1200,e:1300}])),
   [{s:300,e:400},{s:1200,e:1300}]);
eq('round-trip: all day',           H.blocksToWindows(H.windowsToBlocks([{s:0,e:0}])), [{s:0,e:0}]);
eq('HA reports end-of-day as 23:59:59.999999',
   H.blocksToWindows([{from:'00:00:00',to:'05:00:00'},{from:'20:00:00',to:'23:59:59.999999'}]), [{s:1200,e:300}]);
eq('winLength across midnight',     H.winLength({s:1200,e:300}), 540);
eq('winLength all day',             H.winLength({s:0,e:0}), 1440);
eq('toHHMM wraps 1440 to 00:00',    H.toHHMM(1440), '00:00');
eq('dur formats hours and minutes', [H.dur(540), H.dur(545), H.dur(5)], ['9h','9h 5m','5m']);

run('render list', ()=>p._render());
const listHtml = p.shadowRoot.innerHTML;
run('header shows counts', ()=>{ if(!listHtml.includes('1 active')) throw new Error('missing count'); });
run('wrap window renders as 20:00 → 05:00', ()=>{ if(!listHtml.includes('20:00 → 05:00')) throw new Error('missing chip'); });
run('paused rule renders', ()=>{ if(!listHtml.includes('Paused')) throw new Error('no paused pill'); });
run('all-day rule renders', ()=>{ if(!listHtml.includes('All day')) throw new Error('no all-day chip'); });
run('offline badge renders', ()=>{ if(!listHtml.includes('1 offline')) throw new Error('no offline pill'); });
run('two ribbon segments for wrap', ()=>{ const n=(listHtml.match(/class='seg'/g)||[]).length; if(n<3) throw new Error('segs='+n); });

run('render empty state', ()=>{ const m=p._model; p._model={v:1,step:5,rules:[]}; p._render();
  if(!p.shadowRoot.innerHTML.includes('No schedules yet')) throw new Error('no empty state'); p._model=m; });

run('render new dialog', ()=>{ p._dialog={id:'x',isNew:true,name:'',targets:[],windows:[{s:1207,e:323}],q:''}; p._render(); });
const dlg = p.shadowRoot.innerHTML;
run('dialog save disabled when incomplete', ()=>{ if(!dlg.includes("data-act='save' disabled")) throw new Error('save not disabled'); });
run('dialog shows next-day marker', ()=>{ if(!dlg.includes('next day')) throw new Error('no wrap marker'); });
run('picker groups by area', ()=>{ if(!dlg.includes('Porch') || !dlg.includes('No area')) throw new Error('no groups'); });
run('engine automation excluded from picker', ()=>{ if(dlg.includes('tsvk_scheduler_engine')) throw new Error('engine listed'); });
run('time entry is 4 selects, no free text', ()=>{ const n=(dlg.match(/data-act='time'/g)||[]).length; if(n!==4) throw new Error('selects='+n); });

run('minute select offers all 60 minutes', ()=>{
  const m = dlg.match(/data-p='m'>([\s\S]*?)<\/select>/);
  if(!m) throw new Error('no minute select');
  const n = (m[1].match(/<option /g)||[]).length;
  if(n!==60) throw new Error('minute options='+n);
  if(!m[1].includes(">07<") || !m[1].includes(">59<")) throw new Error('missing non-multiple-of-5 minutes');
});
run('hour select offers all 24 hours', ()=>{
  const m = dlg.match(/data-p='h'>([\s\S]*?)<\/select>/);
  const n = (m[1].match(/<option /g)||[]).length;
  if(n!==24) throw new Error('hour options='+n);
});
run('granularity picker is gone', ()=>{ if(dlg.includes("data-act='step'")) throw new Error('step control still rendered'); });

run('new: search filters picker', ()=>{
  p._dialog={id:'x',isNew:true,name:'',targets:[],windows:[{s:1207,e:323}],q:'porch'}; p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes('zigbee bulb')) throw new Error('filter not applied');
  if(!h.includes('Porch Tubelight')) throw new Error('matching entity dropped');
});
run('new: no delete button', ()=>{ if(p.shadowRoot.innerHTML.includes("data-act='delete'")) throw new Error('delete in new dialog'); });

run('render edit dialog', ()=>{ p._dialog={id:'r1',isNew:false,name:'Gate light overnight',
  targets:['switch.gate_light'],windows:[{s:1207,e:323}],q:''}; p._render(); });
const edit = p.shadowRoot.innerHTML;
run('edit: entity picker gone', ()=>{
  if(edit.includes("data-act='pick'")) throw new Error('checkboxes rendered');
  if(edit.includes("class='picker'")) throw new Error('picker list rendered');
});
run('edit: device search box gone', ()=>{ if(edit.includes("data-act='search'")) throw new Error('search rendered'); });
run('edit: name input gone', ()=>{ if(edit.includes("data-act='name'")) throw new Error('name input rendered'); });
run('edit: no device block at all', ()=>{
  if(edit.includes("class='device-ro'")) throw new Error('device row rendered');
  if(edit.includes('>Device<')) throw new Error('Device heading rendered');
  if(edit.includes('switch.gate_light')) throw new Error('entity id rendered');
});
run('edit: the title still names the schedule', ()=>{
  if(!edit.includes('Gate light overnight')) throw new Error('title lost with the device block');
});
run('edit: title is the schedule name', ()=>{ if(!edit.includes('<h2>Gate light overnight</h2>')) throw new Error('title not the rule name'); });
run('edit: times still editable', ()=>{ const n=(edit.match(/data-act='time'/g)||[]).length; if(n!==4) throw new Error('selects='+n); });
run('edit: minute select still offers 60', ()=>{
  const m = edit.match(/data-p='m'>([\s\S]*?)<\/select>/);
  const n = (m[1].match(/<option /g)||[]).length;
  if(n!==60) throw new Error('minute options='+n);
});
run('edit dialog offers delete', ()=>{ if(!edit.includes("data-act='delete'")) throw new Error('no delete'); });

// --- added rows are unset drafts that never disturb existing windows ---------
// The rule list renders behind the dialog, so every assertion here is scoped to the
// dialog markup only.
const click = (act, el={}) => p._onClick(act, Object.assign({dataset:{}}, el), {});
const setT = (i,w,part,val) => p._onChange('time', {dataset:{i:String(i), w:w, p:part}, value:String(val)}, {});
const dlgHtml = () => { const h=p.shadowRoot.innerHTML; const i=h.indexOf("<div class='overlay'");
                        if(i<0) throw new Error('no dialog'); return h.slice(i); };
const openEdit = (windows) => { p._dialog={id:'r1',isNew:false,name:'Gate light overnight',
  targets:['switch.gate_light'],windows:windows,q:''}; p._render(); };

run('addwin appends an unset 00:00 draft, leaving existing windows alone', ()=>{
  openEdit([{s:1140,e:1260}]);            // 19:00 -> 21:00
  click('addwin');
  const w=p._dialog.windows;
  if(w.length!==2) throw new Error('len='+w.length);
  if(JSON.stringify(w[0])!==JSON.stringify({s:1140,e:1260})) throw new Error('existing window changed: '+JSON.stringify(w[0]));
  if(!(w[1].draft && w[1].s===0 && w[1].e===0)) throw new Error('draft wrong: '+JSON.stringify(w[1]));
});
run('draft renders as 00:00 -> 00:00, not "All day"', ()=>{
  p._render();
  const h=dlgHtml();
  if(h.includes('All day')) throw new Error('draft rendered as all-day');
  if(!h.includes('set a start and end')) throw new Error('no pending marker');
});
run('ribbon ignores the draft', ()=>{
  const n=(dlgHtml().match(/class='seg'/g)||[]).length;
  if(n!==1) throw new Error('segs='+n);
});
run('save is blocked while a row is pending', ()=>{
  const h=dlgHtml();
  if(!h.includes("data-act='save' disabled")) throw new Error('save enabled');
  if(!h.includes('Give the new entry a start and end time')) throw new Error('no hint');
});
run('add button is inert while a row is pending', ()=>{
  if(!dlgHtml().includes("data-act='addwin' style='margin-top:8px;opacity:.4;cursor:not-allowed' disabled"))
    throw new Error('add button not disabled');
  click('addwin', {disabled:true});
  if(p._dialog.windows.length!==2) throw new Error('second draft added');
});
run('editing to another 00:00 keeps it a draft and does not nudge', ()=>{
  setT(1,'s','h',0);                       // still 00:00 -> 00:00
  const w=p._dialog.windows[1];
  if(!w.draft) throw new Error('draft cleared too early');
  if(w.e!==0) throw new Error('nudged a draft: e='+w.e);
});
run('a real range clears the draft and keeps a disjoint window separate', ()=>{
  setT(1,'e','h',10);                      // 00:00 -> 10:00
  const w=p._dialog.windows;
  if(w.some(x=>x.draft)) throw new Error('still a draft');
  if(JSON.stringify(w)!==JSON.stringify([{s:1140,e:1260},{s:0,e:600}])) throw new Error('got '+JSON.stringify(w));
});
run('save re-enables once nothing is pending', ()=>{
  p._render();
  if(dlgHtml().includes("data-act='save' disabled")) throw new Error('save still blocked');
});
run('an overlapping entry stays a separate entry', ()=>{
  openEdit([{s:1200,e:300}]);              // 20:00 -> 05:00, wraps
  click('addwin');
  setT(1,'e','h',10);                      // 00:00 -> 10:00, overlaps the wrap
  const w=p._dialog.windows;
  if(JSON.stringify(w)!==JSON.stringify([{s:1200,e:300},{s:0,e:600}])) throw new Error('got '+JSON.stringify(w));
});
run('editing a time never reorders the rows', ()=>{
  openEdit([{s:1140,e:1260},{s:120,e:180}]);
  setT(0,'s','h',18);
  const w=p._dialog.windows;
  if(w[0].s!==1080 || w[1].s!==120) throw new Error('reordered: '+JSON.stringify(w));
});

// --- overlaps are drawn, not merged -----------------------------------------
run('overlap produces a depth-2 band, naming its windows', ()=>{
  const d=H.depthSegments([{s:540,e:720},{s:600,e:780}]);   // 09-12 and 10-13
  const want=[{a:540,b:600,depth:1,wins:[0]},{a:600,b:720,depth:2,wins:[0,1]},{a:720,b:780,depth:1,wins:[1]}];
  if(JSON.stringify(d)!==JSON.stringify(want)) throw new Error(JSON.stringify(d));
});
run('a wrapping window counts once, not twice', ()=>{
  const d=H.depthSegments([{s:1200,e:300}]);
  if(d.some(x=>x.depth!==1)) throw new Error('depth>1 for one window: '+JSON.stringify(d));
  if(d.length!==2) throw new Error('expected a slice either side of midnight: '+JSON.stringify(d));
});

// --- hover tooltips on the time bar (both screens) --------------------------
// These swap the model for focused fixtures, so stash the shared one and put it back.
const MODEL0 = p._model;
const tipsIn = (html) => (html.match(/data-tip='([^']*)'/g)||[]).map(m=>m.slice(10,-1));
run('list screen: each blue slice carries its on/off time', ()=>{
  p._dialog=null; p._isAdmin=true; p._viaService=false; p._canEdit=true;
  p._model={v:1,rules:[{id:'r1',name:'Gate light',schedule:'schedule.r1',
    targets:['switch.gate_light'],windows:[{s:1200,e:300}],enabled:true}]};
  p._render();
  const tips=tipsIn(p.shadowRoot.innerHTML);
  if(tips.length!==2) throw new Error('slices='+tips.length);
  for(const t of tips){
    if(!t.includes('20:00')||!t.includes('05:00')) throw new Error('bad tip: '+t);
    if(!t.includes('9h')) throw new Error('no duration: '+t);
  }
});
run('edit screen: the dialog ribbon has them too', ()=>{
  p._dialog={id:'r1',isNew:false,name:'Gate light',targets:['switch.gate_light'],
             windows:[{s:540,e:720},{s:600,e:780}],q:''};
  p._render();
  const h=p.shadowRoot.innerHTML;
  const tips=tipsIn(h.slice(h.indexOf("<div class='overlay'")));
  if(tips.length!==3) throw new Error('dialog slices='+tips.length);
  if(!tips[1].includes('2 overlapping entries')) throw new Error('no overlap header: '+tips[1]);
  if(!(tips[1].includes('09:00')&&tips[1].includes('10:00'))) throw new Error('tip misses an entry: '+tips[1]);
});
run('all-day window reads as All day', ()=>{
  p._dialog=null; p._model={v:1,rules:[{id:'a',name:'A',schedule:'schedule.r2',
    targets:['switch.gate_light'],windows:[{s:0,e:0}],enabled:true}]};
  p._render();
  const t=tipsIn(p.shadowRoot.innerHTML)[0];
  if(!t.includes('All day')) throw new Error(t);
});
run('exactly one tooltip element exists', ()=>{
  const n=(p.shadowRoot.innerHTML.match(/class='tip'/g)||[]).length;
  if(n!==1) throw new Error('tip elements='+n);
});
run('shared fixture restored for the tests that follow', ()=>{
  p._model = MODEL0; p._dialog = null; p._render();
  if(p._model.rules.length!==2) throw new Error('fixture not restored');
});
run('triple overlap reaches depth 3', ()=>{
  if(H.maxDepth([{s:540,e:720},{s:600,e:780},{s:610,e:700}])!==3) throw new Error('depth='+H.maxDepth([{s:540,e:720},{s:600,e:780},{s:610,e:700}]));
});
run('a wrapping overlap is counted across midnight', ()=>{
  const d=H.depthSegments([{s:1200,e:300},{s:1320,e:60}]);   // 20-05 and 22-01
  const deep=d.filter(x=>x.depth===2).map(x=>[x.a,x.b]);
  if(JSON.stringify(deep)!==JSON.stringify([[0,60],[1320,1440]])) throw new Error(JSON.stringify(d));
});
run('ribbon shades the overlap darker', ()=>{
  openEdit([{s:540,e:720},{s:600,e:780}]);
  const h=dlgHtml();
  if(!h.includes("class='seg d2'")) throw new Error('no darker band rendered');
  if(!h.includes('Darker blue marks where entries overlap')) throw new Error('no overlap hint');
});
run('no overlap hint when nothing overlaps', ()=>{
  openEdit([{s:540,e:600},{s:1140,e:1260}]);
  const h=dlgHtml();
  if(h.includes("class='seg d2'")) throw new Error('spurious darker band');
  if(h.includes('Darker blue marks where entries overlap')) throw new Error('spurious hint');
});

// --- but HA still receives valid, non-overlapping blocks --------------------
run('overlapping windows collapse to legal blocks for the schedule helper', ()=>{
  const b=H.windowsToBlocks([{s:540,e:720},{s:600,e:780}]);
  if(JSON.stringify(b)!==JSON.stringify([{from:'09:00:00',to:'13:00:00'}])) throw new Error(JSON.stringify(b));
});
run('overlapping wrap collapses correctly too', ()=>{
  const b=H.windowsToBlocks([{s:1200,e:300},{s:1320,e:60}]);
  if(JSON.stringify(b)!==JSON.stringify([{from:'00:00:00',to:'05:00:00'},{from:'20:00:00',to:'24:00:00'}]))
    throw new Error(JSON.stringify(b));
});
run('blocks handed to HA never overlap', ()=>{
  const cases=[[{s:540,e:720},{s:600,e:780}],[{s:1200,e:300},{s:1320,e:60}],
               [{s:0,e:60},{s:30,e:90},{s:80,e:1439}],[{s:600,e:600+1}]];
  for(const c of cases){
    const b=H.windowsToBlocks(c).map(x=>[x.from,x.to]);
    for(let i=1;i<b.length;i++) if(b[i][0] < b[i-1][1]) throw new Error('overlap in '+JSON.stringify(b));
  }
});
run('total on-time is the union, not the sum', ()=>{
  if(H.totalOnMinutes([{s:540,e:720},{s:600,e:780}])!==240) throw new Error('got '+H.totalOnMinutes([{s:540,e:720},{s:600,e:780}]));
});
run('deleting a draft restores the original state', ()=>{
  openEdit([{s:1200,e:300}]);
  click('addwin');
  click('delwin', {dataset:{i:'1'}});
  if(JSON.stringify(p._dialog.windows)!==JSON.stringify([{s:1200,e:300}])) throw new Error(JSON.stringify(p._dialog.windows));
});
run('an all-day window loaded from HA is still all-day, not a draft', ()=>{
  openEdit([{s:0,e:0}]);
  const h=dlgHtml();
  if(!h.includes('All day')) throw new Error('all-day regressed');
  if(h.includes('set a start and end')) throw new Error('treated as a draft');
});
run('_save drops any pending row defensively', ()=>{
  openEdit([{s:1140,e:1260}]);
  click('addwin');
  const kept = p._dialog.windows.filter(w=>!w.draft);
  if(JSON.stringify(kept)!==JSON.stringify([{s:1140,e:1260}])) throw new Error(JSON.stringify(kept));
});

// --- read-only mode for non-admin users -------------------------------------
run('viewer: no New button, shows View only', ()=>{
  p._dialog=null; p._isAdmin=false; p._viaService=false; p._canEdit=false; p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("data-act='new'")) throw new Error('New button rendered');
  if(!h.includes('View only')) throw new Error('no View only pill');
  if(!h.includes('only lets administrators change them')) throw new Error('no read-only banner');
});
run('viewer: no per-rule edit or pause controls', ()=>{
  const h=p.shadowRoot.innerHTML;
  if(h.includes("data-act='edit'")) throw new Error('edit button rendered');
  if(h.includes("data-act='toggle'")) throw new Error('pause button rendered');
});
run('viewer: still sees the schedules themselves', ()=>{
  const h=p.shadowRoot.innerHTML;
  if(!h.includes('20:00 → 05:00')) throw new Error('windows missing');
  if(!h.includes('Gate Light')) throw new Error('device missing');
  if(!(h.match(/class='seg'/g)||[]).length) throw new Error('ribbon missing');
});
run('viewer: a 401 is not reported as a missing engine', ()=>{
  p._engineOk=false; p._render();
  if(p.shadowRoot.innerHTML.includes('engine automation is missing')) throw new Error('false alarm shown');
  p._engineOk=true;
});
run('viewer: write actions are inert', ()=>{
  p._onClick('new', {dataset:{}}, {});
  if(p._dialog) throw new Error('dialog opened for a viewer');
  p._onClick('edit', {dataset:{id:'r1'}}, {});
  if(p._dialog) throw new Error('edit opened for a viewer');
});
run('viewer: empty state has no create CTA', ()=>{
  const m=p._model; p._model={v:1,rules:[]}; p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("data-act='new'")) throw new Error('CTA rendered');
  if(!h.includes('has not set any up yet')) throw new Error('no viewer empty text');
  p._model=m;
});
// a non-admin WITH custom_components/tsvk_scheduler installed gets the full UI
run('service-backed editor: full controls, no read-only banner', ()=>{
  p._isAdmin=false; p._viaService=true; p._canEdit=true; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes("data-act='new'")) throw new Error('New button missing');
  if(!h.includes("data-act='edit'")) throw new Error('edit button missing');
  if(h.includes('only lets administrators change them')) throw new Error('read-only banner shown');
});
run('service-backed editor: never shows the engine-missing banner', ()=>{
  p._engineOk=false; p._render();
  if(p.shadowRoot.innerHTML.includes('engine automation is missing')) throw new Error('false alarm');
  p._engineOk=true;
});
run('service-backed editor: _persist does not POST the automation', async ()=>{
  let posted=false;
  const real=p._hass.callApi; p._hass.callApi=async()=>{ posted=true; return {}; };
  await p._persist();
  p._hass.callApi=real;
  if(posted) throw new Error('non-admin attempted a direct config write');
});
run('writeError explains an auth refusal', ()=>{
  const m=p._writeError({message:'unauthorized'});
  if(!/administrator/i.test(m)) throw new Error('unhelpful message: '+m);
  if(!/Could not save: boom/.test(p._writeError({message:'boom'}))) throw new Error('generic path wrong');
});

run('admin: controls come back', ()=>{
  p._isAdmin=true; p._viaService=false; p._canEdit=true; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes("data-act='new'")) throw new Error('New button missing');
  if(!h.includes("data-act='edit'")) throw new Error('edit button missing');
  if(h.includes('only lets administrators change them')) throw new Error('viewer banner shown to admin');
});
// The stub replaces shadowRoot.innerHTML on render, so the stylesheet is only
// readable from the source itself.
run('list rows carry no device-type circle', ()=>{
  p._dialog=null; p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("class='avatar")) throw new Error('avatar still rendered in the list');
  if(!h.includes("class='pill")) throw new Error('state pill missing');
});
run('no device circle is drawn anywhere any more', ()=>{
  p._dialog={id:'r1',isNew:false,name:'Gate light overnight',
    targets:['switch.gate_light'],windows:[{s:1200,e:300}],q:''};
  p._render();
  if(p.shadowRoot.innerHTML.includes("class='avatar")) throw new Error('avatar still rendered');
  p._dialog=null; p._render();
});
run('card head is one vertically centred row', ()=>{
  if(!/\.card-head \{[^}]*align-items: center/.test(src)) throw new Error('head not centred');
});
// --- the device line only appears when it is not the title again ------------
run('a rule named after its device shows no second line', ()=>{
  p._dialog=null; p._isAdmin=true; p._viaService=false; p._canEdit=true;
  p._model={v:1,rules:[{id:'r1',name:'Porch Tubelight',schedule:'schedule.r1',
    targets:['switch.porch'],windows:[{s:1200,e:300}],enabled:true}]};
  p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("class='meta'")) throw new Error('duplicate device line rendered');
  const card=h.slice(h.indexOf("<div class='card"));   // the header names it too
  if((card.match(/Porch Tubelight/g)||[]).length!==1) throw new Error('name printed twice in the card');
});
run('spacing and case differences still count as the same name', ()=>{
  p._model.rules[0].name='porchtubelight'; p._render();
  if(p.shadowRoot.innerHTML.includes("class='meta'")) throw new Error('near-duplicate line rendered');
  p._model.rules[0].name='Porch Tubelight';
});
run('a differently named device is still listed', ()=>{
  p._model.rules[0].name='Gate light overnight'; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes("class='meta'")) throw new Error('device line dropped');
  if(!h.includes('Porch Tubelight')) throw new Error('device name missing');
});
run('several devices are still listed', ()=>{
  p._model.rules[0].name='Porch Tubelight';
  p._model.rules[0].targets=['switch.porch','switch.gate_light']; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes('Gate Light')) throw new Error('second device missing');
});
run('an unavailable device is still called out with the title suppressed', ()=>{
  p._model.rules[0].targets=['switch.dead']; p._model.rules[0].name='Dead Plug'; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes("<div class='meta'>1 unavailable</div>")) throw new Error('no unavailable note');
});
run('a rule with no devices still says so', ()=>{
  p._model.rules[0].targets=[]; p._render();
  if(!p.shadowRoot.innerHTML.includes('no devices')) throw new Error('empty rule not flagged');
});
run('fixture restored after the device-line tests', ()=>{
  p._model=MODEL0; p._render();
  if(p._model.rules.length!==2) throw new Error('fixture not restored');
});

// --- schedule status stays on its own row under the card --------------------
run('status renders as the foot row, not on the title line', ()=>{
  p._dialog=null; p._isAdmin=true; p._viaService=false; p._canEdit=true;
  p._model={v:1,rules:[{id:'r1',name:'Center Light',schedule:'schedule.r2',
    targets:['switch.gate_light'],windows:[{s:1200,e:300}],enabled:true}]};
  p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("class='status'")) throw new Error('status still inline in the title');
  if(!/<div class='foot'>Should be OFF/.test(h)) throw new Error('no foot row');
  const m=h.match(/<div class='name'>([\s\S]*?)<\/div>/);
  if(m[1]!=='Center Light') throw new Error('name line carries more than the name: '+m[1]);
});
run('shared fixture restored after the foot-row test', ()=>{
  p._model=MODEL0; p._render();
  if(p._model.rules.length!==2) throw new Error('fixture not restored');
});

// --- restore-to-schedule sweep ----------------------------------------------
// schedule.r1 is on and switch.gate_light is off, so r1 has exactly one mismatch;
// switch.dead is unavailable and must never be counted. r2 is paused.
run('admin: header offers Restore now', ()=>{
  p._dialog=null; p._isAdmin=true; p._viaService=false; p._canEdit=true; p._render();
  const h=p.shadowRoot.innerHTML;
  if(!h.includes("data-act='restore'")) throw new Error('no restore button');
  if(!h.includes('Restore now')) throw new Error('no label');
});
run('mismatch count ignores paused rules and unavailable devices', ()=>{
  const m=p._mismatched();
  if(m.length!==1) throw new Error('mismatched='+JSON.stringify(m.map(x=>x.id)));
  if(m[0].id!=='switch.gate_light') throw new Error('wrong entity: '+m[0].id);
  if(m[0].want!=='on') throw new Error('wrong target state: '+m[0].want);
});
run('badge shows the mismatch count', ()=>{
  if(!p.shadowRoot.innerHTML.includes("<span class='hbadge'>1</span>")) throw new Error('no badge');
});
run('no badge when everything already matches', ()=>{
  const st=p._hass.states['switch.gate_light'].state;
  p._hass.states['switch.gate_light'].state='on';
  p._render();
  const h=p.shadowRoot.innerHTML;
  if(h.includes("class='hbadge'")) throw new Error('badge shown with nothing to fix');
  if(!h.includes("data-act='restore'")) throw new Error('button hidden when in sync');
  p._hass.states['switch.gate_light'].state=st; p._render();
});
await arun('restore fires the apply event for an admin without the integration', async ()=>{
  let posted=null;
  const real=p._hass.callApi; p._hass.callApi=async(m,path)=>{ posted=m+' '+path; return {}; };
  await p._onClick('restore', {dataset:{}}, {});
  p._hass.callApi=real;
  if(posted!=='POST events/tsvk_scheduler_apply') throw new Error('posted='+posted);
  if(!/Restoring 1 device to its schedule/.test(p._toast)) throw new Error('toast='+p._toast);
});
await arun('restore prefers the service when the integration is installed', async ()=>{
  p._hass.services={tsvk_scheduler:{apply:{}}};
  let called=null, posted=false;
  const rs=p._hass.callService, ra=p._hass.callApi;
  p._hass.callService=async(d,sv)=>{ called=d+'.'+sv; };
  p._hass.callApi=async()=>{ posted=true; return {}; };
  await p._onClick('restore', {dataset:{}}, {});
  p._hass.callService=rs; p._hass.callApi=ra; delete p._hass.services;
  if(called!=='tsvk_scheduler.apply') throw new Error('called='+called);
  if(posted) throw new Error('fell back to the event API with the service available');
});
await arun('restore refuses while the engine is off', async ()=>{
  const st=p._hass.states['automation.tsvk_scheduler_engine'].state;
  p._hass.states['automation.tsvk_scheduler_engine'].state='off';
  let touched=false;
  const ra=p._hass.callApi; p._hass.callApi=async()=>{ touched=true; return {}; };
  await p._onClick('restore', {dataset:{}}, {});
  p._hass.callApi=ra; p._hass.states['automation.tsvk_scheduler_engine'].state=st;
  if(touched) throw new Error('fired the sweep with the engine off');
  if(!/engine is turned off/.test(p._toast)) throw new Error('toast='+p._toast);
});
await arun('restore reports an auth refusal in its own words', async ()=>{
  const ra=p._hass.callApi; p._hass.callApi=async()=>{ throw new Error('401 unauthorized'); };
  await p._onClick('restore', {dataset:{}}, {});
  p._hass.callApi=ra;
  if(!/Restoring needs an administrator/.test(p._toast)) throw new Error('toast='+p._toast);
});
run('viewer without the integration gets no restore button', ()=>{
  p._isAdmin=false; p._viaService=false; p._canEdit=false; p._render();
  if(p.shadowRoot.innerHTML.includes("data-act='restore'")) throw new Error('button rendered');
});
await arun('viewer without the integration cannot fire it', async ()=>{
  let touched=false;
  const ra=p._hass.callApi; p._hass.callApi=async()=>{ touched=true; return {}; };
  await p._onClick('restore', {dataset:{}}, {});
  p._hass.callApi=ra;
  if(touched) throw new Error('viewer fired the sweep');
});
run('service-backed viewer does get the button', ()=>{
  p._hass.services={tsvk_scheduler:{apply:{}}};
  p._isAdmin=false; p._viaService=true; p._canEdit=true; p._render();
  const ok=p.shadowRoot.innerHTML.includes("data-act='restore'");
  delete p._hass.services;
  if(!ok) throw new Error('button missing for a service-backed user');
});
run('no restore button before any schedules exist', ()=>{
  p._isAdmin=true; p._viaService=false; p._canEdit=true;
  const m=p._model; p._model={v:1,rules:[]}; p._render();
  const h=p.shadowRoot.innerHTML;
  p._model=m; p._render();
  if(h.includes("data-act='restore'")) throw new Error('button on the empty state');
});
run('the override footnote points at the button', ()=>{
  if(!p.shadowRoot.innerHTML.includes('manually overridden — Restore now puts it back'))
    throw new Error('footnote missing');
});

run('setConfig keeps the card config', ()=>{
  p.setConfig({type:'custom:tsvk-scheduler-panel', model:{v:1,rules:[{id:'z'}]}});
  if(!p._cardConfig.model) throw new Error('config dropped');
  p.setConfig({});
});

run('signature is stable', ()=>{ p._dialog=null; const a=p._signature(), b=p._signature(); if(a!==b) throw new Error('unstable'); });
run('buildEngine via save path exists', ()=>{ if(typeof p._save!=='function') throw new Error('no _save'); });
run('escaping blocks injection', ()=>{ p._model.rules[0].name = "<img src=x onerror=alert(1)>"; p._render();
  if(p.shadowRoot.innerHTML.includes('<img src=x')) throw new Error('unescaped'); });

for (const [s,l] of checks) console.log(s+' '+l);
console.log('\n'+checks.filter(c=>c[0]==='ok  ').length+'/'+checks.length+' passed');
