// Permite uma pergunta por IP a cada cinco segundos.
const intervaloEntrePerguntasMs = 5000
const ultimaPerguntaPorIp = new Map()
let ultimaLimpeza = Date.now()
const limitarUsoPublico = (req, res, next) => {
    const agora = Date.now()
    const ip = req.ip || req.socket.remoteAddress || 'desconhecido'
    const ultimaPergunta = ultimaPerguntaPorIp.get(ip)
    if (agora - ultimaLimpeza > 60000) {
        for (const [chave, horario] of ultimaPerguntaPorIp) {
            if (agora - horario >= 60000) ultimaPerguntaPorIp.delete(chave)
        }
        ultimaLimpeza = agora
    }
    if (ultimaPergunta && agora - ultimaPergunta < intervaloEntrePerguntasMs) {
        const segundos = Math.ceil((intervaloEntrePerguntasMs - (agora - ultimaPergunta)) / 1000)
        res.set('Retry-After', String(segundos))
        return res.status(429).json({ mensagem: `Aguarde ${segundos} segundo(s) antes de enviar outra pergunta.` })
    }
    ultimaPerguntaPorIp.set(ip, agora)
    res.once('close', () => {
        if (!res.writableEnded && ultimaPerguntaPorIp.get(ip) === agora) ultimaPerguntaPorIp.delete(ip)
    })
    return next()
}

app.get("/health", (req, res) => res.status(200).json({ online: true, servico: "fimap-api" }))