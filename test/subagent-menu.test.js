import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/client.subagent.js",import.meta.url),"utf8");
// Render through both registered slot components. The hook host deliberately
// owns no catalog logic: button actions drive state and the next render.
function desktop() {
  const seats = {}, data = {}, statuses = new Map(), summaries = {}, saved = new Map(), nav = [], loads = [];
  const hooks = new Map(), effects = [], nodes = [];
  let scope, cursor, api, dict;
  const react = {
    Fragment:"fragment",
    createElement:(type,props,...children)=>({type,props:props??{},children}),
    useState(initial){const i=cursor++, slots=scope; if(!(i in slots)) slots[i]=typeof initial==="function"?initial():initial;
      return [slots[i],v=>{slots[i]=typeof v==="function"?v(slots[i]):v;}];},
    useRef(v){const [ref]=react.useState(()=>({current:v}));return ref;},
    useCallback:f=>f,
    useSyncExternalStore:(_,read)=>read(),
    useEffect(fn,deps){const i=cursor++;if(!scope[i] || deps.some((v,j)=>v!==scope[i][j])) effects.push(fn);scope[i]=deps;}
  };
  const document={head:{appendChild(){}},createElement:()=>({remove(){}}),addEventListener(){},removeEventListener(){},body:{}};
  const window={innerWidth:900,innerHeight:700,addEventListener(){},removeEventListener(){},__ModuleLoader__:{load:({factory})=>{api=factory(k=>k==="react"?react:{createPortal:v=>v});}}};
  vm.runInNewContext(source,{window,document,URLSearchParams});
  api.registerSubagentMenu({
    effect:fn=>fn(),locale:{register:(_,d)=>{dict=d.en;}},
    slots:{inject:(_,fn)=>fn(),register:(o,component)=>{seats[o.name.split(".").pop()]={o,component};}},
    sessions:{refreshProjections:id=>nav.push(id)},uiWorkspace:{openSession:a=>nav.push({...a})},
    sidebarRight:{openResource:(url,o)=>nav.push([url,{...o}])}
  },{
    getSnapshot:id=>saved.get(id)??[],subscribe:()=>()=>{},load:async id=>{loads.push(id);},
    update:async(id,add,remove)=>saved.set(id,[...new Set([...(saved.get(id)??[]),...add])].filter(x=>!remove.includes(x)))
  });
  function walk(el,path) {
    if(Array.isArray(el)) return el.map((v,i)=>walk(v,path+"/"+(v?.props?.key??i))).join("");
    if(el==null||typeof el==="boolean") return "";
    if(typeof el!=="object") return String(el);
    if(typeof el.type==="function"){
      path+="/"+el.type.name+":"+(el.props.key??"");
      if(!hooks.has(path))hooks.set(path,[]);
      scope=hooks.get(path);cursor=0;return walk(el.type(el.props),path);
    }
    const node={...el,getBoundingClientRect:()=>({left:50,bottom:100}),querySelector:()=>null};
    if(el.props.ref)el.props.ref.current=node;
    nodes.push(node);
    node.text=walk(el.children,path+"/"+el.type);return node.text;
  }
  function render(seat="actions", extra={}) {
    nodes.length=0;
    const {component,o}=seats[seat];
    const result=walk(react.createElement(component,{
      ...o.inject(),sessionId:"p",useSessions:f=>f({byId:summaries,projectionsBySession:data}),
      useSession:f=>f({}),useSessionStatus:f=>f(statuses),
      t:(k,args={})=>dict[k].replace("{n}",args.n),...extra
    }),seat);
    effects.splice(0).forEach(fn=>fn());return result;
  }
  const buttons=()=>nodes.filter(n=>n.type==="button");
  const click=(label,index=0)=>{const n=buttons().filter(n=>n.text===label || n.props["aria-label"]===label)[index];assert.ok(n,label);assert.ok(!n.props.disabled,label);n.props.onClick();};
  const labels=()=>buttons().filter(n=>n.props.className==="wx-sa-open").map(n=>n.children[0][0].children[0]);
  const entries=(p,values)=>{data[p]={state:"ready",values:{subagentCatalog:values.map(([id,createdAt])=>({id,createdAt,mode:"continuable"}))}};};
  return {render,click,labels,buttons,entries,statuses,saved,nav,summaries,loads,seats};
}

test("header action shadows the native catalog entry instead of adding a second trigger",()=>{
  const {actions,lineage}=desktop().seats;
  assert.equal(actions.o.id,"subagent-catalog");
  assert.ok(actions.o.priority<0);
  assert.ok(lineage.o.priority<0);
});

test("running first then newest at each tree level; root and sidebar use direct-parent addresses",()=>{
  const d=desktop();
  d.entries("p",[["old",1],["busy",0],["new",2]]);
  d.entries("new",[["a",1],["b c",4],["task",0]]);
  d.statuses.set("busy",{running:true});d.summaries.task={running:true};
  d.render();d.click("3 subagents ⌄");d.render();assert.deepEqual(d.labels(),["busy","new","old"]);
  assert.equal(d.buttons().find(n=>n.text==="Archive").props.disabled,true);
  d.click("Expand children",1);d.render();assert.deepEqual(d.labels(),["busy","new","task","b c","a","old"]);
  d.click("Open in sidebar",3);
  assert.deepEqual(d.nav.at(-1),["dsh-resource://subagentchat/session/b%20c?parent=new&mode=continuable",{kind:"subagentchat",preferNewPane:true}]);
  d.render();d.click("3 subagents ⌄");d.render();d.click("oldIdle");
  assert.deepEqual(d.nav.at(-1),{parentSessionId:"p",childSessionId:"old",mode:"continuable"});
});

test("archive, restore, bulk archive, collapsed by default on reopen; resumed tasks stay visible",()=>{
  const d=desktop();d.entries("p",[["old",0],["busy",1],["new",4]]);d.statuses.set("busy",{running:true});
  d.render();d.click("3 subagents ⌄");d.render();d.click("Archive",1);
  assert.match(d.render(),/2 \/ 3 subagents/);assert.deepEqual(d.labels(),["busy","old"]);
  d.click("▸ Archived (1)");d.render();assert.deepEqual(d.labels(),["busy","old","new"]);
  d.click("Unarchive");d.render();assert.deepEqual(d.saved.get("p"),[]);
  d.click("Archive finished");d.render();assert.deepEqual(d.saved.get("p"),["new","old"]);
  d.statuses.set("old",{running:true});d.render();
  assert.deepEqual(d.labels().slice(0,2),["busy","old"]);
  d.click("2 / 3 subagents ⌄");d.render();d.click("2 / 3 subagents ⌄");
  // A newly mounted dropdown must start folded and restore archives from the store.
  const fresh=desktop();fresh.saved.set("p",d.saved.get("p"));fresh.entries("p",[["old",0],["busy",1],["new",4]]);
  fresh.render();fresh.click("1 / 3 subagents ⌄");assert.match(fresh.render(),/▸ Archived \(2\)/);
  assert.deepEqual(fresh.labels(),["busy"]);assert.ok(fresh.loads.includes("p"));
});

test("child header has sibling navigation, descendant count and ancestor title navigation",()=>{
  const d=desktop();d.entries("p",[["child",1],["peer",3]]);d.entries("child",[["nested",1]]);
  d.summaries.child={origin:"subagent",parentId:"p"};
  assert.equal(d.render("actions",{sessionId:"child"}),"");
  const props={lineageSessionId:"child",displayTitle:"Title"};
  assert.match(d.render("lineage",props),/child ⌄1 subagent/);
  d.click("child ⌄");d.render("lineage",props);d.click("peerIdle");
  assert.deepEqual(d.nav.at(-1),{parentSessionId:"p",childSessionId:"peer",mode:"continuable"});
  let opened=0;
  d.render("lineage",{...props,openTitle:()=>opened++});d.click("child");assert.equal(opened,1);
});
