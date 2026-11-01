const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  profiles: {
    list: () => ipcRenderer.invoke('profile:list'),
    save: (payload) => ipcRenderer.invoke('profile:save', payload),
    remove: (id) => ipcRenderer.invoke('profile:delete', id),
    reveal: (payload) => ipcRenderer.invoke('profile:reveal', payload),
  },
  settings: {
    save: (payload) => ipcRenderer.invoke('settings:save', payload),
  },
  server: {
    test: (id) => ipcRenderer.invoke('server:test', id),
    probe: (id) => ipcRenderer.invoke('server:probe', id),
  },
  conf: {
    load: (id) => ipcRenderer.invoke('conf:load', id),
    save: (payload) => ipcRenderer.invoke('conf:save', payload),
    download: (id) => ipcRenderer.invoke('conf:download', id),
    remote: (id) => ipcRenderer.invoke('conf:remote', id),
    apply: (payload) => ipcRenderer.invoke('conf:apply', payload),
    pickFile: () => ipcRenderer.invoke('conf:pickFile'),
    saveAs: (text) => ipcRenderer.invoke('conf:saveAs', text),
  },
  nginx: {
    show: (id) => ipcRenderer.invoke('nginx:show', id),
  },
  db: {
    list: (id) => ipcRenderer.invoke('db:list', id),
    run: (payload) => ipcRenderer.invoke('db:run', payload),
    importSql: (payload) => ipcRenderer.invoke('db:import', payload),
  },
  deploy: {
    push: (payload) => ipcRenderer.invoke('deploy:push', payload),
    inspect: (repoDir) => ipcRenderer.invoke('git:inspect', repoDir),
  },
  web: {
    upload: (payload) => ipcRenderer.invoke('web:upload', payload),
  },
  project: {
    remove: (payload) => ipcRenderer.invoke('project:remove', payload),
    service: (payload) => ipcRenderer.invoke('project:service', payload),
    site: (payload) => ipcRenderer.invoke('project:site', payload),
  },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  clip: { write: (text) => ipcRenderer.invoke('clip:write', text) },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
  },
  guide: {
    open: () => ipcRenderer.invoke('guide:open'),
  },
  onLog: (fn) => ipcRenderer.on('log', (_e, msg) => fn(msg)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, msg) => fn(msg)),
});
