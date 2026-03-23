const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error('Error parsing FIREBASE_SERVICE_ACCOUNT:', error.message);
  serviceAccount = null;
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error.message);
  }
} else {
  console.error('FIREBASE_SERVICE_ACCOUNT environment variable is not set or invalid');
}

const db = admin.firestore ? admin.firestore() : null;
const auth = admin.auth ? admin.auth() : null;

// Constants
const ADMIN_EMAILS = ['admin@fbidshop.com'];
const NON_VERIFIED_FEE = 5;
const VERIFIED_FEE = 15;

// ==================== HELPER FUNCTIONS ====================

// Verify user token
async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!auth) throw new Error('Auth not initialized');
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Check if user is admin
async function isAdmin(email) {
  return ADMIN_EMAILS.includes(email);
}

// Get user data from Firebase Auth UID
async function getUserData(uid) {
  if (!db) return null;
  const userDoc = await db.collection('users').doc(uid).get();
  return userDoc.exists ? userDoc.data() : null;
}

// Update user balance
async function updateUserBalance(uid, amount, operation = 'add') {
  if (!db) return null;
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  const currentBalance = userDoc.data()?.balance || 0;
  const newBalance = operation === 'add' ? currentBalance + amount : currentBalance - amount;
  await userRef.update({ balance: newBalance });
  return newBalance;
}

// Root endpoint to check if API is running
app.get('/', (req, res) => {
  res.json({ 
    message: 'FB ID Shop API is running',
    status: 'active',
    firebase: serviceAccount ? 'initialized' : 'not initialized'
  });
});

// ==================== AUTHENTICATION ====================

// Sign Up
app.post('/api/signup', async (req, res) => {
  try {
    if (!auth || !db) throw new Error('Firebase not initialized');
    
    const { username, email, whatsapp, password } = req.body;

    // Validation
    if (!username || !username.match(/^[A-Za-z]+$/)) {
      return res.status(400).json({ error: 'Username must contain only alphabets' });
    }
    if (!whatsapp || !whatsapp.match(/^\d+$/)) {
      return res.status(400).json({ error: 'WhatsApp number must contain only digits' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if username exists
    const usernameCheck = await db.collection('users').where('username', '==', username).get();
    if (!usernameCheck.empty) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    // Create user in Firebase Auth
    const userRecord = await auth.createUser({
      email: email,
      password: password,
      displayName: username
    });

    // Save user data in Firestore
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      username: username,
      email: email,
      whatsapp: whatsapp,
      balance: 0,
      isBlocked: false,
      isAdmin: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      totalBuy: 0,
      totalSell: 0
    });

    res.status(201).json({ message: 'User created successfully', uid: userRecord.uid });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login (Firebase handles on frontend, just verify token)
app.post('/api/login', async (req, res) => {
  try {
    if (!auth) throw new Error('Auth not initialized');
    
    const { token } = req.body;
    const decodedToken = await auth.verifyIdToken(token);
    const userData = await getUserData(decodedToken.uid);
    
    if (userData?.isBlocked) {
      return res.status(403).json({ error: 'Your account has been blocked' });
    }

    res.json({ 
      message: 'Login successful', 
      user: { 
        uid: decodedToken.uid, 
        email: decodedToken.email,
        username: userData?.username,
        isAdmin: userData?.isAdmin || false
      } 
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ==================== BUY SECTION (PUBLIC) ====================

// Get available IDs with filters
app.get('/api/available-ids', async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { type, minPrice, maxPrice, page = 1, limit = 20 } = req.query;
    
    let query = db.collection('ids').where('status', '==', 'available');
    
    if (type && type !== 'all') {
      query = query.where('type', '==', type);
    }
    
    let snapshot = await query.get();
    let ids = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      let price = data.price;
      
      if (minPrice && price < parseInt(minPrice)) return;
      if (maxPrice && price > parseInt(maxPrice)) return;
      
      ids.push({
        id: doc.id,
        uid: data.uid,
        price: data.price,
        type: data.type,
        sellerUsername: data.sellerUsername
      });
    });
    
    // Pagination
    const start = (page - 1) * limit;
    const paginatedIds = ids.slice(start, start + limit);
    
    res.json({ ids: paginatedIds, total: ids.length });
  } catch (error) {
    console.error('Error fetching available IDs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Buy ID (Protected)
app.post('/api/buy-id', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { idDocId } = req.body;
    const buyerId = req.user.uid;
    
    const buyerData = await getUserData(buyerId);
    if (buyerData.isBlocked) {
      return res.status(403).json({ error: 'Your account is blocked' });
    }
    
    const idDoc = await db.collection('ids').doc(idDocId).get();
    if (!idDoc.exists) {
      return res.status(404).json({ error: 'ID not found' });
    }
    
    const idData = idDoc.data();
    if (idData.status !== 'available') {
      return res.status(400).json({ error: 'ID already sold' });
    }
    
    // Check buyer balance
    if (buyerData.balance < idData.price) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Calculate fee
    const fee = idData.type === 'Verified' ? VERIFIED_FEE : NON_VERIFIED_FEE;
    const sellerAmount = idData.price - fee;
    
    // Start transaction
    const batch = db.batch();
    
    // Deduct from buyer
    const buyerRef = db.collection('users').doc(buyerId);
    batch.update(buyerRef, {
      balance: admin.firestore.FieldValue.increment(-idData.price),
      totalBuy: admin.firestore.FieldValue.increment(1)
    });
    
    // Add to seller
    const sellerRef = db.collection('users').doc(idData.sellerId);
    batch.update(sellerRef, {
      balance: admin.firestore.FieldValue.increment(sellerAmount),
      totalSell: admin.firestore.FieldValue.increment(1)
    });
    
    // Update ID status
    const idRef = db.collection('ids').doc(idDocId);
    batch.update(idRef, {
      status: 'sold',
      buyerId: buyerId,
      soldAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Create transaction record
    const transactionRef = db.collection('transactions').doc();
    batch.set(transactionRef, {
      id: transactionRef.id,
      idDocId: idDocId,
      idUid: idData.uid,
      buyerId: buyerId,
      sellerId: idData.sellerId,
      amount: idData.price,
      fee: fee,
      sellerAmount: sellerAmount,
      type: idData.type,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await batch.commit();
    
    res.json({ 
      success: true, 
      message: 'ID purchased successfully',
      idDetails: {
        uid: idData.uid,
        password: idData.password,
        email2fa: idData.email2fa || '',
        twoFactor: idData.twoFactor || ''
      }
    });
  } catch (error) {
    console.error('Buy ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== USER DASHBOARD ====================

// Get user balance
app.get('/api/user-balance', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    const userData = await getUserData(req.user.uid);
    res.json({ balance: userData?.balance || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get My IDs (purchased)
app.get('/api/my-ids', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const snapshot = await db.collection('ids')
      .where('buyerId', '==', req.user.uid)
      .where('status', '==', 'sold')
      .get();
    
    const ids = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      ids.push({
        id: doc.id,
        uid: data.uid,
        password: data.password,
        email2fa: data.email2fa || '',
        twoFactor: data.twoFactor || '',
        sellerUsername: data.sellerUsername,
        price: data.price,
        type: data.type,
        boughtAt: data.soldAt
      });
    });
    
    res.json({ ids });
  } catch (error) {
    console.error('Error fetching my IDs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get My Listings
app.get('/api/my-listings', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const snapshot = await db.collection('ids')
      .where('sellerId', '==', req.user.uid)
      .get();
    
    const listings = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      listings.push({
        id: doc.id,
        uid: data.uid,
        password: data.password,
        email2fa: data.email2fa || '',
        twoFactor: data.twoFactor || '',
        price: data.price,
        type: data.type,
        status: data.status,
        createdAt: data.addedAt
      });
    });
    
    res.json({ listings });
  } catch (error) {
    console.error('Error fetching my listings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add Single Listing
app.post('/api/add-listing', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { uid, password, email2fa, twoFactor, price, type } = req.body;
    
    if (!uid || !password || !price || !type) {
      return res.status(400).json({ error: 'UID, Password, Price and Type are required' });
    }
    
    const userData = await getUserData(req.user.uid);
    if (userData.isBlocked) {
      return res.status(403).json({ error: 'Your account is blocked' });
    }
    
    const newIdRef = db.collection('ids').doc();
    await newIdRef.set({
      uid: uid,
      password: password,
      email2fa: email2fa || '',
      twoFactor: twoFactor || '',
      price: parseInt(price),
      type: type,
      sellerId: req.user.uid,
      sellerUsername: userData.username,
      sellerWhatsapp: userData.whatsapp,
      status: 'available',
      addedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'ID listed successfully', id: newIdRef.id });
  } catch (error) {
    console.error('Error adding listing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk Upload
app.post('/api/bulk-listing', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { ids } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Invalid bulk data' });
    }
    
    const userData = await getUserData(req.user.uid);
    if (userData.isBlocked) {
      return res.status(403).json({ error: 'Your account is blocked' });
    }
    
    const batch = db.batch();
    let count = 0;
    
    for (const idData of ids) {
      if (!idData.uid || !idData.password || !idData.price || !idData.type) continue;
      
      const newIdRef = db.collection('ids').doc();
      batch.set(newIdRef, {
        uid: idData.uid,
        password: idData.password,
        email2fa: idData.email2fa || '',
        twoFactor: idData.twoFactor || '',
        price: parseInt(idData.price),
        type: idData.type,
        sellerId: req.user.uid,
        sellerUsername: userData.username,
        sellerWhatsapp: userData.whatsapp,
        status: 'available',
        addedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      count++;
    }
    
    await batch.commit();
    res.json({ success: true, message: `${count} IDs listed successfully` });
  } catch (error) {
    console.error('Error bulk listing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit Listing
app.put('/api/edit-listing/:id', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { id } = req.params;
    const updates = req.body;
    
    const idDoc = await db.collection('ids').doc(id).get();
    if (!idDoc.exists) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    const idData = idDoc.data();
    if (idData.sellerId !== req.user.uid) {
      return res.status(403).json({ error: 'Not your listing' });
    }
    
    if (idData.status !== 'available') {
      return res.status(400).json({ error: 'Cannot edit sold ID' });
    }
    
    await db.collection('ids').doc(id).update(updates);
    res.json({ success: true, message: 'Listing updated successfully' });
  } catch (error) {
    console.error('Error editing listing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Listing
app.delete('/api/delete-listing/:id', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { id } = req.params;
    
    const idDoc = await db.collection('ids').doc(id).get();
    if (!idDoc.exists) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    const idData = idDoc.data();
    if (idData.sellerId !== req.user.uid) {
      return res.status(403).json({ error: 'Not your listing' });
    }
    
    await db.collection('ids').doc(id).delete();
    res.json({ success: true, message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Withdrawal Request
app.post('/api/withdrawal-request', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const { amount, method, accountName, accountNumber } = req.body;
    
    const userData = await getUserData(req.user.uid);
    if (userData.isBlocked) {
      return res.status(403).json({ error: 'Your account is blocked' });
    }
    
    if (amount > userData.balance) {
      return res.status(400).json({ error: 'Amount exceeds available balance' });
    }
    
    if (amount < 100) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is 100 PKR' });
    }
    
    const withdrawalRef = db.collection('withdrawals').doc();
    await withdrawalRef.set({
      id: withdrawalRef.id,
      userId: req.user.uid,
      username: userData.username,
      amount: amount,
      method: method,
      accountName: method !== 'crypto' ? accountName : '',
      accountNumber: method !== 'crypto' ? accountNumber : '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (error) {
    console.error('Error creating withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Withdrawal Status
app.get('/api/withdrawal-status', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const snapshot = await db.collection('withdrawals')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();
    
    const withdrawals = [];
    snapshot.forEach(doc => {
      withdrawals.push(doc.data());
    });
    
    res.json({ withdrawals });
  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== ADMIN PANEL ====================

// Admin Dashboard Stats
app.get('/api/admin/dashboard', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const usersSnapshot = await db.collection('users').get();
    const totalUsers = usersSnapshot.size;
    
    const idsSnapshot = await db.collection('ids').get();
    let totalSold = 0;
    let totalAvailable = 0;
    let totalEarning = 0;
    
    idsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.status === 'sold') {
        totalSold++;
        totalEarning += data.price;
      } else if (data.status === 'available') {
        totalAvailable++;
      }
    });
    
    res.json({
      totalUsers,
      totalSold,
      totalAvailable,
      totalEarning
    });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get All IDs
app.get('/api/admin/all-ids', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { page = 1, limit = 20, search = '' } = req.query;
    
    let query = db.collection('ids');
    if (search) {
      query = query.where('uid', '==', search);
    }
    
    const snapshot = await query.get();
    let ids = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      ids.push({
        id: doc.id,
        uid: data.uid,
        sellerEmail: data.sellerId,
        sellerWhatsapp: data.sellerWhatsapp,
        type: data.type,
        status: data.status,
        price: data.price
      });
    });
    
    const start = (page - 1) * limit;
    const paginatedIds = ids.slice(start, start + limit);
    
    res.json({ ids: paginatedIds, total: ids.length });
  } catch (error) {
    console.error('Error fetching all IDs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get ID Details
app.get('/api/admin/id-detail/:uid', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { uid } = req.params;
    const snapshot = await db.collection('ids').where('uid', '==', uid).get();
    
    if (snapshot.empty) {
      return res.status(404).json({ error: 'ID not found' });
    }
    
    const idData = snapshot.docs[0].data();
    res.json({
      uid: idData.uid,
      password: idData.password,
      email2fa: idData.email2fa || '',
      twoFactor: idData.twoFactor || '',
      price: idData.price,
      type: idData.type,
      status: idData.status,
      sellerId: idData.sellerId,
      sellerWhatsapp: idData.sellerWhatsapp
    });
  } catch (error) {
    console.error('Error fetching ID detail:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get All Users
app.get('/api/admin/all-users', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { page = 1, limit = 20, search = '' } = req.query;
    
    let users = [];
    
    if (search) {
      const emailQuery = await db.collection('users').where('email', '==', search).get();
      const usernameQuery = await db.collection('users').where('username', '==', search).get();
      const whatsappQuery = await db.collection('users').where('whatsapp', '==', search).get();
      
      const combined = new Map();
      emailQuery.forEach(doc => combined.set(doc.id, doc.data()));
      usernameQuery.forEach(doc => combined.set(doc.id, doc.data()));
      whatsappQuery.forEach(doc => combined.set(doc.id, doc.data()));
      
      combined.forEach((data, id) => {
        users.push({ id, ...data });
      });
    } else {
      const snapshot = await db.collection('users').get();
      snapshot.forEach(doc => {
        users.push({ id: doc.id, ...doc.data() });
      });
    }
    
    const start = (page - 1) * limit;
    const paginatedUsers = users.slice(start, start + limit);
    
    res.json({ users: paginatedUsers, total: users.length });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update User
app.put('/api/admin/update-user', verifyToken, async (req, res) => {
  try {
    if (!db || !auth) throw new Error('Firebase not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { userId, balance, isBlocked, deleteUser } = req.body;
    
    if (deleteUser) {
      await auth.deleteUser(userId);
      await db.collection('users').doc(userId).delete();
      return res.json({ success: true, message: 'User deleted successfully' });
    }
    
    const updates = {};
    if (balance !== undefined) updates.balance = balance;
    if (isBlocked !== undefined) updates.isBlocked = isBlocked;
    
    await db.collection('users').doc(userId).update(updates);
    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get User Stats
app.get('/api/admin/user-stats/:userId', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { userId } = req.params;
    
    const buySnapshot = await db.collection('ids').where('buyerId', '==', userId).get();
    const sellSnapshot = await db.collection('ids').where('sellerId', '==', userId).get();
    
    res.json({
      totalBuy: buySnapshot.size,
      totalSell: sellSnapshot.size
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get Withdrawal Requests
app.get('/api/admin/withdrawal-requests', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { status = 'all', search = '' } = req.query;
    
    let query = db.collection('withdrawals');
    if (status !== 'all') {
      query = query.where('status', '==', status);
    }
    
    const snapshot = await query.orderBy('createdAt', 'desc').get();
    let withdrawals = [];
    
    snapshot.forEach(doc => {
      withdrawals.push(doc.data());
    });
    
    if (search) {
      withdrawals = withdrawals.filter(w => 
        w.username.includes(search) || w.accountNumber.includes(search)
      );
    }
    
    res.json({ withdrawals });
  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update Withdrawal Status
app.put('/api/admin/update-withdrawal', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { withdrawalId, status, reason } = req.body;
    
    const updates = { status };
    if (reason) updates.reason = reason;
    
    await db.collection('withdrawals').doc(withdrawalId).update(updates);
    
    if (status === 'completed') {
      const withdrawal = await db.collection('withdrawals').doc(withdrawalId).get();
      const withdrawalData = withdrawal.data();
      await updateUserBalance(withdrawalData.userId, withdrawalData.amount, 'subtract');
    }
    
    res.json({ success: true, message: 'Withdrawal status updated' });
  } catch (error) {
    console.error('Error updating withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Add Balance
app.post('/api/admin/add-balance', verifyToken, async (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized');
    
    const userData = await getUserData(req.user.uid);
    if (!userData?.isAdmin && !ADMIN_EMAILS.includes(req.user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { userId, amount } = req.body;
    await updateUserBalance(userId, amount, 'add');
    
    res.json({ success: true, message: 'Balance added successfully' });
  } catch (error) {
    console.error('Error adding balance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export for Vercel
module.exports = app;
