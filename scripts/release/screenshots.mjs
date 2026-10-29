import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const input = process.env.ARTIFACT_DIR || 'dist/browser';
const font = (await readFile('fonts/AlibabaPuHuiTi-3-55-Regular.subset.woff2')).toString('base64');
const shots = [
  ['01-start','home','选好页面，开始记录','打开插件，选择要记录的页面。<br>可以只选当前页，也可以选多个页面。'],
  ['02-recording','recording','出现问题时，点一下标记','插件会记录操作、请求和报错。<br>遇到问题时，可以添加标记和说明。'],
  ['03-review-export','review','检查一下，再导出','补充问题说明，检查有没有敏感内容。<br>选好附件后导出 ZIP，发给需要排查的人。'],
];
await mkdir('dist/release/screenshots',{recursive:true});
const browser = await chromium.launch({headless:true,channel:'chromium'});
try {
  const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  for (const [name,image,title,description] of shots) {
    const bytes = await readFile(`${input}/${image}.png`);
    const wide = image==='review';
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      @font-face{font-family:Product;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}
      body{margin:0;width:1280px;height:800px;background:#0b0d12;color:#f3f4f6;font-family:Product, sans-serif;padding:44px 56px;overflow:hidden}
      header{color:#fb617b;font-size:20px;letter-spacing:2px}main{display:flex;align-items:center;justify-content:space-between;height:640px;gap:48px}
      h1{font-size:42px;line-height:1.4;font-weight:normal;margin:0 0 22px}p{font-size:22px;line-height:1.8;color:#b7bac5;margin:0}
      img{display:block;max-height:610px;max-width:510px;object-fit:contain;border:1px solid #363944;border-radius:16px}
      footer{color:#888d9d;font-size:14px;position:absolute;bottom:28px;left:56px}
      .wide main{display:block;padding-top:20px}.wide h1{font-size:32px;margin:0 0 8px}.wide p{font-size:18px}.wide img{margin:18px auto 0;max-width:1080px;max-height:480px;border-radius:10px}
      </style><body class="${wide?'wide':''}"><header>EPIC RECAP</header><main><section><h1>${title}</h1><p>${description}</p></section><img src="data:image/png;base64,${bytes.toString('base64')}"></main><footer>测试页面演示 · 发布前请检查文字和画面</footer></body></html>`;
    await page.setContent(html); await page.evaluate(()=>document.fonts.ready);
    await page.locator('img').evaluate(img=>img.decode());
    await page.screenshot({path:`dist/release/screenshots/${name}.jpg`,type:'jpeg',quality:95});
  }
} finally {await browser.close();}
await writeFile('dist/release/screenshots/README.txt','1280×800 JPEG。来自本次浏览器测试的真实插件界面和演示数据，作为候选素材。商店原有三张 Figma 设计图不会自动被替换；更新截图需要预览后在商店后台上传。\n');
