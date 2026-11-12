// QA da tela e do chat. Com uma URL, verifica apenas a versão publicada e usa IA real.
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
      // Divide um evento entre dois pacotes para verificar o streaming.
      res.write(result.slice(0, 18)); setTimeout(() => res.end(result.slice(18)), 30); return
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://test').pathname)
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!file.startsWith(root + path.sep) || pathname.toLowerCase() === '/pluggy.html') { res.writeHead(404); res.end(); return }
    const content = await fs.readFile(file)
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream')
    res.end(content)
  } catch { res.writeHead(404); res.end() }
})
async function run() {
  let browser
  const liveUrl = process.argv[2]
  if (!liveUrl) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fs.mkdir(artifacts, { recursive: true })
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : { channel: 'msedge' }) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 })
    const page = await context.newPage(), errors = []
    page.setDefaultTimeout(liveUrl ? 60000 : 15000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(liveUrl || `http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#mensagem')
    assert.match(await page.title(), /Fimap AI/)
    const ask = async text => {
      await page.locator('#mensagem').fill(text)
      await page.locator('#enviar').click()
      await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    }
    const fitsScreen = async () => {
      assert.equal(await page.evaluate(() => {
        const input = document.getElementById('mensagem').getBoundingClientRect()
        return document.documentElement.scrollWidth <= innerWidth && input.top >= 0 && input.bottom <= innerHeight
      }), true, 'A tela não pode ter rolagem horizontal nem esconder o campo de mensagem.')
    }
    const isEmpty = async () => {
      assert.equal(await page.locator('#conversa').innerHTML(), '')
      assert.equal(await page.locator('.history-list').innerHTML(), '')
      assert.equal(await page.locator('#mensagem').inputValue(), '')
      assert.equal(await page.locator('#enviar').isVisible(), true)
      assert.equal(await page.locator('#parar').isVisible(), false)
    }
    await isEmpty()
    if (liveUrl) {
      await page.screenshot({ path: path.join(artifacts, 'chat-production-layout.png'), fullPage: true })
      await ask('Explique em duas frases o que é uma reserva de emergência.')
      assert.equal(await page.locator('.message-state').count(), 0)
      assert.equal(await page.locator('.message-block').count(), 2)
      assert.ok((await page.locator('.assistant .bubble').last().innerText()).length > 30)
      await fitsScreen()
      await page.screenshot({ path: path.join(artifacts, 'chat-production.png'), fullPage: true })
      await page.locator('#nova-conversa').click()
      await isEmpty()
      await page.setViewportSize({ width: 390, height: 844 })
      await fitsScreen()
      await page.screenshot({ path: path.join(artifacts, 'chat-production-mobile.png'), fullPage: true })
      assert.deepEqual(errors, [])
      console.log('PASS: tela inicial vazia, pergunta real, streaming concluído e nova conversa vazia em desktop e celular.')
      return
    }
    await fitsScreen()
    await page.screenshot({ path: path.join(artifacts, 'chat-desktop.png'), fullPage: true })
    const initialUrl = page.url()
    for (const selector of ['.primary-nav .nav-item', '.history-search', '.history-title .static-icon', '.attachment-icon', '.microphone-icon', '.footer-links span']) {
      await page.locator(selector).first().click()
    }
    assert.equal(page.url(), initialUrl)
    assert.equal(requests.length, 0, 'A navegação e os controles ilustrativos não enviam pedidos.')
    await isEmpty()
    assert.equal(await page.locator('input, textarea').count(), 1)
    assert.equal(await page.locator('button:visible').count(), 2)
    await page.locator('#enviar').click()
    assert.equal(requests.length, 0, 'Mensagem vazia não deve ser enviada.')
    await ask('Minha renda é 5000 e gasto 3200. Quanto sobra?')
    assert.match(await page.locator('.assistant .bubble').last().innerText(), /1.800/)
    assert.equal(await page.locator('.assistant .bubble').last().locator('strong').count(), 3)
    assert.deepEqual(requests.at(-1), [{ role: 'user', content: 'Minha renda é 5000 e gasto 3200. Quanto sobra?' }])
    await ask('Continue o planejamento')
    assert.equal(requests.at(-1).length, 3)
    await page.locator('#mensagem').fill('lenta'); await page.locator('#enviar').click()
    await page.waitForFunction(() => document.querySelector('.assistant:last-child .bubble')?.textContent.includes('Resposta parcial'))
    await page.locator('#parar').click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    assert.match(await page.locator('.message-state').last().innerText(), /interrompida por você/)
    await ask('Após cancelar')
    assert.equal(requests.at(-1).length, 5)
    assert.ok(!requests.at(-1).some(item => item.content === 'lenta' || item.content.includes('Resposta parcial')))
    await page.locator('#mensagem').fill('Rascunho que deve ser apagado')
    await page.locator('#nova-conversa').click()
    await isEmpty()
    assert.equal(await page.locator('#mensagem').evaluate(el => el === document.activeElement), true)
    await ask('Primeira pergunta do novo chat')
    assert.deepEqual(requests.at(-1), [{ role: 'user', content: 'Primeira pergunta do novo chat' }])
    await page.locator('#mensagem').fill('lenta'); await page.locator('#enviar').click()
    await page.waitForFunction(() => document.querySelector('.assistant:last-child .bubble')?.textContent.includes('Resposta parcial'))
    await page.locator('#nova-conversa').click()
    await isEmpty()
    await ask('Novo chat após cancelar o anterior')
    assert.deepEqual(requests.at(-1), [{ role: 'user', content: 'Novo chat após cancelar o anterior' }])
    assert.equal(await page.locator('.message-block').count(), 2)
    assert.equal(await page.locator('.message-state').count(), 0)
    await ask('falha'); assert.match(await page.locator('.message-state').last().innerText(), /Falha de teste/)
    await page.locator('.message-actions button').last().click(); await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    await ask('vazia'); assert.match(await page.locator('.message-state').last().innerText(), /vazia/)
    await ask('incompleta'); assert.match(await page.locator('.message-state').last().innerText(), /antes de concluir/)
    for (let index = 0; index < 5; index++) await ask(`Rodada ${index}`)
    assert.equal(requests.at(-1).length, 11)
    await fitsScreen()
    await page.evaluate(() => {
      const target = document.createElement('div'); target.id = 'render-test'; document.body.append(target)
      window.FimapRenderer.render(target, '<img src=x onerror="window.injected=true">\n\n[Perigo](javascript:alert(1))\n\n```fimap\n{"version":1,"title":"Teste","metrics":[{"label":"Valor","value":1800,"format":"BRL"}]}\n```', true)
    })
    assert.equal(await page.locator('#render-test img').count(), 0)
    assert.equal(await page.locator('#render-test .ai-metric').count(), 1)
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.equal(await page.locator('#render-test a[href^="javascript:"]').count(), 0)
    await page.locator('#render-test').evaluate(el => el.remove())
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'networkidle' })
    await isEmpty()
    await fitsScreen()
    assert.equal(await page.locator('.history-panel').isVisible(), false)
    await page.screenshot({ path: path.join(artifacts, 'chat-mobile.png'), fullPage: true })
    await page.locator('#mensagem').fill('Pergunta no celular')
    await page.locator('#mensagem').press('Shift+Enter')
    await page.locator('#mensagem').pressSequentially('Com duas linhas')
    assert.match(await page.locator('#mensagem').inputValue(), /\n/)
    await page.locator('#mensagem').press('Enter')
    await page.waitForFunction(() => !document.getElementById('enviar').disabled)
    assert.match(await page.locator('.assistant .bubble').last().innerText(), /Sua conversa continua/)
    assert.equal(requests.at(-1).length, 1, 'Recarregar limpa as mensagens da sessão anterior.')
    await fitsScreen()
    await page.screenshot({ path: path.join(artifacts, 'chat-mobile-response.png'), fullPage: true })
    await page.locator('#nova-conversa').click()
    await isEmpty()
    await fitsScreen()
    assert.deepEqual(errors, [])
    console.log('PASS: início vazio, nova conversa com limpeza de contexto e cancelamento, desktop, celular, teclado, Markdown, cartões, XSS, streaming, erros e nova tentativa.')
    console.log(`Capturas: ${artifacts}`)
  } finally {
    await browser?.close()
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
