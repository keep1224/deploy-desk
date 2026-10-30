const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  profiles: {
    list: () => ipcRenderer.invoke('profile:list'),
    save: (payload) => ipcRenderer.invoke('profile:save', payload),
    remove: (id) => ipcRenderer.invoke('profile:delete', id),
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
  },
  web: {
    upload: (payload) => ipcRenderer.invoke('web:upload', payload),
  },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
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
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onLog: (fn) => ipcRenderer.on('log', (_e, msg) => fn(msg)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, msg) => fn(msg)),
});
