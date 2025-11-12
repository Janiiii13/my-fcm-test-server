// index.js
require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// simple request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

async function readTokens() {
  try {
    const raw = await fs.readFile(TOKENS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    // if file doesn't exist return empty array
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeTokens(tokens) {
  await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}

// root routes
app.get('/', (req, res) => res.send('Server running'));
app.post('/', (req, res) => res.send('POST to / received — use /register to send tokens'));

// register token (stores it to tokens.json)
app.post('/register', async (req, res) => {
  const { token } = req.body;
  console.log('📱 Received FCM token:', token);
  if (!token) return res.status(400).json({ error: 'missing token' });

  try {
    const tokens = await readTokens();
    if (!tokens.includes(token)) {
      tokens.push(token);
      await writeTokens(tokens);
    }
    res.json({ ok: true, token });
  } catch (err) {
    console.error('Error saving token:', err);
    res.status(500).json({ error: 'could not save token' });
  }
});

// list tokens (useful for debugging)
app.get('/tokens', async (req, res) => {
  try {
    const tokens = await readTokens();
    res.json({ ok: true, count: tokens.length, tokens });
  } catch (err) {
    console.error('Error reading tokens:', err);
    res.status(500).json({ error: 'could not read tokens' });
  }
});

// initialise firebase-admin (only if env var exists)
function initFirebaseAdminIfNeeded() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn('FIREBASE_SERVICE_ACCOUNT not set; /send will fail until configured.');
    return;
  }
  try {
    const sa = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    console.log('Firebase Admin initialized');
  } catch (err) {
    console.error('Failed to initialize Firebase Admin:', err);
  }
}

// send to a single token
app.post('/send', async (req, res) => {
  const { token, title = 'Test', body = 'Hello' } = req.body;
  if (!token) return res.status(400).json({ error: 'missing token' });

  try {
    initFirebaseAdminIfNeeded();
    if (!admin.apps.length) throw new Error('Firebase Admin not initialized');

    const message = { token, notification: { title, body } };
    const response = await admin.messaging().send(message);
    console.log('✅ Message sent:', response);
    res.json({ ok: true, response });
  } catch (err) {
    console.error('❌ send error', err);
    res.status(500).json({ error: err.message || err });
  }
});

// send to all stored tokens (careful: avoid spamming)
app.post('/send-all', async (req, res) => {
  const { title = 'Broadcast', body = 'Hello everyone' } = req.body;
  try {
    initFirebaseAdminIfNeeded();
    if (!admin.apps.length) throw new Error('Firebase Admin not initialized');

    const tokens = await readTokens();
    if (!tokens.length) return res.status(400).json({ error: 'no tokens registered' });

    const messages = tokens.map(t => ({ token: t, notification: { title, body } }));
    // Using sendAll or sendEach? For simplicity use Promise.all with send()
    const results = await Promise.all(messages.map(m => admin.messaging().send(m).catch(err => ({ error: err.message || err }))));

    console.log('✅ Broadcast results:', results);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('❌ send-all error', err);
    res.status(500).json({ error: err.message || err });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
