const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const USERS_FILE = 'users.json';
const PROFILES_FILE = 'profiles.json';
const CHATS_FILE = 'chats.json';
const MESSAGES_FILE = 'messages.json';
const GROUPS_FILE = 'groups.json';

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '');
if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, '');
if (!fs.existsSync(CHATS_FILE)) fs.writeFileSync(CHATS_FILE, JSON.stringify({}));
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify({}));

const onlineUsers = new Map();
const userSockets = new Map();

function readJsonLines(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').filter(line => line.trim()).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
}

function writeJsonLines(filePath, items) {
    fs.writeFileSync(filePath, items.map(i => JSON.stringify(i)).join('\n') + '\n');
}

function getUsers() { return readJsonLines(USERS_FILE); }
function saveUsers(users) { writeJsonLines(USERS_FILE, users); }

function getProfiles() {
    const profiles = {};
    readJsonLines(PROFILES_FILE).forEach(e => {
        const uid = Object.keys(e)[0];
        if (uid) profiles[uid] = e[uid];
    });
    return profiles;
}

function saveProfiles(profiles) {
    const entries = Object.entries(profiles).map(([uid, data]) => ({ [uid]: data }));
    writeJsonLines(PROFILES_FILE, entries);
}

function getChats() {
    try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '{}'); }
    catch { return {}; }
}

function saveChats(chats) {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

function getMessages() {
    try { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8') || '{}'); }
    catch { return {}; }
}

function saveMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function getGroups() {
    try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8') || '{}'); }
    catch { return {}; }
}

function saveGroups(groups) {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
}

function authenticate(req, res, next) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ success: false, message: 'Нет токена' });
    const users = getUsers();
    const user = users.find(u => u.token === token);
    if (!user) return res.status(401).json({ success: false, message: 'Неверный токен' });
    req.user = user;
    next();
}

io.on('connection', socket => {
    console.log('WebSocket connected:', socket.id);
    
    socket.on('authenticate', token => {
        const users = getUsers();
        const user = users.find(u => u.token === token);
        if (user) {
            onlineUsers.set(user.id, socket.id);
            userSockets.set(socket.id, user.id);
            socket.userId = user.id;
            io.emit('user-status', { userId: user.id, online: true });
            console.log('User online:', user.username);
        }
    });
    
    socket.on('typing', ({ chatId }) => {
        const uid = userSockets.get(socket.id);
        if (!uid) return;
        const targetSocket = onlineUsers.get(chatId);
        if (targetSocket) {
            io.to(targetSocket).emit('user-typing', { userId: uid, chatId: uid });
        }
    });
    
    socket.on('stop-typing', ({ chatId }) => {
        const uid = userSockets.get(socket.id);
        if (!uid) return;
        const targetSocket = onlineUsers.get(chatId);
        if (targetSocket) {
            io.to(targetSocket).emit('user-stop-typing', { userId: uid, chatId: uid });
        }
    });
    
    socket.on('disconnect', () => {
        const uid = userSockets.get(socket.id);
        if (uid) {
            onlineUsers.delete(uid);
            userSockets.delete(socket.id);
            io.emit('user-status', { userId: uid, online: false });
            console.log('User offline:', uid);
        }
    });
});

app.post('/register', (req, res) => {
    const { firstName, lastName, username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, message: 'Нужен username и пароль' });
    }
    const users = getUsers();
    if (users.some(u => u.username === username)) {
        return res.json({ success: false, message: 'Уже есть такой пользователь' });
    }
    const newUser = {
        id: crypto.randomUUID(),
        firstName: firstName || '',
        lastName: lastName || '',
        username,
        password,
        token: crypto.randomUUID()
    };
    users.push(newUser);
    saveUsers(users);
    const profiles = getProfiles();
    profiles[newUser.id] = {
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        username,
        avatar: null,
        bio: ''
    };
    saveProfiles(profiles);
    res.json({ success: true });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.json({ success: false, message: 'Неверный логин или пароль' });
    }
    user.token = crypto.randomUUID();
    saveUsers(users);
    res.json({ success: true, token: user.token, id: user.id });
});

app.get('/profile', authenticate, (req, res) => {
    const profiles = getProfiles();
    res.json(profiles[req.user.id] || {});
});

app.get('/profile/:id', authenticate, (req, res) => {
    const profiles = getProfiles();
    const profile = profiles[req.params.id] || {};
    const online = onlineUsers.has(req.params.id);
    res.json({ ...profile, online });
});

app.post('/updateProfile', authenticate, (req, res) => {
    const { firstName, lastName, username, avatar, bio } = req.body;
    let users = getUsers();
    const idx = users.findIndex(u => u.id === req.user.id);
    if (idx === -1) return res.status(404).json({ success: false });
    users[idx] = { ...users[idx], firstName: firstName || users[idx].firstName, lastName: lastName || users[idx].lastName, username: username || users[idx].username };
    saveUsers(users);
    let profiles = getProfiles();
    profiles[req.user.id] = {
        firstName: firstName || profiles[req.user.id]?.firstName || '',
        lastName: lastName || profiles[req.user.id]?.lastName || '',
        username: username || profiles[req.user.id]?.username || '',
        avatar: avatar !== undefined ? avatar : profiles[req.user.id]?.avatar || null,
        bio: bio !== undefined ? bio : profiles[req.user.id]?.bio || ''
    };
    saveProfiles(profiles);
    res.json({ success: true });
});

app.get('/search', authenticate, (req, res) => {
    const { username } = req.query;
    if (!username) return res.json(null);
    const users = getUsers();
    const found = users.find(u => u.username === username && u.id !== req.user.id);
    if (!found) return res.json(null);
    const profiles = getProfiles();
    const profile = profiles[found.id] || {};
    res.json({ id: found.id, username: found.username, firstName: found.firstName, lastName: found.lastName, avatar: profile.avatar });
});

app.post('/addChat', authenticate, (req, res) => {
    const { username } = req.body;
    const users = getUsers();
    const target = users.find(u => u.username === username);
    if (!target) return res.status(404).json({ success: false, message: 'Не найден' });
    
    // Check if target blocked current user
    const profiles = getProfiles();
    const targetProfile = profiles[target.id] || {};
    const blockedUsers = targetProfile.blockedUsers || [];
    
    if (blockedUsers.includes(req.user.id)) {
        return res.json({ success: false, blocked: true, message: 'Вы заблокированы' });
    }
    
    let chats = getChats();
    if (!chats[req.user.id]) chats[req.user.id] = [];
    if (!chats[req.user.id].some(c => c.id === target.id)) {
        const p = getProfiles()[target.id] || {};
        chats[req.user.id].push({ id: target.id, username: target.username, firstName: target.firstName, lastName: target.lastName, avatar: p.avatar, isGroup: false });
    }
    if (!chats[target.id]) chats[target.id] = [];
    if (!chats[target.id].some(c => c.id === req.user.id)) {
        const p = getProfiles()[req.user.id] || {};
        chats[target.id].push({ id: req.user.id, username: req.user.username, firstName: req.user.firstName, lastName: req.user.lastName, avatar: p.avatar, isGroup: false });
    }
    saveChats(chats);
    let messages = getMessages();
    const chatKey = [req.user.id, target.id].sort().join('-');
    if (!messages[chatKey]) messages[chatKey] = [];
    saveMessages(messages);
    res.json({ success: true });
});

app.get('/chats', authenticate, (req, res) => {
    const chats = getChats();
    const userChats = (chats[req.user.id] || []).map(chat => ({ ...chat, online: onlineUsers.has(chat.id) }));
    res.json(userChats);
});

app.post('/sendMessage', authenticate, (req, res) => {
    const { chatId, text, image, voice, voiceDuration, replyTo, isSticker } = req.body;
    if (!chatId || (!text?.trim() && !image && !voice)) return res.status(400).json({ success: false });
    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    if (!messages[chatKey]) messages[chatKey] = [];
    const newMessage = { 
        id: crypto.randomUUID(), 
        sender: req.user.id, 
        text: text?.trim() || '', 
        image: image || null, 
        voice: voice || null,
        voiceDuration: voiceDuration || null,
        isSticker: isSticker || false,
        time: new Date().toISOString(), 
        reactions: [], 
        edited: false, 
        deleted: false, 
        replyTo: replyTo || null,
        delivered: true,
        read: false
    };
    messages[chatKey].push(newMessage);
    saveMessages(messages);
    
    // Send to target user immediately
    const targetSocket = onlineUsers.get(chatId);
    if (targetSocket) {
        io.to(targetSocket).emit('new-message', { chatId: req.user.id, message: { ...newMessage, sent: false } });
    }
    
    // Send back to sender for instant update
    const senderSocket = onlineUsers.get(req.user.id);
    if (senderSocket) {
        io.to(senderSocket).emit('new-message', { chatId: chatId, message: { ...newMessage, sent: true } });
    }
    
    res.json({ success: true, message: newMessage });
});

app.get('/messages/:chatId', authenticate, (req, res) => {
    const targetId = req.params.chatId;
    const chatKey = [req.user.id, targetId].sort().join('-');
    const messages = getMessages()[chatKey] || [];
    const profiles = getProfiles();
    const result = messages.map(msg => {
        let data = { ...msg, sent: msg.sender === req.user.id };
        if (msg.replyTo) {
            const replyMsg = messages.find(m => m.id === msg.replyTo.id);
            if (replyMsg) {
                const sender = profiles[replyMsg.sender];
                data.replyTo = { ...msg.replyTo, senderName: sender ? `${sender.firstName} ${sender.lastName}`.trim() : 'Пользователь' };
            }
        }
        return data;
    });
    res.json(result);
});

app.post('/react', authenticate, (req, res) => {
    const { messageId, chatId, emoji } = req.body;
    if (!messageId || !chatId || !emoji) return res.status(400).json({ success: false });
    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];
    const idx = chatMessages.findIndex(m => m.id === messageId);
    if (idx === -1) return res.status(404).json({ success: false });
    let msg = chatMessages[idx];
    if (!msg.reactions) msg.reactions = [];
    let reaction = msg.reactions.find(r => r.emoji === emoji);
    if (!reaction) {
        reaction = { emoji, users: [] };
        msg.reactions.push(reaction);
    }
    const uid = req.user.id;
    if (reaction.users.includes(uid)) {
        reaction.users = reaction.users.filter(id => id !== uid);
        if (!reaction.users.length) msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
    } else {
        reaction.users.push(uid);
    }
    chatMessages[idx] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);
    const targetSocket = onlineUsers.get(chatId);
    if (targetSocket) {
        io.to(targetSocket).emit('message-updated', { chatId: req.user.id, messageId, reactions: msg.reactions });
    }
    res.json({ success: true, reactions: msg.reactions });
});

app.patch('/message/:messageId', authenticate, (req, res) => {
    const { chatId, text } = req.body;
    const messageId = req.params.messageId;
    if (!chatId || !text?.trim()) return res.status(400).json({ success: false });
    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];
    const idx = chatMessages.findIndex(m => m.id === messageId);
    if (idx === -1) return res.status(404).json({ success: false });
    const msg = chatMessages[idx];
    if (msg.sender !== req.user.id) return res.status(403).json({ success: false });
    const sentTime = new Date(msg.time).getTime();
    if (Date.now() - sentTime > 30 * 60 * 1000) return res.status(403).json({ success: false, message: 'Слишком поздно' });
    msg.text = text.trim();
    msg.edited = true;
    msg.editTime = new Date().toISOString();
    chatMessages[idx] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);
    const targetSocket = onlineUsers.get(chatId);
    if (targetSocket) {
        io.to(targetSocket).emit('message-updated', { chatId: req.user.id, messageId, text: msg.text, edited: true });
    }
    res.json({ success: true, message: msg });
});

app.delete('/message/:messageId', authenticate, (req, res) => {
    const { chatId } = req.body;
    const messageId = req.params.messageId;
    if (!chatId) return res.status(400).json({ success: false });
    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];
    const idx = chatMessages.findIndex(m => m.id === messageId);
    if (idx === -1) return res.status(404).json({ success: false });
    const msg = chatMessages[idx];
    if (msg.sender !== req.user.id) return res.status(403).json({ success: false });
    msg.deleted = true;
    msg.text = '';
    chatMessages[idx] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);
    const targetSocket = onlineUsers.get(chatId);
    if (targetSocket) {
        io.to(targetSocket).emit('message-updated', { chatId: req.user.id, messageId, deleted: true });
    }
    res.json({ success: true });
});

app.post('/createGroup', authenticate, (req, res) => {
    const { name, description, avatar, members } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Нужно название' });
    const gid = crypto.randomUUID();
    const groups = getGroups();
    groups[gid] = { id: gid, name, description: description || '', avatar: avatar || null, creator: req.user.id, members: [req.user.id, ...(members || [])], createdAt: new Date().toISOString() };
    saveGroups(groups);
    let chats = getChats();
    groups[gid].members.forEach(mid => {
        if (!chats[mid]) chats[mid] = [];
        if (!chats[mid].some(c => c.id === gid)) {
            chats[mid].push({ id: gid, name, avatar: avatar || null, isGroup: true });
        }
    });
    saveChats(chats);
    let messages = getMessages();
    messages[`group-${gid}`] = [];
    saveMessages(messages);
    res.json({ success: true, groupId: gid });
});

app.post('/group/:groupId/addMember', authenticate, (req, res) => {
    const { groupId } = req.params;
    const { userId } = req.body;
    const groups = getGroups();
    const group = groups[groupId];
    if (!group) return res.status(404).json({ success: false });
    if (group.creator !== req.user.id) return res.status(403).json({ success: false });
    if (!group.members.includes(userId)) {
        group.members.push(userId);
        groups[groupId] = group;
        saveGroups(groups);
        let chats = getChats();
        if (!chats[userId]) chats[userId] = [];
        if (!chats[userId].some(c => c.id === groupId)) {
            chats[userId].push({ id: groupId, name: group.name, avatar: group.avatar, isGroup: true });
        }
        saveChats(chats);
    }
    res.json({ success: true });
});

app.delete('/group/:groupId/removeMember', authenticate, (req, res) => {
    const { groupId } = req.params;
    const { userId } = req.body;
    const groups = getGroups();
    const group = groups[groupId];
    if (!group) return res.status(404).json({ success: false });
    if (group.creator !== req.user.id) return res.status(403).json({ success: false });
    group.members = group.members.filter(id => id !== userId);
    groups[groupId] = group;
    saveGroups(groups);
    let chats = getChats();
    if (chats[userId]) {
        chats[userId] = chats[userId].filter(c => c.id !== groupId);
        saveChats(chats);
    }
    res.json({ success: true });
});

app.post('/group/:groupId/leave', authenticate, (req, res) => {
    const { groupId } = req.params;
    const groups = getGroups();
    const group = groups[groupId];
    if (!group) return res.status(404).json({ success: false });
    
    group.members = group.members.filter(id => id !== req.user.id);
    groups[groupId] = group;
    saveGroups(groups);
    
    let chats = getChats();
    if (chats[req.user.id]) {
        chats[req.user.id] = chats[req.user.id].filter(c => c.id !== groupId);
        saveChats(chats);
    }
    
    const users = getUsers();
    const user = users.find(u => u.id === req.user.id);
    
    res.json({ success: true, username: user?.username || 'Пользователь' });
});

app.patch('/group/:groupId/update', authenticate, (req, res) => {
    const { groupId } = req.params;
    const { name, description, avatar } = req.body;
    const groups = getGroups();
    const group = groups[groupId];
    if (!group) return res.status(404).json({ success: false });
    if (group.creator !== req.user.id) return res.status(403).json({ success: false });
    
    if (name) group.name = name;
    if (description !== undefined) group.description = description;
    if (avatar !== undefined) group.avatar = avatar;
    
    groups[groupId] = group;
    saveGroups(groups);
    
    let chats = getChats();
    group.members.forEach(mid => {
        if (chats[mid]) {
            const chatIndex = chats[mid].findIndex(c => c.id === groupId);
            if (chatIndex !== -1) {
                chats[mid][chatIndex] = { id: groupId, name: group.name, avatar: group.avatar, isGroup: true };
            }
        }
    });
    saveChats(chats);
    
    res.json({ success: true });
});

app.get('/group/:groupId', authenticate, (req, res) => {
    const { groupId } = req.params;
    const groups = getGroups();
    const group = groups[groupId];
    if (!group) return res.status(404).json({ success: false });
    const users = getUsers();
    const profiles = getProfiles();
    const members = group.members.map(mid => {
        const user = users.find(u => u.id === mid);
        const profile = profiles[mid];
        return { id: mid, username: user?.username, firstName: profile?.firstName, lastName: profile?.lastName, avatar: profile?.avatar };
    }).filter(m => m.username);
    res.json({ ...group, members });
});

app.get('/group/:groupId/messages', authenticate, (req, res) => {
    const { groupId } = req.params;
    const messages = getMessages()[`group-${groupId}`] || [];
    const profiles = getProfiles();
    const result = messages.map(msg => {
        let data = { ...msg, sent: msg.sender === req.user.id };
        if (msg.replyTo) {
            const replyMsg = messages.find(m => m.id === msg.replyTo.id);
            if (replyMsg) {
                const sender = profiles[replyMsg.sender];
                data.replyTo = { ...msg.replyTo, senderName: sender ? `${sender.firstName} ${sender.lastName}`.trim() : 'Пользователь' };
            }
        }
        return data;
    });
    res.json(result);
});

app.post('/group/:groupId/sendMessage', authenticate, (req, res) => {
    const { groupId } = req.params;
    const { chatId, text, image, voice, voiceDuration, replyTo, isSticker } = req.body;
    if (!text?.trim() && !image && !voice) return res.status(400).json({ success: false });
    let messages = getMessages();
    const key = `group-${groupId}`;
    if (!messages[key]) messages[key] = [];
    const newMessage = { 
        id: crypto.randomUUID(), 
        sender: req.user.id, 
        text: text?.trim() || '', 
        image: image || null, 
        voice: voice || null,
        voiceDuration: voiceDuration || null,
        isSticker: isSticker || false,
        time: new Date().toISOString(), 
        reactions: [], 
        edited: false, 
        deleted: false, 
        replyTo: replyTo || null 
    };
    messages[key].push(newMessage);
    saveMessages(messages);
    const groups = getGroups();
    const group = groups[groupId];
    if (group) {
        group.members.forEach(mid => {
            const socket = onlineUsers.get(mid);
            if (socket) {
                io.to(socket).emit('new-message', { chatId: groupId, message: { ...newMessage, sent: mid === req.user.id } });
            }
        });
    }
    res.json({ success: true, message: newMessage });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/login.html'));

const PORT = 3000;
server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));

// Mark messages as read
app.post('/mark-read', authenticate, (req, res) => {
    const { chatId } = req.body;
    const messages = getMessages();
    const chatKey = [req.user.id, chatId].sort().join('-');
    
    if (messages[chatKey]) {
        let updated = false;
        messages[chatKey].forEach(msg => {
            if (msg.sender === chatId && !msg.read) {
                msg.read = true;
                updated = true;
            }
        });
        
        if (updated) {
            saveMessages(messages);
            
            // Notify sender
            const targetSocket = onlineUsers.get(chatId);
            if (targetSocket) {
                io.to(targetSocket).emit('message-read', { chatId: req.user.id });
            }
        }
    }
    res.json({ success: true });
});

// Add sticker
app.post('/add-sticker', authenticate, (req, res) => {
    const { sticker } = req.body;
    
    let stickers = {};
    try {
        stickers = JSON.parse(fs.readFileSync('stickers.json', 'utf8'));
    } catch (err) {
        stickers = {};
    }
    
    if (!stickers[req.user.id]) stickers[req.user.id] = [];
    stickers[req.user.id].push(sticker);
    
    fs.writeFileSync('stickers.json', JSON.stringify(stickers, null, 2));
    res.json({ success: true });
});

// Get stickers
app.get('/get-stickers', authenticate, (req, res) => {
    let stickers = {};
    try {
        stickers = JSON.parse(fs.readFileSync('stickers.json', 'utf8'));
    } catch (err) {
        stickers = {};
    }
    
    res.json(stickers[req.user.id] || []);
});

