window.__ModuleLoader__.load({
  id: "dsh-plugin-wechat",
  chunk: "client.subagent-cache.js",
  factory: () => {
    const prefix = "dsh-plugin-wechat:subagent-archive:v1:";
    const empty = Object.freeze([]);
    const valid = ids => Array.isArray(ids) && ids.every(id => typeof id === "string");
    const key = parent => prefix + parent;
    function read(parent) {
      try {
        const raw = window.localStorage.getItem(key(parent));
        if (raw === null) return { ids: [], add: [], remove: [] };
        const data = JSON.parse(raw);
        if (valid(data.ids) && valid(data.add) && valid(data.remove)) return data;
      } catch { /* Storage may be blocked, full, or corrupt. */ }
      return null;
    }

    function createArchiveCache(remote) {
      const parents = new Map();
      let disposed = false;
      function publish(s, persist) {
        const ids = new Set(s.base);
        for (const [id, archived] of s.dirty) {
          if (archived) ids.add(id);
          else ids.delete(id);
        }
        if (persist) {
          const add = [], remove = [];
          for (const [id, archived] of s.dirty) (archived ? add : remove).push(id);
          try {
            window.localStorage.setItem(key(s.parent), JSON.stringify({ ids: [...s.base], add, remove }));
          } catch { /* In-memory state and RPC still work. */ }
        }
        if (ids.size === s.snapshot.length && s.snapshot.every(id => ids.has(id))) return;
        s.snapshot = Object.freeze([...ids].sort());
        for (const fn of [...s.listeners]) fn();
      }
      function restore(s, data) {
        if (!data) return;
        s.base = new Set(data.ids);
        s.dirty = new Map(data.add.map(id => [id, true]));
        for (const id of data.remove) s.dirty.set(id, false);
        for (const [id, archived] of s.local) s.dirty.set(id, archived);
        publish(s, false);
      }
      function state(parent) {
        if (!parents.has(parent)) {
          const s = { parent, base: new Set(), local: new Map(), dirty: new Map(), snapshot: empty,
            listeners: new Set(), tail: Promise.resolve(), revision: 0, reading: null };
          parents.set(parent, s);
          restore(s, read(parent));
        }
        return parents.get(parent);
      }
      function onStorage(event) {
        if (event.key !== null && !event.key.startsWith(prefix)) return;
        const affected = event.key === null ? parents.values() : [parents.get(event.key.slice(prefix.length))];
        for (const s of affected) if (s) {
          // Read current storage: older queued events can arrive after a newer write.
          s.revision++;
          restore(s, read(s.parent));
        }
      }
      window.addEventListener?.("storage", onStorage);

      function flush(s) {
        const run = async () => {
          if (disposed || !s.dirty.size) return s.snapshot;
          const sent = new Map(s.dirty);
          const add = [], remove = [];
          for (const [id, archived] of sent) (archived ? add : remove).push(id);
          const revision = s.revision;
          const result = await remote.updateArchivedChildren(s.parent, JSON.stringify(add), JSON.stringify(remove));
          if (disposed) return s.snapshot;
          if (!valid(result?.ids)) throw new TypeError("Invalid archived children response");
          if (s.revision === revision) s.base = new Set(result.ids);
          else {
            // Another tab supplied a newer baseline. Only apply our acknowledged delta.
            for (const [id, archived] of sent) archived ? s.base.add(id) : s.base.delete(id);
          }
          s.revision++;
          for (const [id, archived] of sent) {
            if (s.dirty.get(id) === archived) s.dirty.delete(id);
            if (s.local.get(id) === archived) s.local.delete(id);
          }
          publish(s, true);
          return s.snapshot;
        };
        const job = s.tail.then(run);
        s.tail = job.catch(() => {}); // Failed deltas stay dirty for the next load/update.
        return job;
      }
      return {
        getSnapshot: parent => state(parent).snapshot,
        subscribe(parent, fn) {
          const listeners = state(parent).listeners;
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        load(parent) {
          const s = state(parent);
          if (s.reading) return s.reading;
          const revision = s.revision;
          s.reading = Promise.resolve().then(() => remote.archivedChildren(parent)).then(result => {
            if (disposed) return s.snapshot;
            if (!valid(result?.ids)) throw new TypeError("Invalid archived children response");
            if (s.revision === revision) {
              s.base = new Set(result.ids);
              publish(s, true);
            }
            return s.dirty.size ? flush(s) : s.snapshot;
          }).finally(() => { s.reading = null; });
          return s.reading;
        },
        update(parent, add, remove) {
          const s = state(parent);
          for (const id of add) { s.local.set(id, true); s.dirty.set(id, true); }
          for (const id of remove) { s.local.set(id, false); s.dirty.set(id, false); }
          publish(s, true);
          return flush(s);
        },
        dispose() {
          disposed = true;
          window.removeEventListener?.("storage", onStorage);
          for (const s of parents.values()) s.listeners.clear();
        },
      };
    }
    return { createArchiveCache };
  },
});
