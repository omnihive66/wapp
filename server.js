import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
} from '@whiskeysockets/baileys'
import express from 'express'
import qrcode from 'qrcode'
import pino from 'pino'
import { createClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Config ──────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001
const VERCEL_URL  = (process.env.VERCEL_URL || 'https://spin-agent.vercel.app').replace(/\/$/, '')
const WEBHOOK_URL = `${VERCEL_URL}/api/webhook`
const AUTH_FOLDER = join(__dirname, 'auth_info')

// Supabase (opcional — para sessão persistente na nuvem)
const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.NEXT_PUBLIC_SUPABASE_URL  || ''
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const supabase      = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

if (!existsSync(AUTH_FOLDER)) mkdirSync(AUTH_FOLDER, { recursive: true })

// ─── Estado global ────────────────────────────────────────────────
let sock           = null
let qrCodeData     = null
let isConnected    = false
let connectedPhone = null
let reconnecting   = false

// ─── Logger silencioso ────────────────────────────────────────────
const logger = pino({ level: 'silent' })

// ─── Auth State com Supabase (persistência na nuvem) ─────────────
async function useSupabaseAuthState() {
  async function readData(key) {
    if (!supabase) return null
    try {
      const { data } = await supabase
        .from('whatsapp_sessions')
        .select('value')
        .eq('key', key)
        .single()
      return data ? JSON.parse(JSON.stringify(data.value), BufferJSON.reviver) : null
    } catch { return null }
  }

  async function writeData(key, value) {
    if (!supabase) return
    try {
      await supabase.from('whatsapp_sessions').upsert(
        { key, value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      )
    } catch (e) { console.error('[Session] Erro ao salvar:', e.message) }
  }

  async function removeData(key) {
    if (!supabase) return
    try { await supabase.from('whatsapp_sessions').delete().eq('key', key) } catch {}
  }

  // Carrega creds
  let creds = await readData('creds')
  if (!creds) {
    // Tenta arquivo local como fallback
    const credsPath = join(AUTH_FOLDER, 'creds.json')
    if (existsSync(credsPath)) {
      try { creds = JSON.parse(readFileSync(credsPath, 'utf8'), BufferJSON.reviver) } catch {}
    }
  }
  if (!creds) creds = initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const key = `${type}-${id}`
            const val = await readData(key)
            if (val) data[id] = val
          }
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids)) {
              const key = `${type}-${id}`
              tasks.push(value == null ? removeData(key) : writeData(key, value))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds)
      // Backup local também
      try { writeFileSync(join(AUTH_FOLDER, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer)) } catch {}
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
function toJid(phone) {
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`
}

async function humanDelay(text = '') {
  const ms = Math.min(1000 + text.length * 40, 5000)
  await new Promise(r => setTimeout(r, ms))
}

// ─── Express ──────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: '20mb' }))

// Health check (Railway usa isso para saber se está vivo)
app.get('/health', (_, res) => res.json({ ok: true, connected: isConnected, phone: connectedPhone }))

// Página HTML do QR Code
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Isa Santos — Online</title>
      <meta http-equiv="refresh" content="30">
      <style>body{font-family:Arial,sans-serif;background:#0f1a0f;color:#4ade80;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .card{background:#111811;border:1px solid #1a3a1a;border-radius:16px;padding:40px 60px;text-align:center}
      h1{font-size:26px}.phone{font-size:20px;color:#86efac;margin-top:16px;font-weight:bold}
      .dot{width:12px;height:12px;background:#4ade80;border-radius:50%;display:inline-block;margin-right:8px;animation:p 1.5s infinite}
      @keyframes p{0%,100%{opacity:1}50%{opacity:.4}}</style></head><body>
      <div class="card"><h1><span class="dot"></span>Agente Isa Santos Online ✅</h1>
      <p style="color:#9ca3af">WhatsApp conectado com sucesso!</p>
      <div class="phone">📱 ${connectedPhone}</div>
      <p style="margin-top:24px;font-size:13px;color:#6b7c6b">Respondendo mensagens automaticamente.</p>
      </div></body></html>`)
  }

  if (!qrCodeData) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aguardando...</title>
      <meta http-equiv="refresh" content="2">
      <style>body{font-family:Arial;background:#0f0f1a;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .s{width:40px;height:40px;border:4px solid #333;border-top:4px solid #60a5fa;border-radius:50%;animation:sp 1s linear infinite;margin:0 auto 20px}
      @keyframes sp{to{transform:rotate(360deg)}}</style></head>
      <body><div style="text-align:center"><div class="s"></div><p>Gerando QR Code...</p></div></body></html>`)
  }

  return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Escanear QR — Isa Santos</title><meta http-equiv="refresh" content="30">
    <style>body{font-family:Arial;background:#0f0f1a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#1a1a2e;border:1px solid #2d3748;border-radius:16px;padding:32px 40px;text-align:center;max-width:420px}
    h1{font-size:22px;color:#60a5fa}img{border-radius:12px;margin:20px 0;border:3px solid #374151}
    .step{display:flex;align-items:flex-start;gap:10px;margin:8px 0;font-size:13px;color:#d1d5db;text-align:left}
    .num{background:#3b82f6;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
    .warn{background:#2a1a00;border:1px solid #7c3d00;border-radius:8px;padding:10px;margin-top:16px;font-size:12px;color:#fb923c}</style></head>
    <body><div class="card">
      <h1>📱 Conectar WhatsApp</h1>
      <p style="color:#9ca3af;font-size:14px">Agente Isa Santos — Residencial Nova Luziânia</p>
      <img src="${qrCodeData}" width="260" height="260" alt="QR"/>
      <div style="text-align:left;margin-top:16px">
        <div class="step"><div class="num">1</div><span>Abra o WhatsApp no celular</span></div>
        <div class="step"><div class="num">2</div><span>Toque nos 3 pontinhos → <strong>Dispositivos vinculados</strong></span></div>
        <div class="step"><div class="num">3</div><span>Toque em <strong>"Vincular um dispositivo"</strong></span></div>
        <div class="step"><div class="num">4</div><span>Aponte a câmera para o QR Code acima</span></div>
      </div>
      <div class="warn">⏱ O QR atualiza automaticamente a cada 30s</div>
    </div></body></html>`)
})

// Status + QR JSON (dashboard Vercel)
app.get('/status', (_, res) => res.json({ connected: isConnected, phone: connectedPhone }))
app.get('/qr',     (_, res) => res.json({ connected: isConnected, phone: connectedPhone, qr: qrCodeData || null }))

// Enviar texto
app.post('/send-text', async (req, res) => {
  const { phone, message } = req.body
  if (!sock || !isConnected) return res.status(503).json({ ok: false, error: 'Não conectado' })
  try {
    const jid = toJid(phone)
    await sock.sendPresenceUpdate('available', jid)
    await sock.sendPresenceUpdate('composing', jid)
    await humanDelay(message)
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { text: message })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

// Enviar imagem
app.post('/send-image', async (req, res) => {
  const { phone, imageUrl, caption } = req.body
  if (!sock || !isConnected) return res.status(503).json({ ok: false, error: 'Não conectado' })
  try {
    const jid = toJid(phone)
    await sock.sendPresenceUpdate('composing', jid)
    await new Promise(r => setTimeout(r, 1500))
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' })
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

// Marcar como lido
app.post('/mark-read', async (req, res) => {
  const { phone, messageId } = req.body
  if (!sock || !isConnected) return res.status(503).json({ ok: false, error: 'Não conectado' })
  try {
    await sock.readMessages([{ remoteJid: toJid(phone), id: messageId, fromMe: false }])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ ok: false, error: err.message }) }
})

// Mapa de disponibilidade (screenshot ao vivo)
app.post('/send-availability-map', async (req, res) => {
  const { phone } = req.body
  if (!sock || !isConnected) return res.status(503).json({ ok: false, error: 'Não conectado' })
  let browser = null
  try {
    const puppeteer = await import('puppeteer')
    browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(
      'https://inova-vendas.novabairros.com.br/novabairros/mapas-empreendimento/G541154841484458480RE54158416545680L/view',
      { waitUntil: 'networkidle2', timeout: 40_000 }
    )
    await new Promise(r => setTimeout(r, 4000))
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 88 })
    await browser.close(); browser = null

    const jid = toJid(phone)
    await sock.sendPresenceUpdate('composing', jid)
    await new Promise(r => setTimeout(r, 2000))
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, {
      image: screenshot,
      caption: '🗺️ *Mapa de disponibilidade — atualizado agora!*\n✅ Verde = disponível  |  ❌ Vermelho = vendido'
    })
    res.json({ ok: true })
  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ─── WhatsApp via Baileys ─────────────────────────────────────────
async function startWhatsApp() {
  if (reconnecting) return
  reconnecting = true

  try {
    const { version } = await fetchLatestBaileysVersion()

    // Usa Supabase se disponível, senão arquivo local
    let authState, saveCreds
    if (supabase) {
      console.log('[Gateway] Usando sessão Supabase (persistente na nuvem) ✅')
      const sb = await useSupabaseAuthState()
      authState = sb.state
      saveCreds = sb.saveCreds
    } else {
      console.log('[Gateway] Usando sessão local (arquivo) ⚠️')
      const local = await useMultiFileAuthState(AUTH_FOLDER)
      authState = local.state
      saveCreds = local.saveCreds
    }

    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      logger,
      printQRInTerminal: true,
      browser: ['Agente Isa Santos', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('\n📱 Novo QR Code gerado! Escaneie em: http://localhost:' + PORT)
        qrCodeData = await qrcode.toDataURL(qr)
      }

      if (connection === 'open') {
        isConnected    = true
        qrCodeData     = null
        reconnecting   = false
        connectedPhone = sock.user?.id?.replace(/:[^@]+/, '') || 'conectado'
        console.log('\n✅ WhatsApp conectado! Número:', connectedPhone)
        console.log('   Agente Isa Santos — pronto para responder!\n')
      }

      if (connection === 'close') {
        isConnected  = false
        reconnecting = false
        const code   = lastDisconnect?.error?.output?.statusCode
        const logout = code === DisconnectReason.loggedOut

        if (logout) {
          console.log('\n❌ Logout detectado — limpando sessão...')
          // Limpa sessão do Supabase
          if (supabase) {
            await supabase.from('whatsapp_sessions').delete().neq('key', '__none__').catch(() => {})
          }
          connectedPhone = null
          qrCodeData     = null
          console.log('   Reiniciando para novo QR Code...\n')
          setTimeout(startWhatsApp, 3000)
        } else {
          console.log(`\n⚠️  Conexão perdida (código ${code}) — reconectando em 5s...\n`)
          setTimeout(startWhatsApp, 5000)
        }
      }
    })

    // Recebe mensagens e encaminha ao Vercel
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        try {
          if (msg.key.fromMe) continue
          if (isJidBroadcast(msg.key.remoteJid)) continue
          if (msg.key.remoteJid?.endsWith('@g.us')) continue

          const phone     = msg.key.remoteJid.replace('@s.whatsapp.net', '')
          const messageId = msg.key.id
          const name      = msg.pushName || undefined
          const jid       = msg.key.remoteJid

          // Marca como lido imediatamente
          try { await sock.readMessages([{ remoteJid: jid, id: messageId, fromMe: false }]) } catch {}

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption || ''

          let msgType = 'text'
          if (msg.message?.audioMessage || msg.message?.pttMessage) msgType = 'audio'
          else if (msg.message?.imageMessage)   msgType = 'image'
          else if (msg.message?.documentMessage) msgType = 'document'

          console.log(`[${new Date().toLocaleTimeString()}] ${phone} (${name || '?'}): "${text.slice(0, 60)}"`)

          const payload = { source: 'baileys', messageId, phone, name, type: msgType, text }

          if (msgType === 'audio') {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                logger,
                reuploadRequest: sock.updateMediaMessage,
              })
              payload.audioBase64 = buffer.toString('base64')
              payload.audioMime   = msg.message?.audioMessage?.mimetype || 'audio/ogg'
            } catch {}
          }

          const resp = await fetch(WEBHOOK_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
            signal:  AbortSignal.timeout(30_000),
          })

          if (!resp.ok) console.error('[Gateway] Vercel respondeu:', resp.status)

        } catch (err) {
          console.error('[Gateway] Erro:', err.message)
        }
      }
    })

  } catch (err) {
    reconnecting = false
    console.error('[Gateway] Erro ao iniciar:', err.message)
    setTimeout(startWhatsApp, 5000)
  }
}

// ─── Inicia ───────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n─────────────────────────────────────────────')
  console.log('  🤖 WhatsApp Gateway — Agente Isa Santos')
  console.log('─────────────────────────────────────────────')
  console.log(`  Painel QR:    http://localhost:${PORT}`)
  console.log(`  Vercel URL:   ${VERCEL_URL}`)
  console.log(`  Sessão:       ${supabase ? 'Supabase (nuvem) ✅' : 'Local (arquivo) ⚠️'}`)
  console.log('─────────────────────────────────────────────\n')
})

startWhatsApp()
