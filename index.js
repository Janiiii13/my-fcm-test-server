// index.js
require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const admin = require('firebase-admin');

const app = express();

// parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // supports form posts

// simple request logger (after parsers so body is available)
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

// register token (stores it to tokens.json) with improved logging & flexible field names
app.post('/register', async (req, res) => {
  // debug logging to help identify why token can be undefined
  console.log('DEBUG req.headers:', req.headers);
  console.log('DEBUG req.body:', req.body);

  // accept token under several common property names or as query param
  const token =
    (req.body && (req.body.token || req.body.fcmToken || req.body.registrationToken || req.body.deviceToken))
    || req.query.token;

  console.log('📱 Received FCM token:', token);

  if (!token) {
    return res.status(400).json({
      ok: false,
      error: 'missing token in request. expected JSON like { "token": "..." }',
      hint: 'Ensure Content-Type: application/json and JSON.stringify(body) on the client.',
      receivedBody: req.body
    });
  }

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
    // Using Promise.all with send() for simplicity — catch per-send errors so broadcast continues
    const results = await Promise.all(
      messages.map(m => admin.messaging().send(m).catch(err => ({ error: err.message || String(err) })))
    );

    console.log('✅ Broadcast results:', results);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('❌ send-all error', err);
    res.status(500).json({ error: err.message || err });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
