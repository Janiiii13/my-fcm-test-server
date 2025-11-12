// index.js
require('dotenv').config(); // safe to keep for local dev; on Render env vars are used
const fs = require('fs');
const express = require('express');
const admin = require('firebase-admin');

const SA_PATH = './serviceAccountKey.json';

// decode base64 env var into file (Render)
if (process.env.FIREBASE_SA_B64) {
  try {
    const buff = Buffer.from(process.env.FIREBASE_SA_B64, 'base64');
    fs.writeFileSync(SA_PATH, buff);
    console.log('Wrote service account file from FIREBASE_SA_B64');
  } catch (err) {
    console.error('Failed to write service account from FIREBASE_SA_B64', err);
  }
}

// init firebase-admin
try {
  const serviceAccount = require(SA_PATH);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('Firebase admin initialized');
} catch (err) {
  console.error('Failed to initialize firebase-admin:', err.message);
  // continue — server can still run for debugging
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('FCM test server is running'));

app.post('/send', async (req, res) => {
  const token = (req.body && req.body.token) || process.env.FCM_TOKEN;
  if (!token) return res.status(400).json({ error: 'No token provided' });

  const message = {
    token,
    notification: {
      title: req.body.title || 'Hello from server',
      body: req.body.body || 'This should appear even if app is closed'
    },
    data: Object.assign({ screen: 'chat', chat_id: '12345' }, req.body.data || {}),
    android: { priority: 'high', notification: { channel_id: 'high_importance_channel' } },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } }
  };

  try {
    const resp = await admin.messaging().send(message);
    return res.json({ success: true, messageId: resp });
  } catch (err) {
    console.error('FCM send error:', err);
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
