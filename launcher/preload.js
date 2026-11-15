const { contextBridge, ipcRenderer } = require("electron");
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld("lac", {
  winMin: call("win:min"), winMax: call("win:max"), winClose: call("win:close"), user: call("user"), login: call("login"), loginDevice: call("login:device"), loginCancel: call("login:cancel"), onLoginCode: (f) => ipcRenderer.on("login:code", (_e, c) => f(c)), logout: call("logout"),
  catalog: call("store:catalog"), me: call("store:me"), redeem: call("store:redeem"), cancel: call("store:cancel"), cancelPro: call("store:cancelpro"), toFree: call("store:tofree"),
  buy: call("store:buy"), equip: call("store:equip"), unequip: call("store:unequip"), setTag: call("store:tag"), chatPalette: call("store:chatpal"), setChatColor: call("store:chatcolor"), setName: call("store:name"), setHalo: call("store:halo"), setUiFont: call("store:uifont"), setAdjust: call("store:adjust"),
  versions: call("versions"), profiles: call("profiles"), saveProfile: call("profile:save"), deleteProfile: call("profile:delete"),
  searchMods: call("mods:search"), addMod: call("mods:add"), removeMod: call("mods:remove"),
  sysRam: call("sys:ram"), shareCode: call("share:code"), importCode: call("share:import-code"), shareZip: call("share:zip"), importZip: call("share:import-zip"),
  installPreset: call("preset:install"), searchPacks: call("pack:search"), installPack: call("pack:install"), checkPack: call("pack:check"), updatePack: call("pack:update"), checkUpdate: call("update:check"), packsUpdates: call("packs:updates"), packsUpdate: call("packs:update"), packsList: call("packs:list"), packsInstall: call("packs:install"), packsPublish: call("packs:publish"), packsRemove: call("packs:remove"), sysRoot: call("sys:root"), profileIcon: call("profile:icon"), openFolder: call("profile:folder"), checkPack: call("pack:check"), updatePack: call("pack:update"), checkUpdate: call("update:check"),
  skinProfile: call("skin:profile"), skinLib: call("skin:lib"), skinByUuid: call("skin:byuuid"), contentSearch: call("content:search"), contentAdd: call("content:add"), meshGet: call("mesh:get"), entityGet: call("entity:get"), meshFrames: call("mesh:frames"), skinAdd: call("skin:add"), skinFromName: call("skin:fromname"), skinFromAccount: call("skin:fromaccount"), skinRemove: call("skin:remove"), skinRename: call("skin:rename"), skinApply: call("skin:apply"), skinReset: call("skin:reset"), skinCape: call("skin:cape"), nameCheck: call("skin:namecheck"), nameChange: call("skin:namechange"),
  shots: call("shots:list"), shotShare: call("shots:share"), shotFolder: call("shots:folder"),
  profileContents: call("profile:contents"), profileToggleMod: call("profile:togglemod"),
  friends: call("friends:get"), friendStatus: call("friends:status"), friendAdd: call("friends:add"), roles: call("roles:get"), makeCodes: call("codes:make"), mcLang: call("mc:lang"), devLog: call("devlog:get"), roleSet: call("roles:set"),
  installUpdate: call("update:install"), updateState: call("update:state"), onUpdate: (f) => ipcRenderer.on("lupdate", (_e, s) => f(s)),
  getSync: call("sync:get"), setSync: call("sync:set"), readLog: call("log:read"), openLogFolder: call("log:folder"),
  launch: call("launch"), kill: call("launch:kill"), distList: call("dist:list"), distSave: call("dist:save"),
  onLaunch: (f) => ipcRenderer.on("launch", (_e, ev) => f(ev)),
});
