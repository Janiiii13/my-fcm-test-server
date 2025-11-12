// index.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

const app = express();

// simple request logger (very helpful)
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// parse JSON bodies
app.use(express.json());

// root handlers (so POST / doesn't return "Cannot POST /")
app.get('/', (req, res) => res.send('Server running'));
app.post('/', (req, res) => res.send('POST to / received — use /register to send tokens'));

// token registration endpoint
app.post('/register', (req, res) => {
  const { token } = req.body;
  console.log('📱 Received FCM token:', token);
  if (!token) return res.status(400).json({ error: 'missing token' });
  // TODO: save token to DB if you want
  res.json({ ok: true, token });
});

// optional send endpoint to test FCM send (requires valid admin credentials)
app.post('/send', async (req, res) => {
  const { token, title = 'Test', body = 'Hello' } = req.body;
  if (!token) return res.status(400).json({ error: 'missing token' });

  try {
    // initialize admin only once; make sure FIREBASE_SERVICE_ACCOUNT is set
    if (!admin.apps.length) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    }

    const message = { token, notification: { title, body } };
    const response = await admin.messaging().send(message);
    console.log('✅ Message sent:', response);
    res.json({ ok: true, response });
  } catch (err) {
    console.error('❌ send error', err);
    res.status(500).json({ error: err.message || err });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
