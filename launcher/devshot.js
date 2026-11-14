// dev only: LAC_UISHOT=<outdir> electron .   -> screenshots of every page (plus the page's console output), then quits
const { app } = require("electron");
const fs = require("fs"), path = require("path");
module.exports = (w, out) => {
  fs.mkdirSync(out, { recursive: true });
  const log = (s) => fs.appendFileSync(path.join(out, "console.txt"), s + "\n");
  w.webContents.on("console-message", (_e, level, msg, line) => log(`[${level}] ${msg} (line ${line})`));
  w.webContents.once("did-finish-load", async () => {
    const js = (c) => w.webContents.executeJavaScript(c), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 0;
    globalThis.__rot = async () => { await sleep(2500); fs.writeFileSync(path.join(out, "hero_front.png"), (await w.webContents.capturePage()).toPNG()); await js("heroView && (heroView.yaw = 2.4, heroView.draw())"); await sleep(500); fs.writeFileSync(path.join(out, "hero_turned.png"), (await w.webContents.capturePage()).toPNG()); log("yaw after wait => " + await js("heroView && heroView.yaw"));
      await js("heroView.yaw = 0; heroView.pitch = 0; heroView.draw()"); await sleep(400); fs.writeFileSync(path.join(out, "hero_y0.png"), (await w.webContents.capturePage()).toPNG());
      await js("heroView.yaw = Math.PI; heroView.draw()"); await sleep(400); fs.writeFileSync(path.join(out, "hero_y180.png"), (await w.webContents.capturePage()).toPNG());
      await js("me = { coins: 120, equipped: ['cape_dev_code', 'wings_dragon', 'halo_flame', 'hat_wizard', 'boots_lavaboots', 'buddy_dog'], chroma: {}, owned: [], advances: [], tag: {}, name: {}, plus: false, pro: false, dev: true }; eqStrips(); heroView.yaw = 3.4; heroView.pitch = 0.05; heroView.draw()"); await sleep(1200); log("cape state => " + await js("JSON.stringify({yaw: heroView.yaw, cape: heroView.capeOn, f: heroView.capeFor, ok: heroView.ok, ids: me.equipped})")); await sleep(3500); log("live => " + await js("heroView.live") + " ms/frame=" + await js("(async()=>{const t=performance.now();for(let i=0;i<10;i++)await lac.meshFrames([{id:'wings_dragon',variant:0},{id:'halo_flame',variant:0}],i*0.1);return (performance.now()-t)/10})()")); fs.writeFileSync(path.join(out, "hero_live_a.png"), (await w.webContents.capturePage()).toPNG()); await sleep(450); fs.writeFileSync(path.join(out, "hero_live_b.png"), (await w.webContents.capturePage()).toPNG()); fs.writeFileSync(path.join(out, "hero_cape.png"), (await w.webContents.capturePage()).toPNG());
      await js("me.equipped = ['morph_golem', 'buddy_fox']; eqStrips(); heroView.yaw = 0.5; heroView.pitch = 0.1; heroView.draw()"); await sleep(1500); fs.writeFileSync(path.join(out, "hero_morph.png"), (await w.webContents.capturePage()).toPNG()); await js("me.equipped = ['cape_dev_code', 'wings_dragon', 'buddy_dog']; eqStrips(); heroView.yaw = 0.4; heroView.draw()"); await sleep(1500); log("ext => " + await js("JSON.stringify({ext: heroView.ext, ent: heroView.entExt, hide: heroView.hidePlayer, w: heroView.cv.width, h: heroView.cv.height})")); fs.writeFileSync(path.join(out, "hero_pet.png"), (await w.webContents.capturePage()).toPNG()); await js("heroView.yaw = 0.4; heroView.draw()");
      await js("document.querySelector('nav button[data-p=mods]').click(); document.querySelector('#msearch').click()"); await sleep(4000);
      await js("document.querySelector('main').scrollTop = 500"); const before = await js("document.querySelector('main').scrollTop");
      await js("document.querySelector('#mmore') && document.querySelector('#mmore').click()"); await sleep(4000);
      log("scroll more => before " + before + " after " + await js("document.querySelector('main').scrollTop") + " hits " + await js("window._hits ? window._hits.length : -1"));
      await js("document.querySelector('nav button[data-p=shop]').click()"); await sleep(1300); fs.writeFileSync(path.join(out, "shop.png"), (await w.webContents.capturePage()).toPNG());
      log("alpha sample => " + await js("(()=>{const i=new Image();return 'n/a'})()")); };
    if (process.env.LAC_LANG) { await js(`window.setLang(\"${process.env.LAC_LANG}\")`); await sleep(200); }
    await sleep(6500);
    log("gate => " + String(await js("(document.querySelector(\"#lgate h3\")||{}).textContent + \" / \" + document.querySelector(\"nav button\").textContent")));
    fs.writeFileSync(path.join(out, "gate.png"), (await w.webContents.capturePage()).toPNG());
    await js(`document.querySelector("#glater") && document.querySelector("#glater").click()`); await sleep(900);
    if (process.env.LAC_KPAL) {   // Ctrl+K palette check
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))`); await js(`document.querySelector("#kq").value = "dra"; document.querySelector("#kq").dispatchEvent(new Event("input"))`); await sleep(300);
      fs.writeFileSync(path.join(out, "kpal.png"), (await w.webContents.capturePage()).toPNG()); log("kpal rows => " + await js(`document.querySelectorAll("#kr .kri").length`)); return app.quit();
    }
    if (process.env.LAC_CAPE) {   // the cape from behind and from the side
      await js("me = { coins: 1, equipped: ['cape_dev_code'], chroma: {}, owned: [], advances: [], tag: {}, name: {}, plus: false, pro: false, dev: true }; eqStrips(); heroView.pitch = 0.05"); await sleep(2500);
      for (const [n, yaw] of [["back", 3.14], ["side", 4.7], ["three", 3.9]]) { await js(`heroView.yaw = ${yaw}; heroView.draw()`); await sleep(500); fs.writeFileSync(path.join(out, "cape_" + n + ".png"), (await w.webContents.capturePage()).toPNG()); }
      return app.quit();
    }
    if (process.env.LAC_THUMBS) {   // the game menu's grid pictures: every model cosmetic alone on a transparent background, 192x144 (see mod/.../textures/gui/cos)
      const { nativeImage } = require("electron"), dest = process.env.LAC_THUMBS;
      const ids = await js(`cat.items.filter((i) => MODEL_TYPES.includes(i.type)).map((i) => i.id)`);
      for (const id of ids) {
        const u = await js(`(async () => { const it = cat.items.find((x) => x.id === "${id}"); return await modelThumb(it, 0); })()`);
        if (u) fs.writeFileSync(path.join(dest, id + ".png"), nativeImage.createFromDataURL(u).resize({ width: 192, height: 144, quality: "best" }).toPNG()); else log("no thumb: " + id);
      }
      log("thumbs done: " + ids.length); return app.quit();
    }
    await globalThis.__rot();
    log("me() => " + String(await js("lac.me().then((x) => JSON.stringify(x).slice(0, 90)).catch((e) => 'ERR ' + e.message)")));
    log("status text => " + String(await js("document.querySelector('#status').textContent")));
    for (const [page, extra] of [["play", ""], ["prof", ""], ["prof", "document.querySelector('.pr .top')?.click()"], ["prof", "document.querySelector('#mdet [data-dt=\"1\"]')?.click()"], ["mods", ""], ["cos", "document.querySelectorAll('.cc')[1]?.click()"], ["bundles", ""], ["style", ""], ["plus", ""], ["dl", ""], ["skins", ""], ["friends", ""], ["shots", ""]]) {
      await js(`document.querySelector('nav button[data-p="${page}"]').click()`);
      if (extra) await js(extra);
      await sleep(1600);
      fs.writeFileSync(path.join(out, page + (page === "prof" ? "_" + (++n) : "") + ".png"), (await w.webContents.capturePage()).toPNG());
    }
    if (process.env.LAC_SOLO) for (const [id, type] of process.env.LAC_SOLO.split(",").map((x) => x.split(":"))) {
      await js(`document.querySelectorAll('.modal.on,.modal.open,#mdet').forEach((m) => { m.classList.remove('on', 'open'); m.style.display = 'none'; }); document.querySelectorAll('button').forEach((b) => b.textContent.trim() === 'Schließen' && b.click())`); await js(`document.querySelector('nav button[data-p="cos"]').click(); ctype = "${type}"; picked = "${id}"; renderCos()`); await sleep(7000);
      for (const yaw of [0, 1.2, 2.4]) { await js(`soloV.yaw = Math.PI - 0.5 + ${yaw}; soloV.pitch = 0.12; soloV.draw()`); await sleep(500); fs.writeFileSync(path.join(out, `solo_${id}_${yaw}.png`), (await w.webContents.capturePage()).toPNG()); }
    }
    app.quit();
  });
};
