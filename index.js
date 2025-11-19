// index.js - COMPLETE FIXED VERSION
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
// 3. RATE LIMITER
// =======================
const rateLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60 * 5
});

// =======================
// 4. PASSWORD VERIFY
// =======================
async function verifyPassword(candidatePassword, storedHashOrPlain) {
  if (
    typeof storedHashOrPlain === 'string' &&
    storedHashOrPlain.startsWith('$2')
  ) {
    return bcrypt.compare(candidatePassword, storedHashOrPlain);
  }
  return candidatePassword === storedHashOrPlain;
}

// =======================
// 5. FCM TOKEN STORE
// =======================
// Store tokens by user: { uid: { token, role, timestamp } }
const userTokens = new Map();

// Also keep a Set of all tokens for broadcast
const allTokens = new Set();

// =======================
// 6. HEALTH CHECK
// =======================
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Auth + FCM server running',
    registeredUsers: userTokens.size,
    totalTokens: allTokens.size
  });
});

// =======================
// 7. REGISTER FCM TOKEN
// =======================
app.post('/register', (req, res) => {
  const { uid, role, token } = req.body;
  console.log('POST /register body:', req.body);

  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }

  if (!uid) {
    return res.status(400).json({ ok: false, error: 'Missing uid' });
  }

  // Store user info with token
  userTokens.set(uid, {
    token,
    role: role || 'user',
    timestamp: Date.now()
  });

  // Add to global token set
  allTokens.add(token);

  console.log(`✅ Registered token for user ${uid} (${role})`);
  console.log(
    `📊 Total users: ${userTokens.size}, Total tokens: ${allTokens.size}`
  );

  return res.json({ ok: true, uid, token });
});

// =======================
// 8. GET REGISTERED TOKENS (DEBUG)
// =======================
app.get('/tokens', (req, res) => {
  const users = Array.from(userTokens.entries()).map(([uid, data]) => ({
    uid,
    role: data.role,
    tokenPreview: data.token.substring(0, 20) + '...',
    registeredAt: new Date(data.timestamp).toISOString()
  }));

  res.json({
    ok: true,
    totalUsers: userTokens.size,
    totalTokens: allTokens.size,
    users
  });
});

// =======================
// 9. SEND-CALL ROUTES
// =======================
app.get('/send-call', (req, res) => {
  res.json({
    ok: true,
    message:
      'Use POST /send-call with { patientName, channelId } to send notification',
    registeredTokens: allTokens.size
  });
});

app.post('/send-call', async (req, res) => {
  try {
    console.log('📞 POST /send-call body:', req.body);

    const {
      patientName,
      channelId,
      roomId,
      channel,
      token,
      agoraToken,
      doctorUid,
      submissionId,
      age,
      sex,
      symptoms,
      address,
      targetRole, // optional - send to specific role (e.g., 'doctor')
      useTopic // optional - set to true to use topic instead of tokens
    } = req.body;

    if (!patientName || (!channelId && !channel && !roomId)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing patientName or channel/channelId/roomId'
      });
    }

    const finalDoctorUid = (doctorUid || '').toString();

    // Try to get a single doctor's token from in-memory map
    let singleDoctorToken = null;
    if (finalDoctorUid && userTokens.has(finalDoctorUid)) {
      singleDoctorToken = userTokens.get(finalDoctorUid).token;
      console.log(`🎯 Will send call to doctorUid=${finalDoctorUid}`);
    } else if (finalDoctorUid) {
      console.warn(
        `⚠️ doctorUid=${finalDoctorUid} has no registered token in userTokens`
      );
    }

    // Determine sending method
    let sendMethod;
    let tokenList = [];

    if (singleDoctorToken) {
      // ✅ Best case: we know exactly which doctor to notify
      sendMethod = 'single';
      console.log('🎯 Sending call to single doctor token');
    } else if (useTopic) {
      // Fallback: topic broadcast (all doctors)
      sendMethod = 'topic';
      console.log('📢 Sending to topic: doctors');
    } else {
      // Fallback: tokens (all or by role)
      sendMethod = 'tokens';

      if (targetRole) {
        tokenList = Array.from(userTokens.values())
          .filter(
            (u) => (u.role || '').toLowerCase() === targetRole.toLowerCase()
          )
          .map((u) => u.token);
        console.log(
          `🎯 Sending to ${targetRole}s only: ${tokenList.length} tokens`
        );
      } else {
        tokenList = Array.from(allTokens);
        console.log(
          `📢 Broadcasting to all: ${tokenList.length} tokens`
        );
      }

      if (tokenList.length === 0) {
        return res.status(404).json({
          ok: false,
          error: targetRole
            ? `No ${targetRole} tokens registered`
            : 'No tokens registered'
        });
      }
    }

    // Prepare notification data (base message)
    const finalRoomId = (roomId || '').toString();
    const finalChannel = (channel || channelId || '').toString();
    const finalToken = (token || agoraToken || '').toString();
    const finalSubmissionId = (submissionId || '').toString();
    const finalPatientName = (patientName || '').toString();
    const finalAge = (age || '').toString();
    const finalSex = (sex || '').toString();
    const finalSymptoms = (symptoms || '').toString();
    const finalAddress = (address || '').toString();

    const baseMessage = {
      notification: {
        title: 'Incoming TeleRHU Call',
        body: finalPatientName
          ? `${finalPatientName} is calling you`
          : 'You have an incoming TeleRHU call'
      },

      android: {
        priority: 'high',
        notification: {
          channelId: 'telerhu_calls',
          sound: 'default'
        }
      },

      data: {
        type: 'call',
        roomId: finalRoomId,
        channel: finalChannel,
        token: finalToken,
        doctorUid: finalDoctorUid,
        submissionId: finalSubmissionId,
        patientName: finalPatientName,
        age: finalAge,
        sex: finalSex,
        symptoms: finalSymptoms,
        address: finalAddress,
        sentAt: Date.now().toString(),
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      }
    };

    // ========== SEND NOTIFICATION ==========
    if (sendMethod === 'single') {
      // ✅ Single doctor: admin.messaging().send(...)
      const singleMessage = {
        ...baseMessage,
        token: singleDoctorToken
      };

      console.log('📤 Sending FCM message to single doctor...');
      const messageId = await admin.messaging().send(singleMessage);
      console.log('✅ FCM single send ID:', messageId);

      return res.json({
        ok: true,
        method: 'single',
        doctorUid: finalDoctorUid,
        messageId
      });
    }

    if (sendMethod === 'topic') {
      console.log('📤 Sending FCM message to topic: doctors');
      const topicMessage = {
        ...baseMessage,
        topic: 'doctors'
      };
      const messageId = await admin.messaging().send(topicMessage);
      console.log('✅ Message sent to topic, ID:', messageId);

      return res.json({
        ok: true,
        method: 'topic',
        messageId,
        topic: 'doctors'
      });
    }

    // sendMethod === 'tokens' (multicast)
    const multicastMessage = {
      ...baseMessage,
      tokens: tokenList
    };

    console.log(
      '📤 Sending FCM message to',
      tokenList.length,
      'device(s)...'
    );
    const response = await admin.messaging().sendEachForMulticast(
      multicastMessage
    );

    console.log('✅ FCM Response:', {
      successCount: response.successCount,
      failureCount: response.failureCount
    });

    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`❌ Token ${idx} failed:`, {
            error: resp.error?.code,
            message: resp.error?.message,
            token: tokenList[idx].substring(0, 20) + '...'
          });
        }
      });
    }

    return res.json({
      ok: true,
      method: 'tokens',
      successCount: response.successCount,
      failureCount: response.failureCount,
      tokensSent: tokenList.length
    });
  } catch (err) {
    console.error('❌ Error in /send-call:', err);
    return res.status(500).json({
      ok: false,
      error: 'Internal error',
      message: err.message
    });
  }
});

// =======================
// 10. LOGIN → CUSTOM TOKEN
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
    const token = await admin
      .auth()
      .createCustomToken(firebaseUid, additionalClaims);

    return res.json({ token });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// =======================
// 11. START SERVER
// =======================
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 Auth + FCM server listening on port ${port}`);
  console.log(`📱 Ready to receive FCM token registrations`);
});
