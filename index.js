// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// =======================
// 1. FIREBASE INIT
// =======================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT env var (JSON).');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// IMPORTANT: include databaseURL so admin.database() works
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    process.env.FIREBASE_DATABASE_URL ||
    'https://telerhu-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = admin.database();

// =======================
// 2. EXPRESS + MIDDLEWARE
// =======================
const app = express();
app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : true
  })
);
app.use(bodyParser.json({ limit: '10kb' }));

// =======================
// 3. RATE LIMITER (for /login)
// =======================
const rateLimiter = new RateLimiterMemory({
  points: 5, // 5 attempts
  duration: 60 * 5 // per 5 minutes
});

// =======================
// 4. SIMPLE PASSWORD VERIFY
// =======================
async function verifyPassword(candidatePassword, storedHashOrPlain) {
  if (typeof storedHashOrPlain === 'string' && storedHashOrPlain.startsWith('$2')) {
    // hashed with bcrypt
    return bcrypt.compare(candidatePassword, storedHashOrPlain);
  }
  // plain text fallback
  return candidatePassword === storedHashOrPlain;
}

// =======================
// 5. IN-MEMORY FCM TOKEN STORE
// =======================
// For now we just keep a set of tokens in memory.
// Later you can move this to RTDB if you want.
const tokens = new Set();

// =======================
// 6. HEALTH CHECK
// =======================
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Auth + FCM server running' });
});

// =======================
// 7. REGISTER FCM TOKEN
//    POST /register  { token }
// =======================
app.post('/register', (req, res) => {
  const { token } = req.body;
  console.log('POST /register body:', req.body);

  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }

  tokens.add(token);
  console.log('Current tokens:', Array.from(tokens));

  return res.json({ ok: true, token });
});

// =======================
// 8. SEND-CALL ROUTES
//    GET  /send-call  -> just to confirm route exists
//    POST /send-call  -> actually sends FCM
// =======================

// Quick check route
app.get('/send-call', (req, res) => {
  res.json({
    ok: true,
    message: 'Use POST /send-call with { patientName, channelId } (and optional fields) to send notification'
  });
});

// Actual FCM sender
app.post('/send-call', async (req, res) => {
  try {
    console.log('POST /send-call body:', req.body);

    // basic required fields
    const {
      patientName,
      channelId,      // old name you already used
      // OPTIONAL (for better integration with main.dart→openVideoCallFromNotification)
      roomId,
      channel,
      token,
      agoraToken,
      doctorUid,
      submissionId,
      age,
      sex,
      symptoms,
      address
    } = req.body;

    if (!patientName || (!channelId && !channel && !roomId)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing patientName or channel/channelId/roomId'
      });
    }

    const tokenList = Array.from(tokens);
    if (tokenList.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'No tokens registered'
      });
    }

    console.log('Sending call notification to tokens:', tokenList);

    // Normalize fields to what Flutter main.dart expects:
    // openVideoCallFromNotification reads:
    //   roomId, channel, token, doctorUid, submissionId, patientName, age, sex, symptoms, address
    const finalRoomId = (roomId || '').toString();
    const finalChannel = (channel || channelId || '').toString();
    const finalToken = (token || agoraToken || '').toString();
    const finalDoctorUid = (doctorUid || '').toString();
    const finalSubmissionId = (submissionId || '').toString();
    const finalPatientName = (patientName || '').toString();
    const finalAge = (age || '').toString();
    const finalSex = (sex || '').toString();
    const finalSymptoms = (symptoms || '').toString();
    const finalAddress = (address || '').toString();

    const message = {
      tokens: tokenList,

      // Notification block = shows notif even when app is terminated
      notification: {
        title: 'Incoming TeleRHU Call',
        body: finalPatientName
          ? `${finalPatientName} is calling you`
          : 'You have an incoming TeleRHU call',
        // 👇 IMPORTANT for Flutter to route notification taps
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },

      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'telerhu_calls' // your custom Android channel (match in native if you configure)
        }
      },

      // Data payload Flutter can read to open VideoCallPage (main.dart)
      data: {
        // 👇 this is what your Dart handler checks
        type: 'call',

        // Call context
        roomId: finalRoomId,
        channel: finalChannel,
        token: finalToken,
        doctorUid: finalDoctorUid,
        submissionId: finalSubmissionId,

        // Optional patient info
        patientName: finalPatientName,
        age: finalAge,
        sex: finalSex,
        symptoms: finalSymptoms,
        address: finalAddress
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log('FCM sendEachForMulticast result:', response);

    return res.json({
      ok: true,
      successCount: response.successCount,
      failureCount: response.failureCount
    });
  } catch (err) {
    console.error('Error in /send-call:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =======================
// 9. LOGIN → CUSTOM TOKEN
//    POST /login { username, password, anonymousUid? }
// =======================
app.post('/login', async (req, res) => {
  try {
    await rateLimiter.consume(req.ip);
  } catch (rlRejected) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { username, password, anonymousUid } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username/password' });
  }

  try {
    const snap = await db
      .ref('oldUsers')
      .orderByChild('username')
      .equalTo(username)
      .once('value');

    const val = snap.val();
    if (!val) return res.status(401).json({ error: 'Invalid credentials' });

    const key = Object.keys(val)[0];
    const userRecord = val[key];

    const ok = await verifyPassword(password, userRecord.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const firebaseUid = `legacy_${key}`;
    const additionalClaims = { legacy: true };
    const token = await admin.auth().createCustomToken(firebaseUid, additionalClaims);

    return res.json({ token });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// =======================
// 10. START SERVER
// =======================
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Auth + FCM server listening on port ${port}`));
