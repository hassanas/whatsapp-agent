const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const axios   = require('axios');
const yaml    = require('js-yaml');
const fs      = require('fs');
const path    = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.yaml');
const cfg        = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
const AGENT_URL  = `http://agent:${cfg.agent_port}/message`;
const TARGET_CONTACTS = String(cfg.target_contact || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const TARGET_PHONES = new Set(
  TARGET_CONTACTS
    .map(value => value.replace(/\D/g, ''))
    .filter(Boolean)
);
const TARGET_JIDS = new Set(
  TARGET_CONTACTS
    .filter(value => value.includes('@'))
    .map(value => value.toLowerCase())
);
const DEBUG_ACCEPT_ALL_PRIVATE = String(process.env.DEBUG_ACCEPT_ALL_PRIVATE || '').toLowerCase() === 'true';
const recentlySentIds = new Set();
const recentlySentFingerprints = new Set();
const processedMessageIds = new Set();
let announcedReady = false;

function normalizeReply(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function normalizePhone(value) {
  return String(value || '').split('@')[0].replace(/\D/g, '');
}

function normalizeJid(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMessageBody(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isGroupMessage(msg) {
  return typeof msg.from === 'string' && msg.from.endsWith('@g.us');
}

async function resolveSenderIdentity(msg) {
  const phones = new Set();
  const jids = new Set();

  if (msg?.from) {
    phones.add(normalizePhone(msg.from));
    jids.add(normalizeJid(msg.from));
  }
  if (msg?.author) {
    phones.add(normalizePhone(msg.author));
    jids.add(normalizeJid(msg.author));
  }

  try {
    const contact = await msg.getContact();
    if (contact?.number) phones.add(normalizePhone(contact.number));
    if (contact?.id?._serialized) jids.add(normalizeJid(contact.id._serialized));
    if (contact?.id?.user) phones.add(normalizePhone(contact.id.user));
  } catch (err) {
    console.log('[bridge] Could not resolve contact details:', err.message);
  }

  phones.delete('');
  jids.delete('');
  return { phones: [...phones], jids: [...jids] };
}

async function isTargetMessage(msg) {
  const identity = await resolveSenderIdentity(msg);
  const phoneMatch = identity.phones.some(phone => TARGET_PHONES.has(phone));
  const jidMatch = identity.jids.some(jid => TARGET_JIDS.has(normalizeJid(jid)));
  return { matched: phoneMatch || jidMatch, identity };
}

// Recursively remove all SingletonLock files left by unclean shutdowns
function clearLocks(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearLocks(full);
    } else if (entry.name === 'SingletonLock' || entry.name === 'SingletonSocket' || entry.name === 'SingletonCookie') {
      fs.unlinkSync(full);
      console.log(`[bridge] Removed lock: ${full}`);
    }
  });
}

clearLocks('/app/.wwebjs_auth');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
  }
});

client.on('qr', qr => {
  console.log('[bridge] QR received. Scan this QR in WhatsApp > Linked Devices:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('[bridge] Authenticated with WhatsApp Web session'));

client.on('loading_screen', (percent, message) => {
  console.log(`[bridge] Loading WhatsApp Web: ${percent}% ${message || ''}`.trim());
});

function logReady(source) {
  if (announcedReady) return;
  announcedReady = true;
  const wid = client.info?.wid?._serialized || 'unknown';
  const pushname = client.info?.pushname || 'unknown';
  console.log(`[bridge] Ready as ${wid} (${pushname}) [source=${source}]`);
  if (DEBUG_ACCEPT_ALL_PRIVATE) {
    console.log('[bridge] TEMP_DEBUG_MODE active: accepting all private chats (target filter bypassed)');
  } else {
    console.log(`[bridge] Strict mode active: only configured target_contact values are accepted (${TARGET_CONTACTS.join(', ') || 'unset'})`);
  }
}

client.on('ready', () => {
  logReady('ready_event');
});

client.on('change_state', async state => {
  console.log('[bridge] State changed:', state);
  if (state === 'CONNECTED') {
    try {
      // Warm up chat APIs in case ready event is delayed/flaky.
      await client.getChats();
    } catch (err) {
      console.log('[bridge] getChats warmup failed:', err.message);
    }
    logReady('change_state_connected');
  }
});

client.on('auth_failure', msg => console.error('[bridge] Auth failed:', msg));

client.on('disconnected', reason => console.log('[bridge] Disconnected:', reason));

setTimeout(async () => {
  try {
    const state = await client.getState();
    const wid = client.info?.wid?._serialized || 'unknown';
    console.log(`[bridge] Startup state check after 30s: state=${state}, wid=${wid}`);
    if (state === 'CONNECTED') {
      try {
        await client.getChats();
      } catch (err) {
        console.log('[bridge] getChats startup warmup failed:', err.message);
      }
      logReady('startup_state_check');
    }
  } catch (err) {
    console.log('[bridge] Startup state check failed:', err.message);
  }
}, 30000);

client.on('message_ack', (msg, ack) => {
  const id = msg?.id?._serialized || 'unknown';
  console.log(`[bridge] Ack ${ack} for ${id}`);
});

function rememberSentId(id) {
  if (!id) return;
  recentlySentIds.add(id);
  setTimeout(() => recentlySentIds.delete(id), 120000);
}

function buildMessageFingerprint(body) {
  return normalizeMessageBody(body);
}

function rememberSentMessage(body, id) {
  rememberSentId(id);
  const fingerprint = buildMessageFingerprint(body);
  if (fingerprint) {
    recentlySentFingerprints.add(fingerprint);
    setTimeout(() => recentlySentFingerprints.delete(fingerprint), 5000);
  }
}

function wasRecentlySentMessage(body, id) {
  if (id && recentlySentIds.has(id)) return true;
  return recentlySentFingerprints.has(buildMessageFingerprint(body));
}

function rememberProcessedMessage(id) {
  if (!id) return;
  processedMessageIds.add(id);
  setTimeout(() => processedMessageIds.delete(id), 120000);
}

function isConfiguredOwnNumber() {
  const selfJid = normalizeJid(client.info?.wid?._serialized);
  const selfPhone = normalizePhone(selfJid);
  return TARGET_PHONES.has(selfPhone) || TARGET_JIDS.has(selfJid);
}

async function processMessage(msg, source) {
  console.log(
    `[bridge] Incoming candidate (${source}): from=${msg.from}, to=${msg.to || '-'}, author=${msg.author || '-'}, fromMe=${msg.fromMe}, type=${msg.type}, id=${msg.id?._serialized || 'unknown'}`
  );

  if (isGroupMessage(msg)) {
    console.log('[bridge] Ignoring group message');
    return;
  }

  if (!DEBUG_ACCEPT_ALL_PRIVATE) {
    const targetCheck = await isTargetMessage(msg);
    if (!targetCheck.matched) {
      if (msg.fromMe && isConfiguredOwnNumber()) {
        console.log('[bridge] Allowing self message from configured own number in strict mode');
      } else {
      console.log(
        `[bridge][NON_TARGET_IGNORED] source=${source} id=${msg.id?._serialized || 'unknown'} from=${msg.from} body="${normalizeMessageBody(msg.body).slice(0, 160)}" expected=${TARGET_CONTACTS.join(', ') || '-'} actual_phones=${targetCheck.identity.phones.join(',') || '-'} actual_jids=${targetCheck.identity.jids.join(',') || '-'}`
      );
      return;
      }
    }
  } else {
    console.log('[bridge] TEMP_DEBUG_MODE accepted private message');
  }

  console.log(`[IN]  ${msg.body}`);

  let replyText;

  try {
    const res = await axios.post(AGENT_URL, { from: msg.from, body: msg.body });
    replyText = normalizeReply(res?.data?.reply);
  } catch (err) {
    console.error('[bridge] Agent request error:', err.response?.data || err.message);
    return;
  }

  if (!replyText) {
    console.error('[bridge] Agent returned an empty reply; nothing will be sent');
    return;
  }

  console.log(`[OUT] ${replyText}`);

  try {
    const sent = await client.sendMessage(msg.from, replyText);
    rememberSentMessage(replyText, sent?.id?._serialized);
    console.log(`[bridge] Sent WhatsApp message ${sent?.id?._serialized || 'unknown'} to ${msg.from}`);
  } catch (err) {
    console.error('[bridge] WhatsApp send error:', err);
  }
}

client.on('message', async msg => {
  console.log(`[bridge] message event: from=${msg.from}, to=${msg.to || '-'}, fromMe=${msg.fromMe}, id=${msg?.id?._serialized || 'unknown'}`);
  const id = msg?.id?._serialized;
  if (id && processedMessageIds.has(id)) return;
  rememberProcessedMessage(id);
  await processMessage(msg, 'message');
});

client.on('message_create', async msg => {
  console.log(`[bridge] message_create event: from=${msg.from}, to=${msg.to || '-'}, fromMe=${msg.fromMe}, id=${msg?.id?._serialized || 'unknown'}`);
  if (isGroupMessage(msg)) return;

  const id = msg?.id?._serialized;
  if (id && processedMessageIds.has(id)) return;

  if (msg.fromMe) {

    if (wasRecentlySentMessage(msg.body, id)) {
      console.log(`[bridge] Ignoring bridge-generated self-chat message: ${id || 'unknown'}`);
      return;
    }

    rememberProcessedMessage(id);
    await processMessage(msg, 'message_create/self');
    return;
  }

  rememberProcessedMessage(id);
  await processMessage(msg, 'message_create/incoming');
});

client.initialize();