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
    load: () => ipcRenderer.invoke('conf:load'),
    save: (text) => ipcRenderer.invoke('conf:save', text),
    download: (id) => ipcRenderer.invoke('conf:download', id),
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
