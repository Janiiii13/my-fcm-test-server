// index.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing service account JSON. Set SERVICE_ACCOUNT_PATH in .env');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath))
});

const app = express();
app.use(express.json());

const DEFAULT_TOKEN = process.env.FCM_TOKEN || '';

app.get('/', (req, res) => res.send('FCM test server is running'));

app.post('/send', async (req, res) => {
  try {
    const token = req.body.token || DEFAULT_TOKEN;
    if (!token) return res.status(400).json({ error: 'No token provided' });

    // Example: visible notification + data (recommended to show even when app closed)
    const message = {
      token,
      notification: {
        title: req.body.title || 'Hello from server',
        body: req.body.body || 'This notification should show even if app is closed'
      },
      data: Object.assign({
        screen: 'chat',
        chat_id: '12345'
      }, req.body.data || {}),
      android: {
        priority: 'high',
        notification: {
          channel_id: 'high_importance_channel'
        }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };

    const resp = await admin.messaging().send(message);
    return res.json({ success: true, messageId: resp });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// optional: send data-only (silent) message
app.post('/send-data-only', async (req, res) => {
  try {
    const token = req.body.token || DEFAULT_TOKEN;
    const message = {
      token,
      data: req.body.data || { foo: 'bar' },
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '5' },
        payload: { aps: { 'content-available': 1 } }
      }
    };
    const resp = await admin.messaging().send(message);
    return res.json({ success: true, messageId: resp });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FCM test server listening on ${port}`));
