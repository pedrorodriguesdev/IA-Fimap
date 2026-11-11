// QA da interface com respostas controladas. Não usa inferência da IA.
const { chromium } = require('playwright-core')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../public'), artifacts = path.resolve(__dirname, '../artifacts')
const requests = []
const packet = data => `data: ${JSON.stringify(data)}\n\n`
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"online":true,"iaConfigurada":true}'); return }
    if (req.url === '/v1/ia/chat-publico' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk
      const data = JSON.parse(body); requests.push(data.messages)
      const text = data.messages.at(-1).content
      if (text === 'falha') { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"mensagem":"Falha de teste"}'); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
      if (text === 'lenta') {
        res.write(packet({ tipo: 'trecho', conteudo: 'Resposta parcial de teste' }))
        const timer = setInterval(() => res.write(': aguardando\n\n'), 1000)
        res.on('close', () => clearInterval(timer)); return
      }
      if (text === 'vazia') { res.end(packet({ tipo: 'fim' })); return }
      if (text === 'incompleta') { res.end(packet({ tipo: 'trecho', conteudo: 'Texto parcial' })); return }
      const answer = text.includes('5000') ? 'Com renda de **R$ 5.000** e despesas de **R$ 3.200**, restam **R$ 1.800**.\n\nPodemos planejar uma reserva.' : 'Sua conversa continua. Vamos organizar seu próximo passo.'
      const result = packet({ tipo: 'trecho', conteudo: answer.slice(0, 15) }) + packet({ tipo: 'trecho', conteudo: answer.slice(15) }) + packet({ tipo: 'fim' })
      // Divide intencionalmente um evento em dois pacotes.
      res.write(result.slice(0, 18)); setTimeout(() => res.end(result.slice(18)), 30); return
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://test').pathname)
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(root + path.sep) || pathname.toLowerCase() === '/pluggy.html') { res.writeHead(404); res.end(); return }
    const content = await fs.readFile(file)
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream')
    res.end(content)
  } catch { res.writeHead(404); res.end() }
})
async function run() {
  let browser
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fs.mkdir(artifacts, { recursive: true })
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : { channel: 'msedge' }) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.connection.online')
    await page.screenshot({ path: path.join(artifacts, 'chat-desktop.png'), fullPage: true })
    assert.match(await page.title(), /Fimap AI/)
    await page.locator('#sobre').click(); assert.equal(await page.locator('dialog').evaluate(el => el.open), true)
    await page.keyboard.press('Escape')
    const ask = async text => { await page.locator('#mensagem').fill(text); await page.locator('#enviar').click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled) }
    await ask('Minha renda é 5000 e gasto 3200. Quanto sobra?')
    assert.match(await page.locator('.assistant .bubble').last().innerText(), /1.800/)
    assert.equal(await page.locator('.assistant .bubble strong').count(), 3)
    const downloadPromise = page.waitForEvent('download'); await page.locator('#exportar').click()
    const download = await downloadPromise; assert.match(download.suggestedFilename(), /^fimap-conversa-/)
    await ask('Continue o planejamento')
    assert.equal(requests.at(-1).length, 3)
    await page.locator('#mensagem').fill('lenta'); await page.locator('#enviar').click()
    await page.waitForFunction(() => document.querySelector('.assistant:last-child .bubble')?.textContent.includes('Resposta parcial'))
    await page.locator('#parar').click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    assert.match(await page.locator('.message-state').last().innerText(), /interrompida por você/)
    await ask('Após cancelar')
    assert.equal(requests.at(-1).length, 5)
    assert.ok(!requests.at(-1).some(item => item.content === 'lenta' || item.content.includes('Resposta parcial')))
    await ask('falha'); assert.match(await page.locator('.message-state').last().innerText(), /Falha de teste/)
    await page.locator('.message-actions button').last().click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    await ask('vazia'); assert.match(await page.locator('.message-state').last().innerText(), /vazia/)
    await ask('incompleta'); assert.match(await page.locator('.message-state').last().innerText(), /antes de concluir/)
    for (let index = 0; index < 5; index++) await ask(`Rodada ${index}`)
    assert.equal(requests.at(-1).length, 11)
    await page.evaluate(() => {
      const target = document.createElement('div'); target.id = 'render-test'; document.body.append(target)
      window.FimapRenderer.render(target, '<img src=x onerror="window.injected=true">\n\n[Perigo](javascript:alert(1))\n\n```fimap\n{"version":1,"title":"Teste","metrics":[{"label":"Valor","value":1800,"format":"BRL"}]}\n```', true)
    })
    assert.equal(await page.locator('#render-test img').count(), 0)
    assert.equal(await page.locator('#render-test .ai-metric').count(), 1)
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.equal(await page.locator('#render-test a[href^="javascript:"]').count(), 0)
    await page.locator('#render-test').evaluate(el => el.remove())
    await page.locator('#nova-conversa').click()
    assert.equal(await page.locator('.message-block').count(), 0)
    assert.equal(await page.locator('#boas-vindas').isVisible(), true)
    await page.locator('.suggestion').first().click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    assert.equal(requests.at(-1).length, 1)
    await page.locator('#nova-conversa').click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(artifacts, 'chat-mobile.png'), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await ask('Pergunta no celular')
    assert.match(await page.locator('.assistant .bubble').last().innerText(), /Sua conversa continua/)
    await page.screenshot({ path: path.join(artifacts, 'chat-mobile-response.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS: desktop, celular, Markdown, cartões, XSS, histórico, limites de contexto, cancelamento, erros, nova tentativa, exportação, sugestões e nova conversa.')
    console.log(`Capturas: ${artifacts}`)
    if (process.argv[2]) {
      page.setDefaultTimeout(45000)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(process.argv[2], { waitUntil: 'networkidle' })
      await page.waitForSelector('.connection.online')
      await ask('Explique em duas frases o que é uma reserva de emergência.')
      assert.equal(await page.locator('.message-state').count(), 0)
      assert.ok((await page.locator('.assistant .bubble').last().innerText()).length > 30)
      await page.screenshot({ path: path.join(artifacts, 'chat-production.png'), fullPage: true })
      console.log('PASS: pergunta real respondida na interface publicada.')
    }
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
