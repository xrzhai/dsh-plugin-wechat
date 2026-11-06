window.__ModuleLoader__.load({
  id: "dsh-plugin-wechat",
  chunk: "client.subagent.js",
  factory: (require) => {
    const R = require("react"), h = R.createElement;
    const {createPortal} = require("react-dom");
    const ns = "weixinSubagentCatalog";
    const CATALOG = {
      zh: {one: "{n} 个子智能体", count: "{n} 个子智能体", bulk: "归档已完成", archived: "已归档 ({n})", archive: "归档", restore: "取消归档", aside: "在侧边栏打开", running: "运行中", idle: "空闲", done: "已完成", retry: "重试", loading: "加载中…", sync: "归档暂未同步到电脑", expand: "展开子智能体", collapse: "收起子智能体", menu: "切换子智能体", error: "会话列表加载失败", migration: "打开会话以迁移", external: "外部子智能体"},
      en: {one: "{n} subagent", count: "{n} subagents", bulk: "Archive finished", archived: "Archived ({n})", archive: "Archive", restore: "Unarchive", aside: "Open in sidebar", running: "Running", idle: "Idle", done: "Completed", retry: "Retry", loading: "Loading…", sync: "Archives not synced to this computer", expand: "Expand children", collapse: "Collapse children", menu: "Switch subagent", error: "Could not load sessions", migration: "Open session to migrate", external: "External subagent"}
    };
    const css = `
.wx-sa-trigger,.wx-sa-menu button { font:inherit; color:inherit; background:none; border:0; border-radius:5px; cursor:pointer; padding:3px 5px }
.wx-sa-trigger:hover,.wx-sa-menu button:not(:disabled):hover {background:var(--dsw-alias-interactive-bg-hover)}
.wx-sa-action,.wx-sa-lineage { display:inline-flex; align-items:center; min-width:0; font-size:12px }
.wx-sa-trigger {max-width:220px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis}
.wx-sa-menu {position:fixed; z-index:100; width:min(370px,calc(100vw - 16px)); max-height:min(540px,65vh); overflow:auto; box-sizing:border-box; padding:5px; border-radius:9px; background:var(--dsw-specific-menu,Canvas); color:var(--dsw-alias-label-primary); box-shadow:var(--dsw-elevation-prominent); font:12px/1.5 system-ui}
.wx-sa-toolbar {display:flex; justify-content:flex-end; border-bottom:1px solid var(--dsw-alias-border-l1)}
.wx-sa-row {display:flex; align-items:center; gap:3px; min-height:35px}
.wx-sa-branch {margin-left:12px; border-left:1px solid var(--dsw-alias-border-l2); padding-left:4px}
.wx-sa-open {flex:1; min-width:0; text-align:left}
.wx-sa-open span,.wx-sa-open small {display:block; text-overflow:ellipsis; white-space:nowrap; overflow:hidden}
.wx-sa-open small,.wx-sa-tool {color:var(--dsw-alias-label-tertiary)}
.wx-sa-menu button:disabled {opacity:.45;cursor:default}
.wx-sa-dot {display:inline-block;width:7px;height:7px;border-radius:50%;background:#899390;flex:none}
.wx-sa-dot[data-running=true] {background:#29b777}
`;
    const time = value => typeof value === "number" ? value : Date.parse(value) || 0;
    function entriesFor(snapshot, summaries, statuses) {
      return (snapshot?.values?.subagentCatalog ?? []).map(entry => ({
        ...entry,
        createdAt: entry.createdAt ?? summaries[entry.id]?.createdAt,
        running: statuses.get(entry.id)?.running ?? summaries[entry.id]?.running ?? (entry.activity === "running")
      })).sort((a,b) => Number(b.running)-Number(a.running) || time(b.createdAt)-time(a.createdAt));
    }
    function useArchives(cache, id) {
      const ids = R.useSyncExternalStore(R.useCallback(fn => cache.subscribe(id, fn), [cache,id]), () => cache.getSnapshot(id));
      const [failed,setFailed] = R.useState(false);
      const sync = fn => fn.then(() => setFailed(false), () => setFailed(true));
      R.useEffect(() => { sync(cache.load(id)); }, [cache,id]);
      return {ids, failed, retry: () => sync(cache.load(id)), update: (add,remove) => sync(cache.update(id,add,remove))};
    }
    function button(text, props) { return h("button", {type:"button", ...props}, text); }
    function Nested(props) {
      const archives = useArchives(props.cache, props.id);
      return h(Branch,{...props,archives});
    }
    function Branch(props) {
      const {id, projections, summaries, statuses, archives, current, t, path, close, openChild, openAside, refresh} = props;
      const [fold,setFold] = R.useState(false), [expanded,setExpanded] = R.useState(() => new Set());
      const snapshot = projections[id], entries = entriesFor(snapshot,summaries,statuses);
      // A resumed agent must become visible immediately, even if it was archived when idle.
      const hidden = new Set(archives.ids);
      const visible = entries.filter(e => e.running || !hidden.has(e.id));
      const archived = entries.filter(e => !e.running && hidden.has(e.id));
      const eligible = visible.filter(e => !e.running).map(e => e.id);
      function row(e, isArchived) {
        const dest = {parentSessionId:id, childSessionId:e.id, mode:e.mode};
        const summary = summaries[e.id], child = projections[e.id];
        const external = e.mode === "external", migrate = summary?.formatStatus === "migration-required" || child?.state === "migration-required";
        const expandable = !external && !migrate && !path.includes(e.id) && !(child?.values?.subagentCatalog?.length === 0 && ["idle","ready"].includes(child.state));
        const show = expandable && expanded.has(e.id);
        const label = e.label ?? e.id;
        const activity = t(external ? "external" : e.running ? "running" : summary?.projectionValues?.subagentTiming?.lastTurnCompleted ? "done" : "idle");
        const usage = summary?.projectionValues?.tokenUsage;
        const tokens = usage && ["uncachedInputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"].reduce((n,k) => n + (usage[k] ?? 0),0);
        const timing = summary?.projectionValues?.subagentTiming;
        const active = timing?.active;
        const ms = (timing?.settledMs ?? 0) + (active ? Math.max(0,(e.running ? Date.now() : active.through)-active.since) : 0);
        const seconds = Math.floor(ms / 1000);
        const duration = ms > 0 && Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
        const detail = [summary?.title,activity,migrate && t("migration"),tokens && tokens.toLocaleString()+" tokens",duration].filter(Boolean).join(" · ");
        return h("div",{key:e.id},
          h("div",{className:"wx-sa-row"},
            expandable ? button(show ? "▾":"▸",{"aria-expanded":show,"aria-label":t(show?"collapse":"expand"),onClick:()=>{
              setExpanded(old => {const next=new Set(old); if(show) next.delete(e.id); else next.add(e.id); return next;});
              if(!show) refresh(e.id);
            }}) : h("span",{style:{width:18}}),
            h("i",{className:"wx-sa-dot","data-running":e.running,title:activity}),
            button([h("span",{key:"label"},label),h("small",{key:"detail"},detail)],{className:"wx-sa-open",disabled:external,"aria-current":current===e.id || undefined,title:detail,onClick:()=>{openChild(dest);close();}}),
            button(t(isArchived?"restore":"archive"),{className:"wx-sa-tool",disabled:e.running,onClick:()=>isArchived ? archives.update([], [e.id]) : archives.update([e.id], [])}),
            button("›",{disabled:external,title:t("aside"),"aria-label":t("aside"),onClick:()=>{openAside(dest);close();}})),
          show && h("div",{className:"wx-sa-branch"},h(Nested,{...props,id:e.id,path:[...path,e.id]})));
      }
      return h(R.Fragment,null,
        path.length===1 && h("div",{className:"wx-sa-toolbar"},button(t("bulk"),{disabled:!eligible.length,onClick:()=>archives.update(eligible,[])})),
        archives.failed && h("div",{role:"status"},t("sync"),button(t("retry"),{onClick:archives.retry})),
        snapshot?.state==="error" ? h("div",{role:"status"},snapshot.error?.message || t("error"),button(t("retry"),{onClick:()=>refresh(id)})) :
          !snapshot?.values?.subagentCatalog && h("div",{role:"status"},t("loading")),
        visible.map(e => row(e,false)),
        archived.length > 0 && button((fold?"▾ ":"▸ ")+t("archived",{n:archived.length}),{"aria-expanded":fold,onClick:()=>setFold(!fold)}),
        fold && archived.map(e => row(e,true)));
    }
    function Dropdown(props) {
      const {id,current,displayTitle,openTitle,useSessions,useSessionStatus,cache,t,action} = props;
      const projections=useSessions(s=>s.projectionsBySession), summaries=useSessions(s=>s.byId), statuses=useSessionStatus(s=>s);
      const archives=useArchives(cache,id), entries=entriesFor(projections[id],summaries,statuses);
      const count=entries.filter(e=>e.running || !archives.ids.includes(e.id)).length;
      const [pos,setPos]=R.useState(null);
      const root=R.useRef(null), panel=R.useRef(null), trigger=R.useRef(null);
      const place=()=>{const r=root.current?.getBoundingClientRect(); if(r) setPos({left:Math.max(8,Math.min(r.left,window.innerWidth-378)),top:r.bottom+4,maxHeight:Math.max(48,window.innerHeight-r.bottom-12)});};
      const close=()=>setPos(null);
      const visible=!!current || entries.length>0 || projections[id]?.state==="error";
      R.useEffect(()=>{if(!pos || !visible) return;
        panel.current?.querySelector("button:not(:disabled)")?.focus();
        const outside=e=>{if(!root.current?.contains(e.target) && !panel.current?.contains(e.target)) close();};
        const reposition=e=>{if(!panel.current?.contains(e.target)) place();};
        document.addEventListener("pointerdown",outside); document.addEventListener("scroll",reposition,true);window.addEventListener("resize",place);
        return ()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("scroll",reposition,true);window.removeEventListener("resize",place);};
      },[!!pos,visible]);
      if(!visible) return null;
      const activeEntry = current && entries.find(e=>e.id===current);
      const title=current ? activeEntry?.label ?? activeEntry?.id ?? displayTitle ?? current : t(entries.length===1?"one":"count",{n:count===entries.length?count:count+" / "+entries.length});
      const toggle=()=>{if(pos) close();else {place();props.refresh(id);}};
      return h("span",{className:action?"wx-sa-action":"wx-sa-lineage",ref:root},
        !current && entries.some(e=>e.running) && h("i",{className:"wx-sa-dot","data-running":true,title:t("running")}),
        openTitle && button(title,{className:"wx-sa-trigger",onClick:openTitle}),
        button(openTitle ? "⌄" : title+" ⌄",{className:"wx-sa-trigger",ref:trigger,"aria-expanded":!!pos,"aria-haspopup":"dialog","aria-label":openTitle?t("menu"):undefined,onClick:toggle,onKeyDown:e=>{if(e.key==="ArrowDown"){e.preventDefault();if(!pos)toggle();}}}),
        pos && createPortal(h("div",{role:"dialog","aria-label":t("menu"),className:"wx-sa-menu",style:pos,ref:panel,onKeyDown:e=>{
          if(e.key==="Escape"){e.preventDefault();close();trigger.current?.focus();}
          if(["ArrowDown","ArrowUp","Home","End"].includes(e.key)){e.preventDefault();const buttons=[...panel.current.querySelectorAll("button:not(:disabled)")]; const i=buttons.indexOf(document.activeElement); buttons[e.key==="Home"?0:e.key==="End"?buttons.length-1:(i+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();}
        }},h(Branch,{...props,archives,projections,summaries,statuses,path:[id],close})),document.body));
    }
    function Action(p) {
      const child=p.useSessions(s=>s.byId[p.sessionId]?.origin==="subagent");
      return child ? null : h(Dropdown,{...p,key:p.sessionId,id:p.sessionId,action:true});
    }
    function Lineage(p) {
      const id=p.lineageSessionId, address=p.useSession(s=>s.subagent?.address);
      const parent=p.useSessions(s=>{
        if(address?.childSessionId===id) return address.parentSessionId;
        for(const [parent,snap] of Object.entries(s.projectionsBySession)) if(snap.values?.subagentCatalog?.some(e=>e.id===id)) return parent;
        return s.byId[id]?.origin==="subagent" ? s.byId[id].parentId : undefined;
      });
      if(!parent) return null;
      return h(R.Fragment,null,h(Dropdown,{...p,key:"s:"+id,id:parent,current:id}),!p.openTitle && h(Dropdown,{...p,key:"c:"+id,id}));
    }
    function registerSubagentMenu(ctx, cache) {
      ctx.effect(()=>ctx.locale.register(ns,CATALOG));
      ctx.effect(()=>{const tag=document.createElement("style");tag.textContent=css;document.head.appendChild(tag);return ()=>tag.remove();});
      const inject=()=>({cache,openChild:a=>ctx.uiWorkspace.openSession(a),
        openAside:a=>ctx.sidebarRight.openResource("dsh-resource://subagentchat/session/"+encodeURIComponent(a.childSessionId)+"?"+new URLSearchParams({parent:a.parentSessionId,mode:a.mode}),{kind:"subagentchat",preferNewPane:true}),
        refresh:id=>ctx.sessions.refreshProjections(id)});
      // DSH renders the lowest priority for each list entry ID (and for single slots).
      for(const [seat,component,options] of [["actions",Action,{id:"subagent-catalog",order:10}],["lineage",Lineage,{}]]){
        const name="conversation.session.header."+seat;
        ctx.slots.inject(name,()=>ctx.slots.register({name,priority:-10,locale:ns,inject,...options},component));
      }
    }
    return {registerSubagentMenu};
  }
});
